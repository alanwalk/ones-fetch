import os from 'node:os';
import { join } from 'node:path';
import { mkdirSync, appendFileSync, statSync, renameSync, rmSync } from 'node:fs';

const LOG_DIR = join(os.homedir(), '.ones-fetch', 'logs');
const RUNTIME_LOG_PATH = join(LOG_DIR, 'runtime.log');
const MAX_LOG_SIZE_BYTES = 1024 * 1024;

function formatMeta(meta) {
  if (!meta) return '';
  const pairs = Object.entries(meta).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (pairs.length === 0) return '';
  return ' ' + pairs.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ');
}

function rotateIfNeeded() {
  try {
    const info = statSync(RUNTIME_LOG_PATH);
    if (info.size < MAX_LOG_SIZE_BYTES) return;
    rmSync(`${RUNTIME_LOG_PATH}.1`, { force: true });
    renameSync(RUNTIME_LOG_PATH, `${RUNTIME_LOG_PATH}.1`);
  } catch {
    // Ignore missing file and rotation errors.
  }
}

function writeLine(line) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    rotateIfNeeded();
    appendFileSync(RUNTIME_LOG_PATH, `${line}\n`, 'utf8');
  } catch {
    // Logging must never break the main flow.
  }
}

export function getRuntimeLogPath() {
  return RUNTIME_LOG_PATH;
}

export function logInfo(message, meta) {
  const line = `[${new Date().toISOString()}] INFO ${message}${formatMeta(meta)}`;
  process.stdout.write(`${line}\n`);
  writeLine(line);
}

export function logWarn(message, meta) {
  const line = `[${new Date().toISOString()}] WARN ${message}${formatMeta(meta)}`;
  process.stdout.write(`${line}\n`);
  writeLine(line);
}

export function logError(message, error, meta) {
  const mergedMeta = { ...meta };
  if (error) {
    mergedMeta.error = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.stack) {
      mergedMeta.stack = error.stack;
    }
  }
  const line = `[${new Date().toISOString()}] ERROR ${message}${formatMeta(mergedMeta)}`;
  process.stderr.write(`${line}\n`);
  writeLine(line);
}
