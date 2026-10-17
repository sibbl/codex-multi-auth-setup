import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from 'smol-toml';
import { isDeepStrictEqual } from 'node:util';

export const defaultClientRoot = () => path.join(os.homedir(), '.config', 'codex-multi-auth-setup');
export const defaultServerRoot = (home = os.homedir()) =>
  path.join(home, '.local', 'share', 'codex-multi-auth-setup');

export function validHost(value) {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_][A-Za-z0-9_.:@%[\]-]*$/.test(value) &&
    !value.includes('@@')
  );
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('Configuration must be an object');
  if (config.schemaVersion !== 1) throw new Error('Unsupported configuration version');
  for (const key of ['root', 'node', 'appDir']) {
    if (
      typeof config[key] !== 'string' ||
      !path.isAbsolute(config[key]) ||
      /[\r\n\0]/.test(config[key])
    ) {
      throw new Error(`${key} must be an absolute path without control characters`);
    }
  }
  if (!['local', 'ssh'].includes(config.mode)) throw new Error('Choose local or SSH installation');
  if (!['sequential', 'hybrid'].includes(config.strategy))
    throw new Error('Upstream supports sequential or hybrid, not round robin');
  const portNames = ['router', 'gateway', 'client', 'tunnel'];
  const ports = portNames.map((name) => config.ports?.[name]);
  if (
    Object.keys(config.ports ?? {}).length !== 4 ||
    ports.some((p) => !Number.isInteger(p) || p < 1024 || p > 65535) ||
    new Set(ports).size !== 4
  ) {
    throw new Error('Four different unprivileged ports (1024–65535) are required');
  }
  if (
    typeof config.clientApiKey !== 'string' ||
    config.clientApiKey.length < 16 ||
    /[\r\n\0]/.test(config.clientApiKey)
  )
    throw new Error(
      'Private gateway key must contain at least 16 characters without control characters',
    );
  if (
    config.codexHome !== undefined &&
    (typeof config.codexHome !== 'string' ||
      !path.isAbsolute(config.codexHome) ||
      /[\r\n\0]/.test(config.codexHome))
  )
    throw new Error('codexHome must be an absolute path without control characters');
  if (
    !Number.isFinite(config.updates?.delayHours) ||
    config.updates.delayHours < 0 ||
    config.updates.delayHours > 8760
  ) {
    throw new Error('Update delay must be 0–8760 hours');
  }
  if (
    !Number.isInteger(config.updates?.intervalHours) ||
    config.updates.intervalHours < 1 ||
    config.updates.intervalHours > 24
  ) {
    throw new Error('Update interval must be 1–24 hours');
  }
  if (config.mode === 'ssh') {
    if (
      !validHost(config.ssh?.host) ||
      (config.ssh.fallbackHost && !validHost(config.ssh.fallbackHost))
    )
      throw new Error('Invalid SSH hostname/address');
    if (!Number.isInteger(config.ssh.port) || config.ssh.port < 1 || config.ssh.port > 65535)
      throw new Error('Invalid SSH port');
    for (const key of ['identityFile', 'hostKeyAlias']) {
      if (config.ssh[key] && /[\r\n\0]/.test(config.ssh[key]))
        throw new Error('Invalid SSH option');
    }
  }
  return config;
}

export async function atomicJson(filename, data) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, filename);
}

export async function readJson(filename, fallback) {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

export function setDesktopEndpoint(text, url) {
  const parsed = parse(text);
  const value = new URL(url);
  if (value.protocol !== 'http:' || value.hostname !== '127.0.0.1')
    throw new Error('Desktop endpoint must remain loopback HTTP');
  // Keep comments and unrelated TOML exactly as written. Only root-level assignment.
  const lines = text.split('\n');
  let inTable = false;
  let replaced = false;
  const result = lines
    .map((line) => {
      if (/^\s*\[/.test(line)) inTable = true;
      if (!inTable && /^\s*openai_base_url\s*=/.test(line)) {
        replaced = true;
        const simple =
          /^(\s*)openai_base_url\s*=\s*(?:"(?:\\.|[^"\\])*"|'[^']*')(\s*(?:#.*)?)$/.exec(line);
        return `${simple?.[1] ?? ''}openai_base_url = ${JSON.stringify(url)}${simple?.[2] ?? ''}`;
      }
      return line;
    })
    .join('\n');
  if (parsed.openai_base_url !== undefined && !replaced)
    throw new Error(
      'Unusual openai_base_url TOML syntax; update it manually using the backed-up config',
    );
  const output = replaced ? result : `openai_base_url = ${JSON.stringify(url)}\n${result}`;
  const verified = parse(output);
  const expected = Object.assign(Object.create(Object.getPrototypeOf(parsed)), parsed, {
    openai_base_url: url,
  });
  if (!isDeepStrictEqual(verified, expected)) {
    throw new Error('Cannot safely edit this TOML layout without changing unrelated settings');
  }
  return output;
}

export function managementEnvironment(config) {
  return {
    CODEX_HOME: path.join(config.root, 'data', 'codex'),
    CODEX_MULTI_AUTH_DIR: path.join(config.root, 'data', 'multi-auth'),
    CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: '0',
    CODEX_MULTI_AUTH_SYNC_CODEX_CLI: '0',
    CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE: '0',
    CODEX_MULTI_AUTH_APP_BIND: '0',
    CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL: '0',
    CODEX_AUTH_SCHEDULING_STRATEGY: config.strategy,
    CODEX_TUI: '',
    CODEX_DESKTOP: '',
    ELECTRON_RUN_AS_NODE: '',
    TERM_PROGRAM: '',
    PATH: `${path.dirname(config.node)}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
  };
}

export function publicConfig(config) {
  const { clientApiKey: _key, ...safe } = config;
  return safe;
}
