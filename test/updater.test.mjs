import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  symlink,
  stat,
} from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import {
  platformTarget,
  runUpdate,
  selectProxyRelease,
  stageProxy,
  validateTar,
  inspectManagedPackage,
} from '../src/updater.mjs';

const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const NOW = Date.parse('2026-10-17T10:00:00Z');

function registry(versions = ['1.0.0', '1.1.0']) {
  return {
    'dist-tags': { latest: versions.at(-1) },
    versions: Object.fromEntries(
      versions.map((version) => [
        version,
        {
          name: 'codex-multi-auth',
          version,
          dist: {
            integrity: INTEGRITY,
            tarball: `https://registry.npmjs.org/codex-multi-auth/-/codex-multi-auth-${version}.tgz`,
          },
        },
      ]),
    ),
    time: Object.fromEntries(versions.map((version) => [version, '2026-10-01T00:00:00Z'])),
  };
}

test('proxy delay applies to first installs and skips prerelease/deprecated/future versions', () => {
  const metadata = registry(['1.0.0', '1.1.0', '1.2.0', '2.0.0-beta.1', '2.0.0']);
  metadata.versions['1.1.0'].deprecated = 'withdrawn';
  metadata.time['1.2.0'] = '2026-10-16T10:00:00Z';
  metadata.time['2.0.0'] = '2026-10-18T10:00:00Z';
  assert.equal(selectProxyRelease(metadata, { now: NOW }).version, '1.0.0');
  assert.equal(selectProxyRelease(metadata, { now: NOW, delayHours: 0 }).version, '1.2.0');
  assert.equal(selectProxyRelease(metadata, { now: NOW, currentVersion: '1.3.0' }), null);
  assert.throws(() => selectProxyRelease(metadata, { now: NOW, delayHours: -1 }), /delay/);
});

test('release selection enforces 48-hour boundary, latest ceiling, and integrity', () => {
  const metadata = registry(['1.0.0', '1.1.0', '1.2.0']);
  metadata['dist-tags'].latest = '1.1.0';
  metadata.time['1.1.0'] = '2026-10-15T10:00:00Z';
  assert.equal(selectProxyRelease(metadata, { now: NOW }).version, '1.1.0');
  assert.equal(selectProxyRelease(metadata, { now: NOW - 1 }).version, '1.0.0');
  metadata.versions['1.1.0'].dist.integrity = 'sha1-bad';
  assert.throws(() => selectProxyRelease(metadata, { now: NOW }), /SHA512/);
  const onlyNew = registry(['1.0.0']);
  onlyNew.time['1.0.0'] = '2026-10-17T09:00:00Z';
  assert.throws(() => selectProxyRelease(onlyNew, { now: NOW }), /at least 48/);
});

test('CLI platform mapping covers Linux/macOS x64/arm64 and refuses unsupported targets', () => {
  assert.equal(platformTarget('linux', 'arm64'), 'aarch64-unknown-linux-musl');
  assert.equal(platformTarget('linux', 'x64'), 'x86_64-unknown-linux-musl');
  assert.equal(platformTarget('darwin', 'arm64'), 'aarch64-apple-darwin');
  assert.equal(platformTarget('darwin', 'x64'), 'x86_64-apple-darwin');
  assert.throws(() => platformTarget('win32', 'x64'), /Unsupported/);
});

function tar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const content = Buffer.from(entry.content || '');
    header.write(entry.name, 0, 100);
    header.write('0000755\0', 100, 8);
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    header.fill(32, 148, 156);
    header.write(entry.type || '0', 156, 1);
    if (entry.link) header.write(entry.link, 157, 100);
    header.write('ustar\0', 257, 6);
    const sum = header.reduce((total, value) => total + value, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    chunks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

test('tar scanner accepts files/directories and internal links', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-tar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'safe.tgz');
  await writeFile(
    archive,
    tar([
      { name: 'bin/', type: '5' },
      { name: 'bin/codex', content: 'test' },
      { name: 'codex', type: '2', link: 'bin/codex' },
    ]),
  );
  const entries = await validateTar(archive);
  assert.equal(entries.get('bin/codex').type, '0');
  assert.equal(entries.get('codex').link, 'bin/codex');
});

test('tar scanner rejects traversal, special files, duplicates, and link ancestors', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-tar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'unsafe.tgz');
  const cases = [
    [{ name: '../escape', content: 'bad' }],
    [{ name: '/absolute', content: 'bad' }],
    [{ name: 'device', type: '3' }],
    [{ name: 'same' }, { name: 'same' }],
    [
      { name: 'dir', type: '2', link: '..' },
      { name: 'dir/file', content: 'bad' },
    ],
    [
      { name: 'target', content: 'ok' },
      { name: 'link', type: '2', link: '/target' },
    ],
    [
      { name: 'target', content: 'ok' },
      { name: 'link', type: '2', link: '../target' },
    ],
  ];
  for (const entries of cases) {
    await writeFile(archive, tar(entries));
    await assert.rejects(validateTar(archive));
  }
});

async function fixture(t, { failProbe = false, enabled = true } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codex-updater-')));
  const metadata = registry();
  const pool = path.join(root, 'data/multi-auth/accounts.json');
  await mkdir(path.dirname(pool), { recursive: true });
  await writeFile(pool, JSON.stringify({ token: 'before-refresh' }));
  const nativeHome = path.join(root, 'native');
  await mkdir(nativeHome);
  await writeFile(path.join(nativeHome, 'config.toml'), 'model = "example"\n');
  await writeFile(path.join(nativeHome, 'auth.json'), '{"token":"native-private"}');
  async function packageFor(version) {
    const wrapper = path.join(root, 'releases', `proxy-${version}`);
    const packagePath = path.join(wrapper, 'node_modules/codex-multi-auth');
    await mkdir(path.join(packagePath, 'scripts'), { recursive: true });
    await writeFile(
      path.join(packagePath, 'scripts/codex-app-router.js'),
      'export const fixture = true;\n',
    );
    await writeFile(
      path.join(packagePath, 'package.json'),
      JSON.stringify({ type: 'module', name: 'codex-multi-auth', version }),
    );
    const lock = JSON.stringify({
      packages: { 'node_modules/codex-multi-auth': { version, integrity: INTEGRITY } },
    });
    await writeFile(path.join(wrapper, 'package-lock.json'), lock);
    await writeFile(
      path.join(packagePath, '.setup-release.json'),
      JSON.stringify({
        kind: 'proxy',
        version,
        integrity: INTEGRITY,
        lockSha256: createHash('sha256').update(lock).digest('hex'),
      }),
    );
    return packagePath;
  }
  const oldPackage = await packageFor('1.0.0');
  const newPackage = await packageFor('1.1.0');
  await symlink(oldPackage, path.join(root, 'current-proxy'));
  const actions = [];
  let reloads = 0;
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { action } = JSON.parse(body);
    actions.push(action);
    assert.equal(request.headers['x-api-key'], 'fixture-private-key');
    await stat(path.join(root, 'maintenance.lock'));
    let result = { ok: true };
    if (action === 'reload') {
      reloads++;
      await writeFile(pool, JSON.stringify({ token: 'after-refresh' }));
    }
    if (action === 'probe')
      result = {
        ok: true,
        modelCount: failProbe && reloads === 1 ? 0 : 1,
        models: ['available-model'],
      };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = {
    schemaVersion: 1,
    root,
    node: process.execPath,
    codexHome: nativeHome,
    ports: { gateway: server.address().port },
    clientApiKey: 'fixture-private-key',
    updates: { enabled, delayHours: 48, cli: false },
  };
  await writeFile(path.join(root, 'config.json'), JSON.stringify(config));
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://registry.npmjs.org/codex-multi-auth')
      return new Response(JSON.stringify(metadata));
    return originalFetch(url, options);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, oldPackage, newPackage, actions, pool, config };
}

test('existing verified stage is reusable without activation or npm execution', async (t) => {
  const setup = await fixture(t);
  const staged = await stageProxy(setup.root, { delayHours: 48 });
  assert.equal(staged.version, '1.1.0');
  assert.equal(staged.packagePath, setup.newPackage);
  assert.equal(await readlink(path.join(setup.root, 'current-proxy')), setup.oldPackage);
});

test('check reports candidate without switching or blocking live runtime', async (t) => {
  const setup = await fixture(t, { enabled: false });
  const result = await runUpdate(setup.root, { checkOnly: true });
  assert.equal(result.outcome, 'checked');
  assert.equal(result.availableProxy, '1.1.0');
  assert.deepEqual(setup.actions, []);
  assert.equal(await readlink(path.join(setup.root, 'current-proxy')), setup.oldPackage);
});

test('successful update drains, pauses, backs up secrets privately, reloads and probes', async (t) => {
  const setup = await fixture(t);
  const result = await runUpdate(setup.root);
  assert.equal(result.outcome, 'updated', JSON.stringify(result));
  assert.deepEqual(setup.actions, ['drain', 'pause', 'reload', 'probe']);
  assert.equal(result.inference, false);
  assert.equal(await readlink(path.join(setup.root, 'current-proxy')), setup.newPackage);
  const saved = JSON.parse(
    await readFile(path.join(result.backup, 'data/multi-auth/accounts.json')),
  );
  assert.equal(saved.token, 'before-refresh');
  assert.equal(
    (await stat(path.join(result.backup, 'data/multi-auth/accounts.json'))).mode & 0o777,
    0o600,
  );
  await assert.rejects(stat(path.join(setup.root, 'maintenance.lock')), { code: 'ENOENT' });
});

test('failed probe restores program selection while retaining refreshed OAuth token', async (t) => {
  const setup = await fixture(t, { failProbe: true });
  const result = await runUpdate(setup.root);
  assert.equal(result.outcome, 'rolled-back', JSON.stringify(result));
  assert.equal(await readlink(path.join(setup.root, 'current-proxy')), setup.oldPackage);
  assert.equal(JSON.parse(await readFile(setup.pool)).token, 'after-refresh');
  assert.deepEqual(setup.actions, ['drain', 'pause', 'reload', 'probe', 'reload', 'probe']);
  await assert.rejects(stat(path.join(setup.root, 'maintenance-state/transaction.json')), {
    code: 'ENOENT',
  });
  const previousActions = [...setup.actions];
  assert.equal((await runUpdate(setup.root)).outcome, 'retry-delayed');
  assert.deepEqual(setup.actions, previousActions);
});

test('automatic disabled policy blocks scheduled run, explicit force runs maintenance', async (t) => {
  const setup = await fixture(t, { enabled: false });
  assert.equal((await runUpdate(setup.root)).outcome, 'disabled');
  assert.equal((await runUpdate(setup.root, { force: true })).outcome, 'updated');
});

test('live update lock excludes a concurrent run', async (t) => {
  const setup = await fixture(t);
  const lock = path.join(setup.root, 'maintenance-state/update.lock');
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  assert.equal((await runUpdate(setup.root)).outcome, 'already-running');
  assert.deepEqual(setup.actions, []);
  assert.ok((await readdir(lock)).includes('owner.json'));
});

test('account-maintenance recovery lock is never reclaimed automatically', async (t) => {
  const setup = await fixture(t);
  const lock = path.join(setup.root, 'maintenance.lock');
  await mkdir(lock);
  await writeFile(
    path.join(lock, 'owner.json'),
    JSON.stringify({ pid: 99999999, requiresRecovery: true }),
  );
  assert.equal((await runUpdate(setup.root)).outcome, 'maintenance-busy');
  assert.deepEqual(setup.actions, []);
  assert.ok((await readdir(lock)).includes('owner.json'));
  await writeFile(
    path.join(lock, 'owner.json'),
    JSON.stringify({ pid: 99999999, reason: 'upstream login' }),
  );
  assert.equal((await runUpdate(setup.root)).outcome, 'maintenance-busy');
  assert.deepEqual(setup.actions, []);
});

test('recoverOnly restores a journaled update without installing a new candidate', async (t) => {
  const setup = await fixture(t, { enabled: false });
  await rm(path.join(setup.root, 'current-proxy'));
  await symlink(setup.newPackage, path.join(setup.root, 'current-proxy'));
  const state = path.join(setup.root, 'maintenance-state');
  await mkdir(state);
  await writeFile(
    path.join(state, 'transaction.json'),
    JSON.stringify({
      oldProxy: setup.oldPackage,
      oldCli: null,
      proxyChanged: true,
      cliChanged: false,
    }),
  );
  const result = await runUpdate(setup.root, { recoverOnly: true });
  assert.equal(result.outcome, 'recovered', JSON.stringify(result));
  assert.equal(await readlink(path.join(setup.root, 'current-proxy')), setup.oldPackage);
  assert.deepEqual(setup.actions, ['drain', 'reload', 'probe']);
  await assert.rejects(stat(path.join(state, 'transaction.json')), { code: 'ENOENT' });
});

test('owned CLI verification refuses an executable symlink escaping its package', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codex-cli-bounds-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packagePath = path.join(root, 'releases/cli-fixture');
  await mkdir(path.join(packagePath, 'bin'), { recursive: true });
  await writeFile(
    path.join(packagePath, '.setup-release.json'),
    JSON.stringify({ kind: 'cli', version: '1.0.0', target: 'fixture-target' }),
  );
  await writeFile(
    path.join(packagePath, 'codex-package.json'),
    JSON.stringify({
      layoutVersion: 1,
      version: '1.0.0',
      target: 'fixture-target',
      entrypoint: 'bin/codex',
      resourcesDir: 'codex-resources',
      pathDir: 'codex-path',
    }),
  );
  await symlink(process.execPath, path.join(packagePath, 'bin/codex'));
  await symlink(packagePath, path.join(root, 'current-cli'));
  await assert.rejects(inspectManagedPackage(root, 'cli'), /escapes its release/);
  await rm(path.join(packagePath, '.setup-release.json'));
  const outside = path.join(root, 'outside-marker.json');
  await writeFile(outside, '{}');
  await symlink(outside, path.join(packagePath, '.setup-release.json'));
  await assert.rejects(inspectManagedPackage(root, 'cli'), /escapes its release/);
});
