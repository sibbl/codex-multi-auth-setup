import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClient, configure, recover } from '../src/installer.mjs';
import { run, shellQuote } from '../src/process.mjs';
import { Target } from '../src/target.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(project, 'bin', 'codex-ma-setup.mjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-profile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entry = path.join(root, 'upstream.mjs');
  const launcher = path.join(root, 'codex-multi-auth');
  await fs.writeFile(
    entry,
    'console.log(JSON.stringify({args:process.argv.slice(2),accounts:[{id:"existing"}]}));\n',
  );
  await fs.writeFile(
    launcher,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(entry)} "$@"\n`,
    { mode: 0o755 },
  );
  const management = {
    type: 'docker',
    docker: '/usr/bin/docker',
    container: 'existing-proxy',
    node: '/usr/local/bin/node',
    entry: '/app/scripts/codex-multi-auth.js',
    codexHome: '/data/codex',
    accountDir: '/data/multi-auth',
    home: '/root',
    user: '',
    launcher,
    identity: 'existing-proxy-identity',
    stateRoot: '/data/setup-state',
  };
  const profile = {
    mode: 'local',
    healthCheck: 'legacy',
    ports: { client: 64412, gateway: 64414 },
    management,
    codexHome: path.join(root, 'codex'),
  };
  const filename = path.join(root, 'forwarder.json');
  await fs.writeFile(filename, JSON.stringify(profile));
  return { root, profile, filename, management };
}

test('standalone forwarder is the single management profile and metadata stays out of persisted JSON', async (t) => {
  const { root, profile, filename } = await fixture(t);
  const loaded = await loadClient(root);
  assert.equal(loaded.configFile, filename);
  assert.equal(loaded.clientRoot, root);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded)), profile);
  await fs.writeFile(path.join(root, 'client.json'), '{}');
  await assert.rejects(loadClient(root), /exactly one active profile/);
  await fs.rm(filename);
  assert.equal((await loadClient(root)).configFile, path.join(root, 'client.json'));
});

test('stats and proxy JSON commands use existing Docker launcher without a managed server worker', async (t) => {
  const { root, profile, filename } = await fixture(t);
  const original = await fs.readFile(filename, 'utf8');
  for (const [args, expected] of [
    [
      ['stats', '--json'],
      ['status', '--json'],
    ],
    [
      ['proxy', '--', 'list', '--json', "quote ' $(never run)"],
      ['list', '--json', "quote ' $(never run)"],
    ],
  ]) {
    const output = await run(process.execPath, [cli, '--client-root', root, ...args], {
      cwd: os.tmpdir(),
    });
    assert.deepEqual(JSON.parse(output.stdout), { args: expected, accounts: [{ id: 'existing' }] });
    assert.match(output.stderr, /Forwarding/);
  }
  assert.equal(await fs.readFile(filename, 'utf8'), original);
  await assert.rejects(fs.access(path.join(root, 'client.json')), { code: 'ENOENT' });
  await fs.writeFile(filename, JSON.stringify({ ...profile, management: undefined }));
  const missing = await run(process.execPath, [cli, '--client-root', root, 'stats', '--json'], {
    check: false,
  });
  assert.equal(missing.code, 1);
  assert.match(missing.stdout + missing.stderr, /connect --container/);
});

test('external profiles reject managed operations and desktop changes keep same profile', async (t) => {
  const { root, profile, filename } = await fixture(t);
  await fs.mkdir(profile.codexHome);
  await fs.writeFile(path.join(profile.codexHome, 'config.toml'), 'model = "existing"\n');
  const original = await fs.readFile(filename, 'utf8');
  await configure(root, 'desktop');
  assert.match(
    await fs.readFile(path.join(profile.codexHome, 'config.toml'), 'utf8'),
    /openai_base_url = "http:\/\/127.0.0.1:64412"/,
  );
  assert.equal(await fs.readFile(filename, 'utf8'), original);
  await assert.rejects(recover(root), /managed installation/);
  for (const args of [
    ['updates', 'run'],
    ['codex', '--', '--version'],
  ]) {
    const output = await run(process.execPath, [cli, '--client-root', root, ...args], {
      check: false,
    });
    assert.equal(output.code, 1);
    assert.match(output.stdout + output.stderr, /managed installation|managed Codex CLI/);
  }
  await assert.rejects(fs.access(path.join(root, 'client.json')), { code: 'ENOENT' });
});

test('Docker management fallback verifies existing wrapper identity once and never replays actions', async (t) => {
  const { root, profile } = await fixture(t);
  const config = {
    ...profile,
    mode: 'ssh',
    clientRoot: root,
    ssh: { host: 'user@primary', fallbackHost: 'user@fallback', port: 22 },
  };
  const calls = [];
  let identity = profile.management.identity;
  const execute = async (_executable, args) => {
    const host = args.at(-2);
    const command = args.at(-1);
    const kind =
      command === "env 'true'"
        ? 'probe'
        : command.includes('--setup-identity')
          ? 'identity'
          : 'action';
    calls.push({ host, kind });
    if (kind === 'probe') return { code: host === config.ssh.host ? 255 : 0, stdout: '' };
    if (kind === 'identity') return { code: 0, stdout: `${identity}\n` };
    throw new Error('SSH response lost after action');
  };
  const target = new Target(config, execute);
  await assert.rejects(target.run(profile.management.launcher, ['status']), /response lost/);
  await assert.rejects(target.run(profile.management.launcher, ['list']), /response lost/);
  assert.equal(calls.filter(({ kind }) => kind === 'identity').length, 1);
  assert.equal(calls.filter(({ kind }) => kind === 'action').length, 2);
  identity = 'wrong-proxy';
  calls.length = 0;
  await assert.rejects(
    new Target(config, execute).run(profile.management.launcher, ['login']),
    /different installation/,
  );
  assert.equal(calls.filter(({ kind }) => kind === 'action').length, 0);
});
