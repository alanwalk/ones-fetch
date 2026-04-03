#!/usr/bin/env node

// Network capture script: opens LDAP login page in headed mode,
// waits for user to log in and navigate, then saves all captured
// API requests/responses to a JSON file for analysis.
//
// Usage: node src/explore.mjs [--base-url <url>] [--out <file>]

import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error(`Unexpected: ${token}`);
    const key = token.slice(2);
    if (key === "help") { args[key] = true; continue; }
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    i++;
  }
  return args;
}

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

// Only keep requests that look like API calls (skip static assets)
function isApiRequest(url) {
  const u = new URL(url);
  const path = u.pathname;
  // Skip obvious static assets
  if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map)$/i.test(path)) return false;
  if (path.startsWith("/static/") || path.startsWith("/assets/")) return false;
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args["base-url"] ?? "https://ones.kingamer.cn";
  const outFile = args["out"] ?? "captured-requests.json";

  const captured = [];
  const pendingResponses = new Map(); // requestId -> { entry, resolve }

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext();
  const page = await context.newPage();

  // --- Intercept all requests ---
  page.on("request", (req) => {
    if (!isApiRequest(req.url())) return;
    const entry = {
      timestamp: new Date().toISOString(),
      method: req.method(),
      url: req.url(),
      requestHeaders: req.headers(),
      postData: req.postData() ?? null,
      postDataJSON: null,
      status: null,
      responseHeaders: null,
      responseBody: null,
      responseJSON: null,
    };
    try {
      if (entry.postData) entry.postDataJSON = JSON.parse(entry.postData);
    } catch { /* not JSON */ }
    captured.push(entry);
    // Store index so we can fill response later
    pendingResponses.set(req, entry);
  });

  page.on("response", async (res) => {
    const req = res.request();
    const entry = pendingResponses.get(req);
    if (!entry) return;
    pendingResponses.delete(req);
    entry.status = res.status();
    entry.responseHeaders = res.headers();
    try {
      const body = await res.body();
      entry.responseBody = body.toString("utf8").slice(0, 50000); // cap at 50 KB
      try { entry.responseJSON = JSON.parse(entry.responseBody); } catch { /* not JSON */ }
    } catch { /* body unavailable */ }
  });

  // --- Step 1: Open login page ---
  const loginUrl = `${baseUrl}/project/#/3rd_party_connect/ldap/login?path=/auth/third_login&ones_from=${encodeURIComponent(baseUrl + "/project/#/workspace")}`;
  console.log(`\n>>> Opening: ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: "networkidle", timeout: 60000 });

  console.log("\n>>> Browser is open. Please:");
  console.log("    1. Log in with your credentials");
  console.log("    2. Navigate to a task that has subtasks");
  console.log("    3. Expand / click around so subtask data loads");
  console.log("    4. Come back here and press ENTER when done");
  await waitForEnter("\nPress ENTER to save captured requests... ");

  // Give in-flight responses a moment to finish
  await page.waitForTimeout(1500);

  await browser.close();

  // Write output
  const out = JSON.stringify(captured, null, 2);
  await writeFile(outFile, out, "utf8");
  console.log(`\n>>> Saved ${captured.length} captured requests to: ${outFile}`);
  console.log(">>> Share that file (or paste its contents) for analysis.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exitCode = 1;
});
