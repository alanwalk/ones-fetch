#!/usr/bin/env node

import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const HELP_TEXT = `
ONES subtask crawler

Usage:
  node src/ones-subtasks-cli.mjs [command] [options]

Commands:
  login              Authenticate and save credentials
  config [key=val]   View or set configuration values

Crawl usage:
  node src/ones-subtasks-cli.mjs --task-id <id>[,<id>...] [options]

Required (or via config/env):
  --base-url <url>     ONES base URL, e.g. https://ones.example.com
  --team-id <id>       Team UUID (visible in any API URL after /team/)
  --task-id <id>       Root task UUID(s) to crawl (comma-separated)

Optional credentials (overrides saved credentials):
  --username <user>    LDAP username
  --password <pass>    LDAP password

Optional:
  --max-depth <n>      Max recursion depth, default: 10
  --format <json|csv>  Output format, default: json
  --output <path>      Write to file instead of stdout
  --headless           Run browser headless (default)
  --headed             Show browser window (for debugging login)
  --verbose            Print progress to stderr
  --help               Show this help

Environment variables:
  ONES_BASE_URL, ONES_TEAM_ID, ONES_TASK_ID, ONES_USERNAME, ONES_PASSWORD
`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (["help", "verbose", "headless", "headed"].includes(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    i++;
  }
  return args;
}

async function login(page, { baseUrl, username, password, verbose }) {
  const loginUrl = `${baseUrl}/project/#/3rd_party_connect/ldap/login?path=/auth/third_login&ones_from=${encodeURIComponent(baseUrl + "/project/#/workspace")}`;
  if (verbose) process.stderr.write(`Navigating to login page...\n`);
  await page.goto(loginUrl, { waitUntil: "networkidle", timeout: 60000 });

  await page.waitForSelector('input[name="loginName"], input[name="username"], input[type="text"]', { timeout: 15000 });
  const userInput = page.locator('input[name="loginName"], input[name="username"], input[type="text"]').first();
  const passInput = page.locator('input[name="password"], input[type="password"]').first();
  await userInput.fill(username);
  await passInput.fill(password);

  let authToken = null;
  let userId = null;
  page.once("response", async (res) => {
    if (res.url().includes("/sso/login") || res.url().includes("/auth/login")) {
      try {
        const h = res.headers();
        authToken = h["ones-auth-token"] ?? null;
        userId = h["ones-user-id"] ?? null;
        if (!authToken) {
          const body = await res.json();
          authToken = body?.user?.token ?? null;
          userId = body?.user?.uuid ?? null;
        }
      } catch { /* ignore */ }
    }
  });

  await passInput.press("Enter");
  await page.waitForFunction(
    () => !location.href.includes("ldap/login") && !location.href.includes("3rd_party_connect"),
    { timeout: 30000 }
  );
  await page.waitForLoadState("networkidle", { timeout: 30000 });
  if (verbose) process.stderr.write(`Logged in. Token: ${authToken ? "ok" : "not captured"}\n`);
  return { authToken, userId };
}
export async function resolveTaskNumber(baseUrl, teamId, taskNumber, authToken, userId) {
  const url = `${baseUrl}/project/api/project/team/${teamId}/items/graphql?t=resolve-by-number`;
  const body = JSON.stringify({
    query: `{ tasks(filter: { number_equal: ${taskNumber} }) { uuid number } }`,
    variables: {},
  });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "accept": "application/json, text/plain, */*",
      "content-type": "application/json;charset=UTF-8",
      "ones-auth-token": authToken,
      "ones-user-id": userId,
      "referer": `${baseUrl}/project/`,
    },
    body,
  });
  if (res.status === 401) {
    throw new Error("TOKEN_EXPIRED");
  }
  if (!res.ok) throw new Error(`GraphQL resolve → ${res.status}`);
  const json = await res.json();
  // Handle GraphQL-level errors (syntax error, type mismatch, etc.)
  if (json?.errors?.length > 0) {
    const firstError = json.errors[0];
    const msg = firstError.message ?? String(firstError);
    throw new Error(`GraphQL query failed for task number "${taskNumber}": ${msg}`);
  }
  const tasks = json?.data?.tasks ?? [];
  if (tasks.length === 0) throw new Error(`No task found with number ${taskNumber}`);
  return tasks[0].uuid;
}

export async function fetchTaskInfo(baseUrl, teamId, taskUuid, authToken, userId) {
  const url = `${baseUrl}/project/api/project/team/${teamId}/task/${taskUuid}/info`;
  const res = await fetch(url, {
    headers: {
      "accept": "application/json, text/plain, */*",
      "ones-auth-token": authToken,
      "ones-user-id": userId,
      "referer": `${baseUrl}/project/`,
    },
  });
  if (res.status === 401) {
    throw new Error("TOKEN_EXPIRED");
  }
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

function chunk(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}

function getImportantFieldValue(task, fieldName) {
  const match = (task.importantField ?? []).find((field) => field.name === fieldName);
  return match?.value ?? null;
}

export async function enrichTasks(baseUrl, teamId, tasks, authToken, userId) {
  const details = new Map();

  for (const uuidChunk of chunk([...new Set(tasks.map((task) => task.uuid))], 200)) {
      const res = await fetch(`${baseUrl}/project/api/project/team/${teamId}/items/graphql?t=task-enrich`, {
        method: "POST",
        headers: {
          accept: "application/json, text/plain, */*",
          "content-type": "application/json;charset=UTF-8",
          "ones-auth-token": authToken,
          "ones-user-id": userId,
          referer: `${baseUrl}/project/`,
        },
        body: JSON.stringify({
          query: `query TaskEnrich($uuids: [String!]) {
  tasks(filter: { uuid_in: $uuids }) {
    uuid
    number
    name
    deadline(unit: ONESDATE)
    status {
      uuid
      name
      category
    }
    parent {
      uuid
    }
    project {
      uuid
    }
    importantField {
      name
      value
      fieldUUID
    }
  }
}`,
          variables: {
            uuids: uuidChunk,
          },
        }),
      });

      if (res.status === 401) throw new Error("TOKEN_EXPIRED");
      if (!res.ok) throw new Error(`GraphQL enrich → ${res.status}`);

      const json = await res.json();
      const enrichedTasks = json?.data?.tasks ?? [];
      for (const enriched of enrichedTasks) {
        details.set(enriched.uuid, {
          summary: enriched.name,
          status_uuid: enriched.status?.uuid ?? null,
          status_name: enriched.status?.name ?? null,
          assign_name: getImportantFieldValue(enriched, "负责人"),
          deadline: enriched.deadline ?? null,
          parent_uuid: enriched.parent?.uuid || null,
          project_uuid: enriched.project?.uuid ?? null,
        });
      }
  }

  return tasks.map((task) => {
    const enriched = details.get(task.uuid);
    if (!enriched) return task;
    return {
      ...task,
      summary: enriched.summary ?? task.summary,
      status_uuid: enriched.status_uuid ?? task.status_uuid,
      status_name: enriched.status_name ?? task.status_name,
      assign_name: enriched.assign_name ?? task.assign_name,
      deadline: enriched.deadline ?? task.deadline,
      parent_uuid: enriched.parent_uuid ?? task.parent_uuid,
      project_uuid: enriched.project_uuid ?? task.project_uuid,
    };
  });
}

export function extractTask(data) {
  const status = typeof data.status === "object" && data.status ? data.status : null;
  return {
    uuid: data.uuid,
    number: data.number,
    summary: data.summary ?? data.name,
    status_uuid: data.status_uuid ?? status?.uuid ?? "",
    status_name: status?.name ?? null,
    assign: typeof data.assign === "string" ? data.assign : data.assign?.uuid ?? "",
    assign_name: typeof data.assign === "object" && data.assign ? data.assign.name : null,
    priority: data.priority,
    deadline: typeof data.deadline === "number" ? new Date(data.deadline * 1000).toISOString().slice(0, 10) : data.deadline ?? null,
    parent_uuid: data.parent_uuid || data.parent?.uuid || null,
    project_uuid: data.project_uuid || data.project?.uuid || null,
  };
}

export async function crawlTask(baseUrl, teamId, taskUuid, authToken, userId, depth, maxDepth, seen, verbose) {
  if (depth > maxDepth || seen.has(taskUuid)) return [];
  seen.add(taskUuid);
  if (verbose) process.stderr.write(`  ${"  ".repeat(depth)}Fetching ${taskUuid}...\n`);

  const data = await fetchTaskInfo(baseUrl, teamId, taskUuid, authToken, userId);
  const task = extractTask(data);
  const results = [task];

  const subtasks = data.subtasks ?? data.subTasks ?? [];
  for (const sub of subtasks) {
    const children = await crawlTask(baseUrl, teamId, sub.uuid, authToken, userId, depth + 1, maxDepth, seen, verbose);
    results.push(...children);
  }
  return results;
}

export function toCsv(tasks, includeRootUuid = false) {
  const headers = includeRootUuid
    ? ["root_uuid", "uuid", "number", "summary", "status_name", "assign_name", "priority", "deadline", "parent_uuid"]
    : ["uuid", "number", "summary", "status_name", "assign_name", "priority", "deadline", "parent_uuid"];
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [
    headers.join(","),
    ...tasks.map((t) => headers.map((h) => escape(t[h])).join(",")),
  ].join("\n");
}

async function writeOutput(output, content) {
  if (output) {
    await writeFile(output, content, "utf8");
  } else {
    process.stdout.write(content + "\n");
  }
}
async function main() {
  const argv = process.argv.slice(2);

  // Subcommand routing
  if (argv[0] === "login") {
    const { runLogin } = await import("./auth.mjs");
    const { readConfig } = await import("./config.mjs");
    const cfg = await readConfig();
    const baseUrl = process.env.ONES_BASE_URL ?? cfg["base-url"] ?? "";
    const loginArgs = parseArgs(argv.slice(1));
    await runLogin({
      baseUrl,
      verbose: !!loginArgs["verbose"],
      usernameSelector: loginArgs["login-username-selector"] ?? null,
      passwordSelector: loginArgs["login-password-selector"] ?? null,
    });
    process.exit(0);
  }

  if (argv[0] === "config") {
    const { runConfig } = await import("./config.mjs");
    await runConfig(argv.slice(1));
    process.exit(0);
  }

  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(HELP_TEXT); return; }

  // Resolve baseUrl and teamId via resolveParam
  const { resolveParam } = await import("./config.mjs");
  const baseUrl  = await resolveParam(args["base-url"], "ONES_BASE_URL", "base-url");
  const teamId   = await resolveParam(args["team-id"],  "ONES_TEAM_ID",  "team-id");
  const taskIdRaw = args["task-id"] ?? process.env.ONES_TASK_ID ?? "";
  const maxDepth  = parseInt(args["max-depth"] ?? "10", 10);
  const format    = args["format"]  ?? "json";
  const output    = args["output"]  ?? null;
  const headless  = !args["headed"];
  const verbose   = !!args["verbose"];

  // Credential resolution: load from auth file, CLI args override
  let username = args["username"] ?? process.env.ONES_USERNAME ?? null;
  let password = args["password"] ?? process.env.ONES_PASSWORD ?? null;

  if (!username || !password) {
    try {
      const { loadAuth } = await import("./auth.mjs");
      const saved = await loadAuth();
      if (!username) username = saved.username ?? null;
      if (!password) password = saved.password ?? null;
    } catch {
      process.stderr.write("Run login first: node src/ones-subtasks-cli.mjs login\n");
      process.exitCode = 1;
      return;
    }
  }

  if (!baseUrl || !teamId || !taskIdRaw) {
    process.stderr.write("Error: --base-url, --team-id, and --task-id are required (or set via config/env).\n");
    process.stderr.write("Run with --help for usage.\n");
    process.exitCode = 1;
    return;
  }

  // Parse multi task-id
  const taskIds = taskIdRaw.split(",").map((s) => s.trim()).filter(Boolean);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  let authToken, userId;
  try {
    ({ authToken, userId } = await login(page, { baseUrl, username, password, verbose }));
    if (!authToken) throw new Error("Login succeeded but auth token was not captured");
  } finally {
    await browser.close();
  }

  // Crawl each task-id independently, deduplicate by uuid
  const seen = new Set();
  const allTasks = [];
  const roots = [];

  for (const taskId of taskIds) {
    let rootUuid = taskId;
    if (/^\d+$/.test(taskId)) {
      if (verbose) process.stderr.write(`Resolving task number ${taskId} to UUID...\n`);
      rootUuid = await resolveTaskNumber(baseUrl, teamId, parseInt(taskId, 10), authToken, userId);
      if (verbose) process.stderr.write(`Resolved to UUID: ${rootUuid}\n`);
    }
    roots.push(rootUuid);

    if (verbose) process.stderr.write(`Crawling task ${rootUuid} (team ${teamId})...\n`);
    const tasks = await crawlTask(baseUrl, teamId, rootUuid, authToken, userId, 0, maxDepth, seen, verbose);
    // Tag each task with its root for CSV, then push (seen already deduplicates)
    for (const t of tasks) {
      allTasks.push({ ...t, root_uuid: rootUuid });
    }
    if (verbose) process.stderr.write(`Done with ${taskId}. ${tasks.length} tasks collected.\n`);
  }

  const enrichedTasks = await enrichTasks(baseUrl, teamId, allTasks, authToken, userId).catch(() => allTasks);

  if (verbose) process.stderr.write(`Total: ${enrichedTasks.length} tasks across ${roots.length} root(s).\n`);

  let rendered;
  if (format === "csv") {
    const multiRoot = roots.length > 1;
    rendered = toCsv(enrichedTasks, multiRoot);
  } else {
    const result = roots.length === 1
      ? enrichedTasks.map(({ root_uuid, ...rest }) => rest)
      : { roots, tasks: enrichedTasks.map(({ root_uuid, ...rest }) => ({ root_uuid, ...rest })) };
    rendered = JSON.stringify(result, null, 2);
  }

  await writeOutput(output, rendered);
}

const { fileURLToPath } = await import('node:url');
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    if (err.message === "TOKEN_EXPIRED") {
      process.stderr.write("Token expired. Run: node src/ones-subtasks-cli.mjs login\n");
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
  });
}
