import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from './process.mjs';

async function available(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

// Only explicit version commands run here. Never start, migrate, or update a daemon.
export async function inspectVersions(config) {
  const checks = [];
  try {
    const info = JSON.parse(
      await readFile(path.join(config.root, 'current-proxy', 'package.json'), 'utf8'),
    );
    checks.push({
      name: 'Proxy version',
      ok: info.name === 'codex-multi-auth' && typeof info.version === 'string',
      detail: info.version ?? 'Unknown',
    });
  } catch {
    checks.push({
      name: 'Proxy version',
      ok: false,
      detail: 'Managed proxy package is missing or unreadable',
    });
  }
  const candidates = [
    config.codexHome &&
      path.join(config.codexHome, 'packages', 'app-server-daemon', 'current', 'bin', 'codex'),
    config.codexHome &&
      path.join(config.codexHome, 'packages', 'standalone', 'current', 'bin', 'codex'),
    path.join(config.root, 'current-cli', 'bin', 'codex'),
  ].filter(Boolean);
  let executable;
  for (const candidate of candidates) {
    if (await available(candidate)) {
      executable = candidate;
      break;
    }
  }
  if (!executable) {
    checks.push({
      name: 'Native Codex daemon',
      ok: true,
      optional: true,
      detail: 'No native or managed CLI found; mobile daemon version not checked',
    });
    return checks;
  }
  try {
    const result = await run(executable, ['app-server', 'daemon', 'version'], {
      env: config.codexHome ? { CODEX_HOME: config.codexHome } : {},
      timeoutMs: 10000,
      maxOutput: 65536,
    });
    const report = JSON.parse(result.stdout);
    // Do not expose identity, authentication, or arbitrary daemon response fields.
    const detail = {
      status: typeof report.status === 'string' ? report.status : 'unknown',
      runningVersion: typeof report.appServerVersion === 'string' ? report.appServerVersion : null,
      selectedVersion:
        typeof report.managedCodexVersion === 'string' ? report.managedCodexVersion : null,
    };
    checks.push({
      name: 'Native Codex daemon',
      ok: report.status === 'running',
      optional: true,
      detail,
    });
  } catch {
    checks.push({
      name: 'Native Codex daemon',
      ok: false,
      optional: true,
      detail:
        'Version unavailable. Older native daemons can advertise a different model catalog; update the native daemon separately if mobile sessions fail.',
    });
  }
  return checks;
}
