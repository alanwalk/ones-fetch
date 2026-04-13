import os from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn, exec } from 'node:child_process';

const RUN_DIR = join(os.homedir(), '.ones-fetch', 'run');
const STATE_FILE = join(RUN_DIR, 'server.json');
const DEFAULT_PORT = Number(process.env.PORT ?? 36781);

function openBrowser(url) {
  let command;
  if (process.platform === 'darwin') {
    command = `open "${url}"`;
  } else if (process.platform === 'win32') {
    command = `start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }
  exec(command);
}

async function ensureRunDir() {
  await mkdir(RUN_DIR, { recursive: true });
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function writeState(state) {
  await ensureRunDir();
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function clearState() {
  await rm(STATE_FILE, { force: true });
}

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fetchHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function waitForServerReady(expectedPid, port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await fetchHealth(port);
    if (health?.pid === expectedPid) {
      return health;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

export async function getServiceStatus() {
  const state = await readState();
  const health = await fetchHealth(state?.port ?? DEFAULT_PORT);

  if (state?.pid && isPidRunning(state.pid)) {
    if (health?.pid === state.pid) {
      return {
        state: 'running',
        managed: true,
        pid: state.pid,
        port: health.port ?? state.port ?? DEFAULT_PORT,
        url: health.url ?? `http://127.0.0.1:${state.port ?? DEFAULT_PORT}`,
        startedAt: state.startedAt ?? health.startedAt ?? null,
      };
    }

    return {
      state: 'unhealthy',
      managed: true,
      pid: state.pid,
      port: state.port ?? DEFAULT_PORT,
      url: `http://127.0.0.1:${state.port ?? DEFAULT_PORT}`,
      startedAt: state.startedAt ?? null,
    };
  }

  if (state?.pid) {
    await clearState();
  }

  if (health?.pid) {
    return {
      state: 'running',
      managed: false,
      pid: health.pid,
      port: health.port ?? DEFAULT_PORT,
      url: health.url ?? `http://127.0.0.1:${health.port ?? DEFAULT_PORT}`,
      startedAt: health.startedAt ?? null,
    };
  }

  return {
    state: 'stopped',
    managed: false,
    pid: null,
    port: state?.port ?? DEFAULT_PORT,
    url: `http://127.0.0.1:${state?.port ?? DEFAULT_PORT}`,
    startedAt: null,
  };
}

export async function startService({ serverEntryPath, projectRoot, open = true } = {}) {
  const current = await getServiceStatus();
  if (current.state === 'running') {
    if (open) openBrowser(current.url);
    return { status: 'already_running', ...current };
  }

  if (current.state === 'unhealthy' && current.managed && current.pid) {
    try {
      process.kill(current.pid);
    } catch {}
    await waitForProcessExit(current.pid, 3000);
    await clearState();
  }

  const child = spawn(process.execPath, [serverEntryPath], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ONES_FETCH_OPEN_BROWSER: '0',
    },
  });

  let exitInfo = null;
  child.once('exit', (code, signal) => {
    exitInfo = { code, signal };
  });
  child.unref();

  const health = await waitForServerReady(child.pid, DEFAULT_PORT);
  if (!health) {
    if (exitInfo == null && isPidRunning(child.pid)) {
      try {
        process.kill(child.pid);
      } catch {}
      await waitForProcessExit(child.pid, 2000);
    }
    return {
      status: 'failed',
      pid: child.pid,
      reason: exitInfo ? `process exited early (code=${exitInfo.code ?? 'null'}, signal=${exitInfo.signal ?? 'null'})` : 'server did not become ready in time',
    };
  }

  const nextState = {
    pid: child.pid,
    port: health.port ?? DEFAULT_PORT,
    url: health.url ?? `http://127.0.0.1:${DEFAULT_PORT}`,
    startedAt: health.startedAt ?? new Date().toISOString(),
  };
  await writeState(nextState);

  if (open) openBrowser(nextState.url);

  return {
    status: 'started',
    managed: true,
    ...nextState,
  };
}

export async function stopService() {
  const current = await getServiceStatus();
  if (!current.managed || !current.pid) {
    return {
      status: current.state === 'running' ? 'unmanaged_running' : 'not_running',
      ...current,
    };
  }

  try {
    process.kill(current.pid);
  } catch {
    await clearState();
    return {
      status: 'not_running',
      ...current,
    };
  }

  const stopped = await waitForProcessExit(current.pid, 5000);
  if (!stopped) {
    return {
      status: 'stop_timeout',
      ...current,
    };
  }

  await clearState();
  return {
    status: 'stopped',
    ...current,
  };
}

export function getServiceStatePath() {
  return STATE_FILE;
}
