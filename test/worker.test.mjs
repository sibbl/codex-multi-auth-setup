import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dispatch, initialize } from '../src/worker.mjs';
import { run } from '../src/process.mjs';

const integrity = `sha512-${Buffer.alloc(64, 3).toString('base64')}`;

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-worker-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    schemaVersion: 1,
    root,
    appDir: root,
    node: process.execPath,
    mode: 'local',
    strategy: 'sequential',
    ports: { gateway: 64512, router: 64513, client: 64514, tunnel: 64515 },
    clientApiKey: 'fixture-secret-key-private',
    codexHome: path.join(root, 'native'),
    updates: { delayHours: 48, intervalHours: 1, cli: false, enabled: false },
  };
  const pool = path.join(root, 'data/multi-auth/accounts.json');
  async function packageFor(version = '1.0.0') {
    const wrapper = path.join(root, 'releases', `proxy-${version}`);
    const packagePath = path.join(wrapper, 'node_modules/codex-multi-auth');
    await fs.mkdir(path.join(packagePath, 'scripts'), { recursive: true });
    await fs.writeFile(
      path.join(packagePath, 'scripts/codex-app-router.js'),
      'export const fixture = true;\n',
    );
    await fs.writeFile(
      path.join(packagePath, 'package.json'),
      JSON.stringify({ name: 'codex-multi-auth', version, type: 'module' }),
    );
    const lock = JSON.stringify({ packages: {} });
    await fs.writeFile(path.join(wrapper, 'package-lock.json'), lock);
    await fs.writeFile(
      path.join(packagePath, '.setup-release.json'),
      JSON.stringify({
        kind: 'proxy',
        version,
        integrity,
        lockSha256: createHash('sha256').update(lock).digest('hex'),
      }),
    );
    return packagePath;
  }
  async function save(value = config) {
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(value));
  }
  return { root, config, pool, packageFor, save };
}

test('failed initial staging leaves a resumable checkpoint; resume preserves accounts and original key', async (t) => {
  const setup = await fixture(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('fixture network unavailable');
  });
  await assert.rejects(initialize(setup.config), /network unavailable/);
  const checkpoint = JSON.parse(await fs.readFile(path.join(setup.root, 'config.json')));
  assert.equal(checkpoint.initialized, false);
  await fs.writeFile(setup.pool, '{"token":"keep-existing-account"}');
  const selected = await setup.packageFor();
  fetchMock.mock.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          'dist-tags': { latest: '1.0.0' },
          time: { '1.0.0': '2026-01-01T00:00:00Z' },
          versions: {
            '1.0.0': {
              name: 'codex-multi-auth',
              version: '1.0.0',
              dist: {
                integrity,
                tarball: 'https://registry.npmjs.org/codex-multi-auth/-/codex-multi-auth-1.0.0.tgz',
              },
            },
          },
        }),
      ),
  );
  const resumed = await dispatch('resume', setup.root);
  assert.equal(resumed.proxyVersion, '1.0.0');
  assert.equal(resumed.initialized, false);
  assert.equal(await fs.readlink(path.join(setup.root, 'current-proxy')), selected);
  assert.equal(JSON.parse(await fs.readFile(setup.pool)).token, 'keep-existing-account');
  assert.equal(
    JSON.parse(await fs.readFile(path.join(setup.root, 'config.json'))).clientApiKey,
    setup.config.clientApiKey,
  );
  const manifest = JSON.parse(await fs.readFile(path.join(resumed.backup, 'manifest.json')));
  assert.equal(manifest.reason, 'resume installation');
  const calls = fetchMock.mock.callCount();
  const repeated = await dispatch('resume', setup.root);
  assert.equal(repeated.proxyVersion, '1.0.0');
  assert.equal(
    fetchMock.mock.callCount(),
    calls,
    'verified existing package should not require network',
  );
});

test('resume refuses completed installations and unowned package links', async (t) => {
  const setup = await fixture(t);
  await setup.save({ ...setup.config, initialized: true });
  await assert.rejects(dispatch('resume', setup.root), /unfinished installation/);
  await setup.save({ ...setup.config, initialized: false });
  const outside = path.join(setup.root, 'unowned');
  await fs.mkdir(outside);
  await fs.mkdir(path.join(setup.root, 'releases'));
  await fs.symlink(outside, path.join(setup.root, 'current-proxy'));
  await assert.rejects(dispatch('resume', setup.root), /outside managed releases/);
  assert.equal(await fs.readlink(path.join(setup.root, 'current-proxy')), outside);
});

async function recoveryFixture(t, { failReload = false } = {}) {
  const setup = await fixture(t);
  const actions = [];
  await fs.mkdir(path.dirname(setup.pool), { recursive: true });
  await fs.writeFile(setup.pool, '{"token":"existing-current-token"}');
  const server = http.createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const { action } = JSON.parse(text);
    actions.push(action);
    assert.equal(request.headers['x-api-key'], setup.config.clientApiKey);
    if (action === 'reload' && failReload) return response.writeHead(500).end('{}');
    if (action === 'reload') await fs.writeFile(setup.pool, '{"token":"newly-refreshed-token"}');
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ready: true, activeRequests: 0 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  setup.config.ports.gateway = server.address().port;
  await setup.save({ ...setup.config, initialized: true });
  const lock = path.join(setup.root, 'maintenance.lock');
  await fs.mkdir(lock);
  const owner = {
    pid: 99999999,
    createdAt: '2026-01-01T00:00:00Z',
    reason: 'upstream login',
    requiresRecovery: true,
  };
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner));
  return { ...setup, actions, lock, owner };
}

test('explicit recovery reloads a dead-owner account lock, preserving refreshed OAuth', async (t) => {
  const setup = await recoveryFixture(t);
  await assert.rejects(dispatch('recover', setup.root), /explicit confirmation/);
  const result = await dispatch('recover', setup.root, { confirmed: true });
  assert.equal(result.outcome, 'recovered');
  assert.equal(result.oauthRestored, false);
  assert.deepEqual(setup.actions, ['drain', 'reload']);
  assert.equal(JSON.parse(await fs.readFile(setup.pool)).token, 'newly-refreshed-token');
  await assert.rejects(fs.stat(setup.lock), { code: 'ENOENT' });
});

test('recovery refuses live owners and keeps locks when reload fails', async (t) => {
  const setup = await recoveryFixture(t, { failReload: true });
  await fs.writeFile(
    path.join(setup.lock, 'owner.json'),
    JSON.stringify({ ...setup.owner, pid: process.pid }),
  );
  await assert.rejects(dispatch('recover', setup.root, { confirmed: true }), /still running/);
  assert.deepEqual(setup.actions, []);
  await fs.writeFile(path.join(setup.lock, 'owner.json'), JSON.stringify(setup.owner));
  await assert.rejects(dispatch('recover', setup.root, { confirmed: true }), /reload returned 500/);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(setup.lock, 'owner.json'))).requiresRecovery,
    true,
  );
  await assert.rejects(fs.stat(path.join(setup.lock, 'recovery.lock')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(setup.pool)).token, 'existing-current-token');
});

test('interrupted known account operation can recover without a failure flag, unknown owners cannot', async (t) => {
  const setup = await recoveryFixture(t);
  await fs.writeFile(
    path.join(setup.lock, 'owner.json'),
    JSON.stringify({ ...setup.owner, requiresRecovery: false, reason: 'unknown operation' }),
  );
  await assert.rejects(
    dispatch('recover', setup.root, { confirmed: true }),
    /known account\/config/,
  );
  await fs.writeFile(
    path.join(setup.lock, 'owner.json'),
    JSON.stringify({ ...setup.owner, requiresRecovery: false }),
  );
  const result = await dispatch('recover', setup.root, { confirmed: true });
  assert.equal(result.outcome, 'recovered');
  assert.deepEqual(setup.actions, ['drain', 'reload']);
});

test('doctor includes native/version inspection and reads the updater status location', async (t) => {
  const setup = await fixture(t);
  await setup.save({ ...setup.config, initialized: false });
  await fs.symlink(await setup.packageFor(), path.join(setup.root, 'current-proxy'));
  await fs.mkdir(path.join(setup.root, 'maintenance-state'));
  await fs.writeFile(
    path.join(setup.root, 'maintenance-state/status.json'),
    '{"outcome":"rolled-back"}',
  );
  await fs.writeFile(path.join(setup.root, 'update-status.json'), '{"outcome":"wrong-location"}');
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify({ ready: true, ok: true, modelCount: 1 })),
  );
  const report = await dispatch('doctor', setup.root);
  assert.equal(report.updates.outcome, 'rolled-back');
  assert.equal(report.checks.find((check) => check.name === 'Proxy version').detail, '1.0.0');
  assert.equal(report.checks.find((check) => check.name === 'Installation').ok, false);
  assert.ok(report.checks.some((check) => check.name === 'Native Codex daemon'));
  assert.equal(report.config.clientApiKey, undefined);
});

test('account process observes its PID durably recorded before command execution', async (t) => {
  const setup = await fixture(t);
  await setup.save({ ...setup.config, initialized: false });
  const scripts = path.join(setup.root, 'current-proxy/scripts');
  await fs.mkdir(scripts, { recursive: true });
  await fs.writeFile(
    path.join(scripts, 'codex-multi-auth.js'),
    `
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.resolve(process.env.CODEX_MULTI_AUTH_DIR, '../..');
    const owner = JSON.parse(fs.readFileSync(path.join(root, 'maintenance.lock/owner.json'), 'utf8'));
    process.stdout.write(JSON.stringify({ owner: owner.pid, recorded: owner.childPid, actual: process.pid }));
  `,
  );
  const result = await dispatch('accounts', setup.root, {
    command: 'proxy',
    args: ['check'],
    interactive: false,
  });
  const report = JSON.parse(result.stdout);
  assert.equal(report.owner, process.pid);
  assert.equal(report.recorded, report.actual);
  assert.notEqual(report.actual, process.pid);
});

test('live orphan account child blocks recovery even when its worker owner is gone', async (t) => {
  const setup = await recoveryFixture(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const closed = once(child, 'close');
  t.after(async () => {
    child.kill();
    await closed;
  });
  await fs.writeFile(
    path.join(setup.lock, 'owner.json'),
    JSON.stringify({ ...setup.owner, childPid: child.pid }),
  );
  await assert.rejects(
    dispatch('recover', setup.root, { confirmed: true }),
    /Upstream account child is still running/,
  );
  assert.deepEqual(setup.actions, []);
  assert.equal(JSON.parse(await fs.readFile(setup.pool)).token, 'existing-current-token');
});

test('spawn bookkeeping failure terminates child and spawn errors skip callback', async (t) => {
  const setup = await fixture(t);
  let childPid;
  await assert.rejects(
    run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      onSpawn(pid) {
        childPid = pid;
        throw new Error('fixture bookkeeping failed');
      },
    }),
    /bookkeeping failed/,
  );
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  let called = false;
  await assert.rejects(
    run(path.join(setup.root, 'missing-executable'), [], {
      onSpawn() {
        called = true;
      },
    }),
    { code: 'ENOENT' },
  );
  assert.equal(called, false);
});
