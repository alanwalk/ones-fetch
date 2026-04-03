// auth.mjs — login + credential persistence for ones-fetch CLI
// Credentials stored at ~/.ones-fetch/credentials.json (mode 600 on non-Windows)

import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { chromium } from "playwright";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function getCredentialsPath() {
  return path.join(os.homedir(), ".ones-fetch", "credentials.json");
}

// ---------------------------------------------------------------------------
// Read / write credentials
// ---------------------------------------------------------------------------

export async function readCredentials() {
  const file = getCredentialsPath();
  try {
    const raw = await fsp.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function writeCredentials(obj) {
  const file = getCredentialsPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(obj, null, 2), "utf8");
  if (process.platform !== "win32") {
    await fsp.chmod(file, 0o600);
  }
}

function getLoginUrl(baseUrl) {
  return `${baseUrl}/project/#/3rd_party_connect/ldap/login?path=/auth/third_login&ones_from=${encodeURIComponent(baseUrl + "/project/#/workspace")}`;
}

async function extractSessionFromPage(page) {
  return page.evaluate(() => {
    const fromStorage = (key) => window.localStorage.getItem(key) || window.sessionStorage.getItem(key);

    let authToken = fromStorage("ones-auth-token") || fromStorage("authToken") || fromStorage("token");
    let userId = fromStorage("ones-user-id") || fromStorage("userId") || fromStorage("uid");

    if (!authToken || !userId) {
      const cookies = document.cookie.split(";").map((item) => item.trim()).filter(Boolean);
      for (const cookie of cookies) {
        const eqIndex = cookie.indexOf("=");
        if (eqIndex === -1) continue;
        const key = cookie.slice(0, eqIndex);
        const value = decodeURIComponent(cookie.slice(eqIndex + 1));
        if (!authToken && key.includes("ones-auth-token")) authToken = value;
        if (!userId && key.includes("ones-user-id")) userId = value;
      }
    }

    return authToken && userId ? { authToken, userId } : null;
  });
}

export async function runBrowserLoginCapture({ baseUrl, timeoutMs = 300000, verbose = false }) {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  const loginUrl = getLoginUrl(baseUrl);

  let resolved = false;

  return new Promise(async (resolve, reject) => {
    const finish = async (result, error) => {
      if (resolved) return;
      try {
        if (error) throw error;
        await writeCredentials({ ...result, baseUrl });
        resolved = true;
        resolve({ ...result, baseUrl });
      } catch (innerError) {
        resolved = true;
        reject(innerError);
      } finally {
        clearTimeout(timeout);
        clearInterval(poller);
        page.removeListener("response", onResponse);
        page.removeListener("framenavigated", onNavigation);
        try {
          await browser.close();
        } catch {
          // Ignore browser close failures during auth teardown.
        }
      }
    };

    const tryPageSession = async () => {
      let session = null;
      try {
        session = await extractSessionFromPage(page);
      } catch {
        // Cross-page transitions can temporarily break page evaluation.
      }
      if (session?.authToken && session?.userId) {
        await finish(session, null);
      }
    };

    const onResponse = async (res) => {
      if (!res.url().includes("/sso/login") && !res.url().includes("/auth/login")) return;
      try {
        const headers = res.headers();
        const authToken = headers["ones-auth-token"] ?? null;
        const userId = headers["ones-user-id"] ?? null;
        if (authToken && userId) {
          await finish({ authToken, userId }, null);
          return;
        }
      } catch {
        // Ignore response parsing issues and fall back to page polling.
      }
      await tryPageSession();
    };

    const onNavigation = () => {
      void tryPageSession();
    };

    const timeout = setTimeout(() => {
      void finish(null, new Error("LOGIN_TIMEOUT"));
    }, timeoutMs);

    const poller = setInterval(() => {
      void tryPageSession();
    }, 1000);

    page.on("response", onResponse);
    page.on("framenavigated", onNavigation);

    try {
      if (verbose) process.stderr.write(`Opening browser login at ${loginUrl}\n`);
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await tryPageSession();
    } catch (error) {
      await finish(null, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// ---------------------------------------------------------------------------
// Password prompt (no echo)
// ---------------------------------------------------------------------------

function promptVisible(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function promptHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const chars = [];

    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");

      function onData(ch) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(chars.join(""));
        } else if (ch === "\u0003") {
          // Ctrl-C
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(1);
        } else if (ch === "\u007f" || ch === "\b") {
          chars.pop();
        } else {
          chars.push(ch);
        }
      }

      stdin.on("data", onData);
    } else {
      // Fallback: readline without echo suppression
      const rl = readline.createInterface({ input: stdin, output: process.stdout });
      rl.question("", (answer) => {
        rl.close();
        process.stdout.write("\n");
        resolve(answer);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Core Playwright login (shared by headless + headed paths)
// ---------------------------------------------------------------------------

async function doLogin(page, { baseUrl, username, password, verbose, usernameSelector, passwordSelector }) {
  const loginUrl = getLoginUrl(baseUrl);

  // Default selectors with fallback chain
  const userSel = usernameSelector ?? 'input[name="loginName"], input[name="username"], input[type="text"]';
  const passSel = passwordSelector ?? 'input[name="password"], input[type="password"]';

  if (verbose) process.stderr.write("Navigating to login page...\n");
  await page.goto(loginUrl, { waitUntil: "networkidle", timeout: 60000 });

  await page.waitForSelector(userSel, { timeout: 15000 });

  const userInput = page.locator(userSel).first();
  const passInput = page.locator(passSel).first();
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

// ---------------------------------------------------------------------------
// runLogin — interactive login with headless-first, headed fallback
// ---------------------------------------------------------------------------

export async function runLogin(options) {
  const { baseUrl, verbose, usernameSelector, passwordSelector } = options;
  const username = await promptVisible("Username: ");
  const password = await promptHidden("Password: ");

  // --- Headless attempt ---
  if (verbose) process.stderr.write("Trying headless login...\n");
  let browser = await chromium.launch({ headless: true });
  let context = await browser.newContext();
  let page = await context.newPage();

  let authToken = null;
  let userId = null;

  try {
    ({ authToken, userId } = await doLogin(page, { baseUrl, username, password, verbose, usernameSelector, passwordSelector }));
  } catch (err) {
    if (verbose) process.stderr.write(`Headless login error: ${err.message}\n`);
  } finally {
    await browser.close();
  }

  // --- Headed fallback ---
  if (!authToken) {
    process.stderr.write("Headless login did not capture token. Falling back to headed browser...\n");
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext();
    page = await context.newPage();

    // Attach a persistent response listener to capture the token at any point
    page.on("response", async (res) => {
      if (authToken) return;
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

    try {
      await doLogin(page, { baseUrl, username, password, verbose, usernameSelector, passwordSelector });
    } catch (err) {
      if (verbose) process.stderr.write(`Headed login error: ${err.message}\n`);
    } finally {
      await browser.close();
    }
  }

  if (authToken) {
    await writeCredentials({ authToken, userId, baseUrl });
    process.stdout.write(`Login successful. Credentials saved to ${getCredentialsPath()}\n`);
  } else {
    process.stderr.write("Login failed: auth token was not captured.\n");
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// loadAuth — read credentials for use in other commands
// ---------------------------------------------------------------------------

export async function loadAuth(cliBaseUrl) {
  const creds = await readCredentials();
  const authToken = creds.authToken;
  const userId = creds.userId;
  const baseUrl = cliBaseUrl ?? creds.baseUrl;

  if (!authToken || !userId || !baseUrl) {
    throw new Error("Run: node src/ones-subtasks-cli.mjs login");
  }

  return { authToken, userId, baseUrl };
}
