import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createGunzip } from 'node:zlib';

const REGISTRY = 'https://registry.npmjs.org/codex-multi-auth';
const RELEASES = 'https://releases.openai.com/codex';
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MARKER = '.setup-release.json';

async function command(executable, args, { cwd, timeout = 600_000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}`,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let expired = false;
    let killTimer;
    const timer = setTimeout(() => {
      expired = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeout);
    child.stdout.on('data', (data) => {
      stdout = (stdout + data).slice(-2_000_000);
    });
    child.stderr.on('data', (data) => {
      stderr = (stderr + data).slice(-2_000_000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (code !== 0 || expired)
        reject(
          new Error(
            `${path.basename(executable)} ${expired ? 'timed out' : `exited ${code}`}: ${stderr.slice(-800)}`,
          ),
        );
      else resolve(stdout.trim());
    });
  });
}

async function exists(filename) {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function json(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filename);
    await syncDirectory(path.dirname(filename));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function digest(filename, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function fetchJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { 'User-Agent': 'codex-multi-auth-setup/1' },
  });
  if (!response.ok) throw new Error(`Release metadata returned HTTP ${response.status}`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 40 * 1024 * 1024) throw new Error('Release metadata exceeds size limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

function compareVersions(left, right) {
  if (!STABLE.test(left) || !STABLE.test(right))
    throw new Error('Expected a stable semantic version');
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function selectProxyRelease(
  metadata,
  { delayHours = 48, currentVersion = null, now = Date.now() } = {},
) {
  if (!Number.isFinite(delayHours) || delayHours < 0 || delayHours > 24 * 365)
    throw new Error('Invalid update delay');
  const latest = metadata['dist-tags']?.latest;
  if (!STABLE.test(latest || '')) throw new Error('npm latest is not a stable release');
  const cutoff = Number(now) - delayHours * 3_600_000;
  const versions = Object.keys(metadata.versions || {})
    .filter((version) => {
      const published = Date.parse(metadata.time?.[version]);
      return (
        STABLE.test(version) &&
        !metadata.versions[version].deprecated &&
        Number.isFinite(published) &&
        published <= cutoff &&
        compareVersions(version, latest) <= 0
      );
    })
    .sort(compareVersions);
  const version = versions.at(-1);
  if (!version) throw new Error(`No stable proxy release is at least ${delayHours} hours old`);
  if (currentVersion && compareVersions(version, currentVersion) <= 0) return null;
  const release = metadata.versions[version];
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(release.dist?.integrity || ''))
    throw new Error('Proxy release has no valid SHA512 integrity');
  if (release.name !== 'codex-multi-auth' || release.version !== version)
    throw new Error('Proxy registry identity mismatch');
  const url = new URL(release.dist.tarball);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'registry.npmjs.org' ||
    url.username ||
    url.password
  )
    throw new Error('Unexpected proxy archive URL');
  return { version, integrity: release.dist.integrity, url: url.href };
}

async function containedPath(directory, filename) {
  const relative = path.relative(await realpath(directory), await realpath(filename));
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('Managed package path escapes its release directory');
  return filename;
}

async function packageFile(packagePath, relative) {
  const filename = await containedPath(packagePath, path.join(packagePath, relative));
  if (!(await stat(filename)).isFile()) throw new Error('Managed package file is not regular');
  return filename;
}

async function currentPackage(root, kind) {
  const filename = path.join(root, `current-${kind}`);
  if (!(await exists(filename))) return null;
  if (!(await lstat(filename)).isSymbolicLink())
    throw new Error(`Refusing to replace unmanaged ${filename}`);
  const target = await realpath(filename);
  const relative = path.relative(await realpath(path.join(root, 'releases')), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(`Current ${kind} points outside managed releases`);
  const marker = await json(await packageFile(target, MARKER));
  if (marker.kind !== kind || !STABLE.test(marker.version || ''))
    throw new Error(`Current ${kind} is not an owned release`);
  return { version: marker.version, packagePath: target };
}

async function checkProxyPackage(packagePath, release) {
  const info = await json(await packageFile(packagePath, 'package.json'));
  if (info.name !== 'codex-multi-auth' || info.version !== release.version)
    throw new Error('Proxy package version mismatch');
  await command(
    process.execPath,
    ['--check', await packageFile(packagePath, 'scripts/codex-app-router.js')],
    { timeout: 15_000 },
  );
}

export async function inspectManagedPackage(root, kind) {
  if (!['proxy', 'cli'].includes(kind)) throw new Error('Unknown managed package kind');
  const selected = await currentPackage(path.resolve(root), kind);
  if (!selected) return null;
  if (kind === 'proxy') await checkProxyPackage(selected.packagePath, selected);
  else await verifyCli(selected.packagePath, await json(path.join(selected.packagePath, MARKER)));
  return { ...selected, changed: false };
}

export async function stageProxy(root, options = {}) {
  root = path.resolve(root);
  const current = await inspectManagedPackage(root, 'proxy');
  const release = selectProxyRelease(await fetchJson(REGISTRY), {
    ...options,
    currentVersion: options.currentVersion ?? current?.version,
  });
  if (!release) {
    if (!current) throw new Error('Current version was supplied without an owned proxy package');
    return { ...current, version: options.currentVersion ?? current.version, changed: false };
  }
  const releases = path.join(root, 'releases');
  await mkdir(releases, { recursive: true, mode: 0o700 });
  const target = path.join(releases, `proxy-${release.version}`);
  const packagePath = path.join(target, 'node_modules/codex-multi-auth');
  if (await exists(target)) {
    if ((await lstat(target)).isSymbolicLink())
      throw new Error('Proxy release directory must not be a symlink');
    await containedPath(target, packagePath);
    const marker = await json(await packageFile(packagePath, MARKER));
    if (
      marker.kind !== 'proxy' ||
      marker.version !== release.version ||
      marker.integrity !== release.integrity ||
      marker.lockSha256 !== (await digest(await packageFile(target, 'package-lock.json')))
    )
      throw new Error('Staged proxy integrity changed');
    await checkProxyPackage(packagePath, release);
    return { version: release.version, packagePath, changed: true };
  }
  const temporary = await mkdtemp(path.join(releases, '.proxy-'));
  try {
    await atomicJson(path.join(temporary, 'package.json'), {
      name: 'codex-multi-auth-managed-release',
      private: true,
      dependencies: { 'codex-multi-auth': release.version },
    });
    const flags = [
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--engine-strict',
      '--install-strategy=nested',
      '--registry=https://registry.npmjs.org',
    ];
    const npmEnvironment = {
      npm_config_update_notifier: 'false',
      npm_config_ignore_scripts: 'true',
    };
    await command('npm', ['install', '--package-lock-only', ...flags], {
      cwd: temporary,
      env: npmEnvironment,
    });
    const lock = await json(path.join(temporary, 'package-lock.json'));
    const locked = lock.packages?.['node_modules/codex-multi-auth'];
    if (
      locked?.version !== release.version ||
      locked?.integrity !== release.integrity ||
      locked?.resolved !== release.url
    )
      throw new Error('npm lockfile does not match selected release integrity');
    await command('npm', ['ci', ...flags], { cwd: temporary, env: npmEnvironment });
    const stagedPackage = path.join(temporary, 'node_modules/codex-multi-auth');
    await checkProxyPackage(stagedPackage, release);
    await atomicJson(path.join(stagedPackage, MARKER), {
      kind: 'proxy',
      ...release,
      lockSha256: await digest(path.join(temporary, 'package-lock.json')),
    });
    await rename(temporary, target);
    await syncDirectory(releases);
    return { version: release.version, packagePath, changed: true };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function platformTarget(platform = process.platform, architecture = process.arch) {
  const targets = {
    'linux:x64': 'x86_64-unknown-linux-musl',
    'linux:arm64': 'aarch64-unknown-linux-musl',
    'darwin:x64': 'x86_64-apple-darwin',
    'darwin:arm64': 'aarch64-apple-darwin',
  };
  const target = targets[`${platform}:${architecture}`];
  if (!target) throw new Error(`Unsupported Codex platform: ${platform}/${architecture}`);
  return target;
}

function tarString(buffer) {
  return buffer.toString('utf8').replace(/\0.*$/s, '');
}

function tarNumber(buffer) {
  const text = tarString(buffer).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error('Unsupported tar numeric field');
  const value = text ? Number.parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid tar numeric field');
  return value;
}

function archiveName(value) {
  if (
    !value ||
    value.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(value) ||
    path.posix.isAbsolute(value) ||
    value.split('/').includes('..')
  )
    throw new Error('Unsafe archive path');
  return path.posix.normalize(value).replace(/\/$/, '');
}

function parsePax(buffer) {
  const fields = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(32, offset);
    if (space === -1) throw new Error('Invalid PAX record');
    const countText = buffer.subarray(offset, space).toString();
    if (!/^\d+$/.test(countText)) throw new Error('Invalid PAX length');
    const size = Number(countText);
    if (
      size <= space - offset + 1 ||
      offset + size > buffer.length ||
      buffer[offset + size - 1] !== 10
    )
      throw new Error('Invalid PAX boundary');
    const record = buffer.subarray(space + 1, offset + size - 1).toString();
    const equals = record.indexOf('=');
    if (equals < 1) throw new Error('Invalid PAX field');
    const key = record.slice(0, equals);
    if (/sparse/i.test(key)) throw new Error('Sparse archives are unsupported');
    fields[key] = record.slice(equals + 1);
    offset += size;
  }
  return fields;
}

export async function validateTar(archive) {
  const input = createReadStream(archive);
  const gunzip = createGunzip();
  input.on('error', (error) => gunzip.destroy(error));
  const iterator = input.pipe(gunzip)[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  async function consume(count, collect = true) {
    const result = [];
    let remaining = count;
    while (remaining) {
      if (!pending.length) {
        const next = await iterator.next();
        if (next.done) throw new Error('Truncated tar archive');
        pending = next.value;
      }
      const taken = Math.min(remaining, pending.length);
      if (collect) result.push(pending.subarray(0, taken));
      pending = pending.subarray(taken);
      remaining -= taken;
    }
    return collect ? Buffer.concat(result) : null;
  }
  const entries = new Map();
  let nextPax = {};
  let nextName;
  let nextLink;
  let total = 0;
  try {
    for (let count = 0; count < 100_000; count++) {
      const header = await consume(512);
      if (header.every((value) => value === 0)) {
        if (Object.keys(nextPax).length || nextName !== undefined || nextLink !== undefined)
          throw new Error('Orphan tar metadata');
        const second = await consume(512);
        if (!second.every((value) => value === 0)) throw new Error('Invalid tar end marker');
        let padding = pending.length;
        if (!pending.every((value) => value === 0))
          throw new Error('Unexpected data after tar end');
        for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
          padding += chunk.length;
          if (padding > 1024 * 1024 || !chunk.every((value) => value === 0))
            throw new Error('Unexpected trailing tar data');
        }
        break;
      }
      const expected = tarNumber(header.subarray(148, 156));
      let checksum = 0;
      for (let index = 0; index < 512; index++)
        checksum += index >= 148 && index < 156 ? 32 : header[index];
      if (checksum !== expected) throw new Error('Invalid tar header checksum');
      const type = String.fromCharCode(header[156] || 48);
      const size = tarNumber(header.subarray(124, 136));
      total += size;
      if (size > 2 * 1024 ** 3 || total > 4 * 1024 ** 3)
        throw new Error('Tar exceeds extraction limits');
      if (['x', 'g', 'L', 'K'].includes(type)) {
        if (size > 1024 * 1024) throw new Error('Tar metadata exceeds limit');
        const value = await consume(size);
        await consume((512 - (size % 512)) % 512, false);
        if (type === 'x') {
          if (Object.keys(nextPax).length) throw new Error('Ambiguous repeated PAX metadata');
          nextPax = parsePax(value);
        } else if (type === 'g') {
          const fields = parsePax(value);
          if (['path', 'linkpath', 'size'].some((key) => key in fields))
            throw new Error('Unsupported global PAX path override');
        } else if (type === 'L') {
          if (nextName !== undefined) throw new Error('Ambiguous repeated tar filename');
          nextName = tarString(value);
        } else {
          if (nextLink !== undefined) throw new Error('Ambiguous repeated tar link name');
          nextLink = tarString(value);
        }
        continue;
      }
      const prefix = tarString(header.subarray(345, 500));
      const rawName = tarString(header.subarray(0, 100));
      const name = archiveName(
        nextPax.path ?? nextName ?? (prefix ? `${prefix}/${rawName}` : rawName),
      );
      if (nextPax.size !== undefined && Number(nextPax.size) !== size)
        throw new Error('Unsupported PAX size override');
      const link = nextPax.linkpath ?? nextLink ?? tarString(header.subarray(157, 257));
      nextPax = {};
      nextName = undefined;
      nextLink = undefined;
      if (!['0', '1', '2', '5'].includes(type)) throw new Error('Unsupported archive member type');
      if (name !== '.' || type !== '5') {
        if (name === '.' || entries.has(name))
          throw new Error('Duplicate or invalid archive member');
        entries.set(name, { type, link });
      }
      await consume(size + ((512 - (size % 512)) % 512), false);
      if (count === 99_999) throw new Error('Too many archive members');
    }
    if (!entries.size) throw new Error('Empty archive');
    for (const [name, entry] of entries) {
      let parent = path.posix.dirname(name);
      while (parent !== '.') {
        if (entries.has(parent) && entries.get(parent).type !== '5')
          throw new Error('Archive member has a non-directory parent');
        parent = path.posix.dirname(parent);
      }
      if (entry.type === '1' || entry.type === '2') {
        if (
          !entry.link ||
          path.posix.isAbsolute(entry.link) ||
          /[\\\x00-\x1f\x7f]/.test(entry.link)
        )
          throw new Error('Unsafe archive link');
        const target = path.posix.normalize(
          entry.type === '2' ? path.posix.join(path.posix.dirname(name), entry.link) : entry.link,
        );
        if (
          target === '..' ||
          target.startsWith('../') ||
          !entries.has(target) ||
          !['0', '5'].includes(entries.get(target).type)
        )
          throw new Error('Archive link escapes or points to another link');
      }
    }
    return entries;
  } finally {
    input.destroy();
    gunzip.destroy();
  }
}

async function verifyCli(packagePath, release) {
  const manifest = await json(await packageFile(packagePath, 'codex-package.json'));
  if (
    manifest.layoutVersion !== 1 ||
    manifest.version !== release.version ||
    manifest.target !== release.target ||
    manifest.entrypoint !== 'bin/codex' ||
    manifest.resourcesDir !== 'codex-resources' ||
    manifest.pathDir !== 'codex-path'
  )
    throw new Error('Codex package manifest mismatch');
  const executable = await packageFile(packagePath, 'bin/codex');
  await packageFile(packagePath, 'bin/codex-code-mode-host');
  await packageFile(packagePath, 'codex-path/rg');
  const resources = await containedPath(packagePath, path.join(packagePath, 'codex-resources'));
  if (!(await stat(resources)).isDirectory()) throw new Error('Missing Codex resource directory');
  if (
    (await command(executable, ['--version'], { timeout: 20_000 })) !==
    `codex-cli ${release.version}`
  )
    throw new Error('Codex executable version mismatch');
}

export async function stageCli(root) {
  root = path.resolve(root);
  let architecture = process.arch;
  if (process.platform === 'darwin' && architecture === 'x64') {
    try {
      if (
        (await command('/usr/sbin/sysctl', ['-n', 'sysctl.proc_translated'], { timeout: 5000 })) ===
        '1'
      )
        architecture = 'arm64';
    } catch {
      /* Native Intel has no translation flag. */
    }
  }
  const target = platformTarget(process.platform, architecture);
  const metadata = await fetchJson(`${RELEASES}/channels/latest`);
  const version = metadata.tag_name?.replace(/^rust-v/, '');
  if (!STABLE.test(version || '') || metadata.prerelease || metadata.draft)
    throw new Error('Codex latest channel is not stable');
  const current = await inspectManagedPackage(root, 'cli');
  if (current && compareVersions(version, current.version) <= 0)
    return { ...current, changed: false };
  const name = `codex-package-${target}.tar.gz`;
  const assets = metadata.assets?.filter((asset) => asset.name === name) || [];
  if (assets.length !== 1 || !/^sha256:[a-f\d]{64}$/i.test(assets[0].digest || ''))
    throw new Error('Codex package lacks verified SHA256');
  const url = `${RELEASES}/releases/${version}/${name}`;
  if (assets[0].browser_download_url !== url) throw new Error('Unexpected Codex package URL');
  const release = { version, target, url, sha256: assets[0].digest.slice(7).toLowerCase() };
  const releases = path.join(root, 'releases');
  await mkdir(releases, { recursive: true, mode: 0o700 });
  const packagePath = path.join(releases, `cli-${version}-${target}`);
  if (await exists(packagePath)) {
    if ((await lstat(packagePath)).isSymbolicLink())
      throw new Error('CLI release directory must not be a symlink');
    const marker = await json(await packageFile(packagePath, MARKER));
    if (
      marker.kind !== 'cli' ||
      marker.version !== version ||
      marker.sha256 !== release.sha256 ||
      marker.target !== target
    )
      throw new Error('Staged Codex digest mismatch');
    await verifyCli(packagePath, release);
    return { version, packagePath, changed: true };
  }
  const temporary = await mkdtemp(path.join(releases, '.cli-'));
  try {
    const archive = path.join(temporary, 'archive.tar.gz');
    await command(
      'curl',
      [
        '--fail',
        '--silent',
        '--show-error',
        '--location',
        '--proto',
        '=https',
        '--proto-redir',
        '=https',
        '--connect-timeout',
        '10',
        '--max-time',
        '300',
        '--max-filesize',
        String(1024 ** 3),
        '--output',
        archive,
        url,
      ],
      { timeout: 310_000 },
    );
    if ((await stat(archive)).size > 1024 ** 3 || (await digest(archive)) !== release.sha256)
      throw new Error('Codex archive SHA256 mismatch');
    await validateTar(archive);
    const extracted = path.join(temporary, 'package');
    await mkdir(extracted, { mode: 0o700 });
    await command(
      'tar',
      ['-xzf', archive, '-C', extracted, '--no-same-owner', '--no-same-permissions'],
      { timeout: 120_000 },
    );
    await verifyCli(extracted, release);
    await atomicJson(path.join(extracted, MARKER), { kind: 'cli', ...release });
    await rename(extracted, packagePath);
    await syncDirectory(releases);
    return { version, packagePath, changed: true };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function switchPackage(root, kind, packagePath) {
  const link = path.join(root, `current-${kind}`);
  await currentPackage(root, kind);
  if (packagePath === null) {
    await rm(link, { force: true });
    await syncDirectory(root);
    return;
  }
  const marker = await json(path.join(packagePath, MARKER));
  if (marker.kind !== kind) throw new Error('Cannot select an unowned package');
  const relative = path.relative(
    await realpath(path.join(root, 'releases')),
    await realpath(packagePath),
  );
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Cannot select package outside managed releases');
  const temporary = `${link}.${randomUUID()}.tmp`;
  await symlink(packagePath, temporary);
  await rename(temporary, link);
  await syncDirectory(root);
}

export async function acquireLock(filename) {
  try {
    await mkdir(filename, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await json(path.join(filename, 'owner.json')).catch(() => null);
    // Named account/config operations need explicit worker recovery even if a
    // signal prevented their finally block from recording requiresRecovery.
    if (owner?.requiresRecovery || typeof owner?.reason === 'string') return false;
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (probe) {
      if (probe.code !== 'ESRCH') return false;
    }
    const reclaim = path.join(filename, 'reclaim');
    try {
      await mkdir(reclaim);
    } catch (claim) {
      if (['EEXIST', 'ENOENT'].includes(claim.code)) return false;
      throw claim;
    }
    const observed = await json(path.join(filename, 'owner.json')).catch(() => null);
    if (observed?.pid !== owner.pid || observed?.createdAt !== owner.createdAt) {
      await rm(reclaim, { recursive: true, force: true });
      return false;
    }
    try {
      process.kill(observed.pid, 0);
      await rm(reclaim, { recursive: true });
      return false;
    } catch (probe) {
      if (probe.code !== 'ESRCH') {
        await rm(reclaim, { recursive: true });
        return false;
      }
    }
    const abandoned = `${filename}.abandoned-${randomUUID()}`;
    await rename(filename, abandoned);
    await rm(abandoned, { recursive: true });
    try {
      await mkdir(filename, { mode: 0o700 });
    } catch (retry) {
      if (retry.code === 'EEXIST') return false;
      throw retry;
    }
  }
  await atomicJson(path.join(filename, 'owner.json'), {
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
  return true;
}

async function backupConfiguration(root, config) {
  const destination = path.join(
    root,
    'backups',
    `update-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const hashes = {};
  async function copy(source, relative) {
    if (!(await exists(source))) return;
    const info = await lstat(source);
    if (info.isSymbolicLink())
      throw new Error('Configuration backup encountered a symlink; update deferred');
    const target = path.join(destination, relative);
    if (info.isDirectory()) {
      await mkdir(target, { recursive: true, mode: 0o700 });
      for (const entry of await readdir(source))
        await copy(path.join(source, entry), path.join(relative, entry));
    } else if (info.isFile()) {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
      await chmod(target, 0o600);
      const handle = await open(target, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(path.dirname(target));
      hashes[relative] = await digest(target);
    } else throw new Error('Unsupported configuration backup file');
  }
  await copy(path.join(root, 'config.json'), 'config.json');
  await copy(path.join(root, 'data'), 'data');
  await copy(path.join(root, 'router-state.json'), 'router-state.json');
  const nativeHome = config.codexHome || path.join(homedir(), '.codex');
  if (await exists(nativeHome)) {
    for (const entry of await readdir(nativeHome)) {
      if (entry.endsWith('.toml') || entry === 'auth.json')
        await copy(path.join(nativeHome, entry), path.join('native-codex', entry));
    }
  }
  await atomicJson(path.join(destination, 'SHA256.json'), hashes);
  return destination;
}

async function control(config, action, extra = {}) {
  const response = await fetch(`http://127.0.0.1:${config.ports.gateway}/__setup_control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': config.clientApiKey },
    body: JSON.stringify({ action, ...extra }),
    signal: AbortSignal.timeout(action === 'reload' ? 90_000 : 130_000),
  });
  if (!response.ok) throw new Error(`Runtime ${action} failed (HTTP ${response.status})`);
  return response.json();
}

async function smoke(config) {
  const probe = await control(config, 'probe');
  if (probe.ok !== true || !Number.isInteger(probe.modelCount) || probe.modelCount < 1)
    throw new Error('Updated runtime has no eligible models');
  if (config.updates.smokeModel) {
    const model = config.updates.smokeModel;
    if (!probe.models?.includes(model))
      throw new Error('Configured smoke model is absent from model catalog');
    const response = await fetch(`http://127.0.0.1:${config.ports.router}/responses`, {
      method: 'POST',
      signal: AbortSignal.timeout(120_000),
      headers: { 'content-type': 'application/json', 'x-api-key': config.clientApiKey },
      body: JSON.stringify({
        model,
        instructions: 'Reply exactly OK. Do not use tools.',
        input: [{ role: 'user', content: 'Reply OK' }],
        stream: true,
        store: false,
      }),
    });
    if (!response.ok) throw new Error(`Configured smoke request failed (HTTP ${response.status})`);
    let text = '';
    for await (const chunk of response.body) {
      text += Buffer.from(chunk).toString();
      if (Buffer.byteLength(text) > 2 * 1024 * 1024)
        throw new Error('Smoke response exceeds limit');
    }
    const events = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => {
        try {
          return JSON.parse(line.slice(5).trim());
        } catch {
          return {};
        }
      });
    if (
      !events.some((event) => event.type === 'response.completed') ||
      events.some((event) => ['error', 'response.failed'].includes(event.type))
    )
      throw new Error('Configured smoke response did not complete');
  }
  return { modelCount: probe.modelCount ?? null, inference: Boolean(config.updates.smokeModel) };
}

export async function runUpdate(
  root,
  { checkOnly = false, force = false, recoverOnly = false } = {},
) {
  root = path.resolve(root);
  const config = await json(path.join(root, 'config.json'));
  if (config.schemaVersion !== 1 || path.resolve(config.root) !== root)
    throw new Error('Invalid setup configuration');
  const stateDirectory = path.join(root, 'maintenance-state');
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const lock = path.join(stateDirectory, 'update.lock');
  if (!(await acquireLock(lock))) return { outcome: 'already-running' };
  const maintenance = path.join(root, 'maintenance.lock');
  const journalPath = path.join(stateDirectory, 'transaction.json');
  let previousStatus = await json(path.join(stateDirectory, 'status.json')).catch(() => ({}));
  let ownsMaintenance = false;
  let transaction = null;
  let preserveMaintenance = false;
  async function record(value) {
    const result = {
      lastFailure: previousStatus.lastFailure ?? null,
      ...value,
      checkedAt: new Date().toISOString(),
    };
    await atomicJson(path.join(stateDirectory, 'status.json'), result);
    previousStatus = result;
    return result;
  }
  async function rollback(journal) {
    await switchPackage(root, 'proxy', journal.oldProxy);
    await switchPackage(root, 'cli', journal.oldCli);
    if (journal.proxyChanged) await control(config, 'reload');
    // OAuth tokens may have rotated. Backups are never restored automatically.
    await smoke(config);
    await rm(journalPath);
    await syncDirectory(stateDirectory);
  }
  try {
    if (await exists(journalPath)) {
      if (checkOnly) return await record({ outcome: 'recovery-required' });
      if (!(await acquireLock(maintenance))) return await record({ outcome: 'maintenance-busy' });
      ownsMaintenance = true;
      transaction = await json(journalPath);
      await control(config, 'drain', { timeoutMs: 30_000 });
      await rollback(transaction);
      transaction = null;
      await rm(maintenance, { recursive: true });
      ownsMaintenance = false;
      if (recoverOnly) return await record({ outcome: 'recovered', lastFailure: null });
    }
    if (recoverOnly) return await record({ outcome: 'no-recovery-needed' });
    if (!checkOnly && !force && !config.updates.enabled)
      return await record({ outcome: 'disabled' });
    const currentProxy = await currentPackage(root, 'proxy');
    const currentCli = await currentPackage(root, 'cli');
    if (!currentProxy) throw new Error('Install the initial proxy before enabling updates');
    if (checkOnly) {
      const selected = selectProxyRelease(await fetchJson(REGISTRY), {
        delayHours: config.updates.delayHours,
        currentVersion: currentProxy.version,
      });
      let cli = null;
      if (config.updates.cli) {
        const metadata = await fetchJson(`${RELEASES}/channels/latest`);
        const version = metadata.tag_name?.replace(/^rust-v/, '');
        if (!STABLE.test(version || '') || metadata.prerelease || metadata.draft)
          throw new Error('Invalid CLI latest channel');
        if (!currentCli || compareVersions(version, currentCli.version) > 0) cli = version;
      }
      return await record({
        outcome: 'checked',
        currentProxy: currentProxy.version,
        availableProxy: selected?.version ?? null,
        currentCli: currentCli?.version ?? null,
        availableCli: cli,
      });
    }
    const proxy = await stageProxy(root, {
      delayHours: config.updates.delayHours,
      currentVersion: currentProxy.version,
    });
    const cli = config.updates.cli ? await stageCli(root) : null;
    if (!proxy.changed && !cli?.changed)
      return await record({
        outcome: 'up-to-date',
        proxy: proxy.version,
        cli: cli?.version ?? currentCli?.version ?? null,
      });
    const failure = previousStatus.lastFailure;
    const plannedCli = cli?.version ?? currentCli?.version ?? null;
    if (
      !force &&
      failure?.proxy === proxy.version &&
      failure?.cli === plannedCli &&
      Date.now() - Date.parse(failure.at) < 24 * 3_600_000
    ) {
      return await record({
        outcome: 'retry-delayed',
        proxy: proxy.version,
        cli: plannedCli,
        retryAt: new Date(Date.parse(failure.at) + 24 * 3_600_000).toISOString(),
      });
    }
    if (!(await acquireLock(maintenance))) return await record({ outcome: 'maintenance-busy' });
    ownsMaintenance = true;
    await control(config, 'drain', { timeoutMs: 30_000 });
    transaction = {
      oldProxy: currentProxy.packagePath,
      oldCli: currentCli?.packagePath ?? null,
      proxyChanged: proxy.changed,
      cliChanged: Boolean(cli?.changed),
      backup: null,
      nextProxy: proxy.version,
      nextCli: plannedCli,
    };
    await atomicJson(journalPath, transaction);
    if (proxy.changed) await control(config, 'pause');
    const backup = await backupConfiguration(root, config);
    transaction.backup = backup;
    await atomicJson(journalPath, transaction);
    if (proxy.changed) await switchPackage(root, 'proxy', proxy.packagePath);
    if (cli?.changed) await switchPackage(root, 'cli', cli.packagePath);
    if (proxy.changed) await control(config, 'reload');
    const probe = await smoke(config);
    await rm(journalPath);
    await syncDirectory(stateDirectory);
    transaction = null;
    return await record({
      outcome: 'updated',
      proxy: proxy.version,
      cli: plannedCli,
      backup,
      lastFailure: null,
      ...probe,
    });
  } catch (error) {
    if (transaction) {
      try {
        const lastFailure = {
          proxy: transaction.nextProxy,
          cli: transaction.nextCli,
          at: new Date().toISOString(),
        };
        await rollback(transaction);
        transaction = null;
        return await record({ outcome: 'rolled-back', reason: error.message, lastFailure });
      } catch (rollbackError) {
        preserveMaintenance = true;
        return await record({
          outcome: 'rollback-failed',
          reason: rollbackError.message,
          updateError: error.message,
        });
      }
    }
    return await record({ outcome: 'failed', reason: error.message });
  } finally {
    if (ownsMaintenance && !preserveMaintenance)
      await rm(maintenance, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
