// config.mjs — manages ~/.ones-fetch/config.json for the ones-fetch CLI
// Uses only Node.js built-ins (fs/promises, os, path). ESM module.

import { readFile, writeFile, mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

/** Returns the config directory path: ~/.ones-fetch */
export function getConfigDir() {
  return join(homedir(), '.ones-fetch');
}

/** Returns the full path to the config file: ~/.ones-fetch/config.json */
export function getConfigPath() {
  return join(getConfigDir(), 'config.json');
}

/** Creates the config directory if it does not exist (mkdir -p). */
export async function ensureConfigDir() {
  await mkdir(getConfigDir(), { recursive: true });
}

/** Reads and parses config.json. Returns {} if the file is missing or unreadable. */
export async function readConfig() {
  try {
    const raw = await readFile(getConfigPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Serialises obj to JSON and writes it to config.json (creating the dir if needed). */
export async function writeConfig(obj) {
  await ensureConfigDir();
  await writeFile(getConfigPath(), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/**
 * Returns the first non-empty value among:
 *   1. cliVal       — value passed on the command line
 *   2. process.env[envVar] — environment variable
 *   3. config[configKey]  — persisted config file value
 *
 * Reads the config file synchronously via readConfig() (async callers should
 * await the resolved value or pre-load the config and call this inline).
 *
 * Because the config read is async, this function returns a Promise.
 */
export async function resolveParam(cliVal, envVar, configKey) {
  if (cliVal !== undefined && cliVal !== null && cliVal !== '') return cliVal;
  const envVal = process.env[envVar];
  if (envVal !== undefined && envVal !== '') return envVal;
  const config = await readConfig();
  const cfgVal = config[configKey];
  if (cfgVal !== undefined && cfgVal !== '') return cfgVal;
  return undefined;
}

/** Valid config keys accepted by `config set`. */
const VALID_KEYS = new Set(['base-url', 'team-id']);

/**
 * Handles the `config` subcommand.
 *
 * Usage:
 *   config set <key> <value>   — persist a value (valid keys: base-url, team-id)
 *   config get [key]           — print one field or the whole config as JSON
 *   config list                — alias for `config get` with no key
 */
export async function runConfig(subArgs) {
  const [cmd, ...rest] = subArgs ?? [];

  switch (cmd) {
    case 'set': {
      const [key, value] = rest;
      if (!key || value === undefined) {
        console.error('Usage: config set <key> <value>');
        process.exit(1);
      }
      if (!VALID_KEYS.has(key)) {
        console.error(`Invalid key "${key}". Valid keys: ${[...VALID_KEYS].join(', ')}`);
        process.exit(1);
      }
      const config = await readConfig();
      config[key] = value;
      await writeConfig(config);
      console.log(`Set ${key} = ${value}`);
      break;
    }

    case 'get': {
      const [key] = rest;
      const config = await readConfig();
      if (key) {
        const val = config[key];
        console.log(JSON.stringify(val ?? null, null, 2));
      } else {
        console.log(JSON.stringify(config, null, 2));
      }
      break;
    }

    case 'list': {
      const config = await readConfig();
      console.log(JSON.stringify(config, null, 2));
      break;
    }

    default: {
      console.error('Usage: config <set|get|list> [key] [value]');
      process.exit(1);
    }
  }
}
