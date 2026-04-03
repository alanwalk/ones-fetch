#!/usr/bin/env node
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = process.env.PORT ?? 3000;

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
  const { readConfig } = await import('./config.mjs');
  const cfg = await readConfig();

  const overrideBaseUrl = normalizeBaseUrl(overrides.baseUrl);
  const configBaseUrl = normalizeBaseUrl(process.env.ONES_BASE_URL) || normalizeBaseUrl(cfg['base-url']);
  const requestedBaseUrl = overrideBaseUrl || configBaseUrl;

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
  const teamId = overrides.teamId ?? process.env.ONES_TEAM_ID ?? cfg['team-id'] ?? '';

  return {
    authToken: auth?.authToken ?? null,
    userId: auth?.userId ?? null,
    baseUrl,
    teamId,
  };
}

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
    status: authFlow.status === 'pending' ? 'pending' : 'unauthenticated',
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
    const { resolveTaskNumber, crawlTask, enrichTasks } = await import('./ones-subtasks-cli.mjs');

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

    if (!baseUrl || !teamId) {
      return sendJson(res, 500, { error: 'missing_config', detail: 'base-url or team-id not configured. Paste a task link or configure them first.' });
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
      const tasks = await crawlTask(baseUrl, teamId, rootUuid, authToken, userId, 0, 10, seen, false);
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
  process.stdout.write(`ONES Fetch Web UI → http://localhost:${PORT}\n`);
});
