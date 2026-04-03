#!/usr/bin/env node
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { exec } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = process.env.PORT ?? 3000;

function openBrowser(url) {
  const start = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${start} ${url}`);
}

const authFlow = {
  status: 'idle',
  error: null,
  startedAt: 0,
  baseUrl: '',
  teamId: '',
};

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

async function readJsonBody(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_json' }));
    return null;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function resolveRuntimeContext(overrides = {}) {
  const { loadAuth } = await import('./auth.mjs');

  const overrideBaseUrl = normalizeBaseUrl(overrides.baseUrl);
  const envBaseUrl = normalizeBaseUrl(process.env.ONES_BASE_URL);
  const requestedBaseUrl = overrideBaseUrl || envBaseUrl;

  let auth = null;
  try {
    auth = await loadAuth();
  } catch {
    auth = null;
  }

  const authBaseUrl = normalizeBaseUrl(auth?.baseUrl);
  if (requestedBaseUrl && authBaseUrl && requestedBaseUrl !== authBaseUrl) {
    auth = null;
  }

  const baseUrl = requestedBaseUrl || authBaseUrl || '';
  const teamId = overrides.teamId ?? auth?.teamId ?? process.env.ONES_TEAM_ID ?? '';

  return {
    authToken: auth?.authToken ?? null,
    userId: auth?.userId ?? null,
    baseUrl,
    teamId,
  };
}

// ---------------------------------------------------------------------------
// Task crawling logic (inlined from ones-subtasks-cli.mjs)
// ---------------------------------------------------------------------------

async function resolveTaskNumber(baseUrl, teamId, taskNumber, authToken, userId) {
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
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw new Error(`GraphQL resolve → ${res.status}`);
  const json = await res.json();
  if (json?.errors?.length > 0) {
    const msg = json.errors[0].message ?? String(json.errors[0]);
    throw new Error(`GraphQL query failed for task number "${taskNumber}": ${msg}`);
  }
  const tasks = json?.data?.tasks ?? [];
  if (tasks.length === 0) throw new Error(`No task found with number ${taskNumber}`);
  return tasks[0].uuid;
}

async function fetchTaskInfo(baseUrl, teamId, taskUuid, authToken, userId) {
  const url = `${baseUrl}/project/api/project/team/${teamId}/task/${taskUuid}/info`;
  const res = await fetch(url, {
    headers: {
      "accept": "application/json, text/plain, */*",
      "ones-auth-token": authToken,
      "ones-user-id": userId,
      "referer": `${baseUrl}/project/`,
    },
  });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
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

async function enrichTasks(baseUrl, teamId, tasks, authToken, userId) {
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

function extractTask(data) {
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

async function crawlTask(baseUrl, teamId, taskUuid, authToken, userId, depth, maxDepth, seen) {
  if (depth > maxDepth || seen.has(taskUuid)) return [];
  seen.add(taskUuid);

  const data = await fetchTaskInfo(baseUrl, teamId, taskUuid, authToken, userId);
  const task = extractTask(data);
  const results = [task];

  const subtasks = data.subtasks ?? data.subTasks ?? [];
  for (const sub of subtasks) {
    const children = await crawlTask(baseUrl, teamId, sub.uuid, authToken, userId, depth + 1, maxDepth, seen);
    results.push(...children);
  }
  return results;
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

async function handleAuthStatus(_req, res) {
  if (authFlow.status === 'pending') {
    return sendJson(res, 200, {
      status: 'pending',
      error: authFlow.error,
      baseUrl: authFlow.baseUrl,
      teamId: authFlow.teamId,
    });
  }

  const context = await resolveRuntimeContext();
  if (context.authToken && context.userId && context.baseUrl) {
    return sendJson(res, 200, {
      status: 'authenticated',
      baseUrl: context.baseUrl,
      teamId: context.teamId,
    });
  }

  return sendJson(res, 200, {
    status: 'unauthenticated',
    error: authFlow.error,
    baseUrl: context.baseUrl,
    teamId: context.teamId,
  });
}

async function handleAuthLogin(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) return;

  const context = await resolveRuntimeContext({ baseUrl: body.baseUrl, teamId: body.teamId });
  if (!context.baseUrl) {
    return sendJson(res, 400, { error: 'missing_base_url', detail: 'Need ONES base URL to open the login window.' });
  }

  if (authFlow.status === 'pending') {
    return sendJson(res, 200, { status: 'pending', baseUrl: authFlow.baseUrl });
  }

  authFlow.status = 'pending';
  authFlow.error = null;
  authFlow.startedAt = Date.now();
  authFlow.baseUrl = context.baseUrl;
  authFlow.teamId = context.teamId;

  void (async () => {
    try {
      const { runBrowserLoginCapture } = await import('./auth.mjs');
      await runBrowserLoginCapture({ baseUrl: context.baseUrl });
      authFlow.status = 'idle';
      authFlow.error = null;
      authFlow.baseUrl = '';
      authFlow.teamId = '';
    } catch (error) {
      authFlow.status = 'idle';
      authFlow.error = error?.message ?? String(error);
      authFlow.baseUrl = context.baseUrl;
      authFlow.teamId = context.teamId;
    }
  })();

  return sendJson(res, 200, { status: 'pending', baseUrl: context.baseUrl });
}

async function handleCrawl(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) return;

  const { taskIds, baseUrl: requestBaseUrl, teamId: requestTeamId } = body;
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return sendJson(res, 400, { error: 'taskIds must be a non-empty array' });
  }

  try {
    const { authToken, userId, baseUrl, teamId } = await resolveRuntimeContext({
      baseUrl: requestBaseUrl,
      teamId: requestTeamId,
    });

    if (!authToken || !userId || !baseUrl) {
      return sendJson(res, 401, {
        error: 'auth_required',
        detail: 'Connect ONES first to let the local service capture credentials.',
        baseUrl,
        teamId,
      });
    }

    if (!teamId) {
      return sendJson(res, 500, { error: 'missing_config', detail: 'team-id not configured. Please login to auto-detect it.' });
    }

    const seen = new Set();
    const roots = [];
    const allTasks = [];

    for (const rawId of taskIds) {
      let rootUuid;
      if (/^\d+$/.test(rawId)) {
        rootUuid = await resolveTaskNumber(baseUrl, teamId, rawId, authToken, userId);
      } else {
        rootUuid = rawId;
      }
      roots.push(rootUuid);
      const tasks = await crawlTask(baseUrl, teamId, rootUuid, authToken, userId, 0, 10, seen);
      for (const t of tasks) allTasks.push({ ...t, root_uuid: rootUuid });
    }

    const enrichedTasks = await enrichTasks(baseUrl, teamId, allTasks, authToken, userId).catch(() => allTasks);

    return sendJson(res, 200, { roots, tasks: enrichedTasks, baseUrl, teamId });
  } catch (err) {
    const tokenExpired = err.message?.includes('401') || err.message?.includes('Token expired') || err.message?.includes('TOKEN_EXPIRED');
    return sendJson(res, tokenExpired ? 401 : 500, { error: tokenExpired ? 'token_expired' : 'crawl_failed', detail: err.message });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    try {
      const html = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(404); res.end('index.html not found');
    }
    return;
  }
  if (req.method === 'GET' && req.url === '/api/auth/status') {
    return handleAuthStatus(req, res);
  }
  if (req.method === 'POST' && req.url === '/api/auth/login') {
    return handleAuthLogin(req, res);
  }
  if (req.method === 'POST' && req.url === '/api/crawl') {
    return handleCrawl(req, res);
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  process.stdout.write(`ONES Fetch Web UI → ${url}\n`);
  openBrowser(url);
});
