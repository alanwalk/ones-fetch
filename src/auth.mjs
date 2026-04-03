// auth.mjs — browser login for ones-fetch web mode
// Credentials stored at ~/.ones-fetch/credentials.json (mode 600 on non-Windows)

import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

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

    // Extract team-id from URL: /team/{uuid}/...
    let teamId = null;
    const teamMatch = window.location.href.match(/\/team\/([a-zA-Z0-9]{16,})/);
    if (teamMatch) teamId = teamMatch[1];

    return authToken && userId ? { authToken, userId, teamId } : null;
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
        const credentialsToSave = { ...result, baseUrl };
        await writeCredentials(credentialsToSave);
        resolved = true;
        resolve(credentialsToSave);
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
          // Try to extract teamId from current page URL
          let teamId = null;
          try {
            const currentUrl = page.url();
            const teamMatch = currentUrl.match(/\/team\/([a-zA-Z0-9]{16,})/);
            if (teamMatch) teamId = teamMatch[1];
          } catch { /* ignore */ }
          await finish({ authToken, userId, teamId }, null);
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
// loadAuth — read credentials for use in server
// ---------------------------------------------------------------------------

export async function loadAuth(cliBaseUrl) {
  const creds = await readCredentials();
  const authToken = creds.authToken;
  const userId = creds.userId;
  const baseUrl = cliBaseUrl ?? creds.baseUrl;
  const teamId = creds.teamId;

  if (!authToken || !userId || !baseUrl) {
    throw new Error("Not authenticated");
  }

  return { authToken, userId, baseUrl, teamId };
}
