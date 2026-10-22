import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { poolPaths, seedPoolHome, selectedPoolRoot, availablePools } from '../src/pools.mjs';
import { atomicJson, managementEnvironment } from '../src/config.mjs';

test('pool paths reject traversal and isolate account stores', () => {
  for (const name of ['../work', '', '-work', 'Work', 'work/x'])
    assert.throws(() => poolPaths('/tmp/base', name));
  const work = poolPaths('/tmp/base', 'work');
  const personal = poolPaths('/tmp/base', 'personal');
  assert.notEqual(work.codexHome, personal.codexHome);
  const env = (pool) =>
    managementEnvironment({ root: pool.serverRoot, node: process.execPath, strategy: 'hybrid' });
  assert.notEqual(env(work).CODEX_MULTI_AUTH_DIR, env(personal).CODEX_MULTI_AUTH_DIR);
});

test('default selection preserves legacy installs and explicit pool takes precedence', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pools-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  assert.equal(await selectedPoolRoot(base, undefined, 'stats'), base);
  await atomicJson(path.join(base, 'pools.json'), { schemaVersion: 1, defaultPool: 'personal' });
  assert.equal(
    await selectedPoolRoot(base, undefined, 'stats'),
    poolPaths(base, 'personal').clientRoot,
  );
  assert.equal(await selectedPoolRoot(base, 'work', 'stats'), poolPaths(base, 'work').clientRoot);
  assert.equal(await selectedPoolRoot(base, undefined, 'install'), base);
});

test('seed snapshots auth/config/history without sharing mutable files or live databases', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pool-seed-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source');
  const dest = path.join(base, 'dest');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'auth.json'), '{"token":"fixture"}', { mode: 0o644 });
  await fs.writeFile(path.join(source, 'config.toml'), '# config');
  await fs.writeFile(path.join(source, 'state.sqlite'), 'live database');
  await seedPoolHome(dest, source);
  assert.equal((await fs.stat(path.join(dest, 'auth.json'))).mode & 0o777, 0o600);
  await fs.writeFile(path.join(dest, 'auth.json'), 'changed');
  assert.match(await fs.readFile(path.join(source, 'auth.json'), 'utf8'), /fixture/);
  await assert.rejects(fs.stat(path.join(dest, 'state.sqlite')), { code: 'ENOENT' });
  await assert.rejects(seedPoolHome(dest, source), { code: 'EEXIST' });
  await fs.symlink('/tmp', path.join(source, 'skills'));
  await assert.rejects(seedPoolHome(path.join(base, 'unsafe'), source), /symlink/);
});

test('dashboard discovers ready and interrupted pools without exposing account credentials', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pool-menu-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await atomicJson(path.join(poolPaths(base, 'work').clientRoot, 'client.json'), {
    pending: false,
    clientApiKey: 'private-fixture',
  });
  await atomicJson(path.join(poolPaths(base, 'personal').clientRoot, 'client.json'), {
    pending: true,
  });
  await atomicJson(path.join(base, 'pools.json'), { schemaVersion: 1, defaultPool: 'work' });
  const pools = await availablePools(base);
  assert.deepEqual(
    pools.map(({ name, ready, default: standard }) => ({ name, ready, standard })),
    [
      { name: 'personal', ready: false, standard: false },
      { name: 'work', ready: true, standard: true },
    ],
  );
  assert.ok(!JSON.stringify(pools).includes('private-fixture'));
});
