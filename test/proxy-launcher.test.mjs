import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installProxyLauncher } from '../src/launcher.mjs';
import { run } from '../src/process.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('global proxy command uses existing managed accounts, maintenance and original arguments from any directory', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "setup-proxy-launcher's "));
  const root = path.join(home, 'server');
  const native = path.join(home, 'native-codex');
  const actions = [];
  const server = http.createServer(async (request, response) => {
    let input = '';
    for await (const chunk of request) input += chunk;
    assert.equal(request.headers['x-api-key'], 'private-proxy-launcher-test-key');
    const { action } = JSON.parse(input);
    actions.push(action);
    await fs.writeFile(path.join(root, 'paused.json'), JSON.stringify(action === 'pause'));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ready: true }));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'current-proxy', 'scripts'), { recursive: true });
  await fs.mkdir(path.join(root, 'data', 'multi-auth'), { recursive: true });
  await fs.mkdir(path.join(root, 'data', 'codex'), { recursive: true });
  await fs.mkdir(native);
  await fs.writeFile(path.join(native, 'auth.json'), '{"native":"untouched"}');
  await fs.writeFile(path.join(root, 'data', 'multi-auth', 'accounts.json'), '{"existing":true}');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const gateway = server.address().port;
  const available = [64412, 64413, 64415, 64416].filter((port) => port !== gateway);
  const config = {
    schemaVersion: 1,
    root,
    node: process.execPath,
    appDir: project,
    mode: 'local',
    strategy: 'hybrid',
    clientApiKey: 'private-proxy-launcher-test-key',
    initialized: true,
    codexHome: native,
    ports: { gateway, client: available[0], router: available[1], tunnel: available[2] },
    updates: { enabled: false, cli: false, delayHours: 48, intervalHours: 1 },
  };
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config));
  await fs.writeFile(path.join(root, 'current-proxy', 'package.json'), '{"type":"module"}');
  await fs.writeFile(
    path.join(root, 'current-proxy', 'scripts', 'codex-multi-auth.js'),
    `import { readFileSync } from 'node:fs';
if (!JSON.parse(readFileSync('paused.json'))) process.exit(8);
const owner = JSON.parse(readFileSync('maintenance.lock/owner.json'));
if (owner.reason !== 'upstream status' && owner.reason !== 'upstream (custom command)') process.exit(9);
if (process.argv.includes('--fail')) process.exit(7);
console.log(JSON.stringify({
  args: process.argv.slice(2),
  pool: process.env.CODEX_MULTI_AUTH_DIR,
  codexHome: process.env.CODEX_HOME,
  sync: process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI,
  strategy: process.env.CODEX_AUTH_SCHEDULING_STRATEGY,
  accounts: JSON.parse(readFileSync(process.env.CODEX_MULTI_AUTH_DIR + '/accounts.json')),
}));
`,
  );
  const launcher = await installProxyLauncher(config, {
    home,
    shell: '/bin/bash',
    pathEnv: '/usr/bin:/bin',
  });
  const args = ['status', '--json', '--root', '/unrelated', "quote ' and $(never run)"];
  const output = await run(launcher.path, args, {
    cwd: home,
    env: { PATH: '/usr/bin:/bin', CODEX_HOME: native, CODEX_MULTI_AUTH_DIR: '/unrelated' },
  });
  assert.deepEqual(JSON.parse(output.stdout), {
    args,
    pool: path.join(root, 'data', 'multi-auth'),
    codexHome: path.join(root, 'data', 'codex'),
    sync: '0',
    strategy: 'hybrid',
    accounts: { existing: true },
  });
  assert.deepEqual(actions, ['pause', 'reload']);
  assert.equal(await fs.readFile(path.join(native, 'auth.json'), 'utf8'), '{"native":"untouched"}');
  await assert.rejects(fs.access(path.join(root, 'maintenance.lock')), { code: 'ENOENT' });
  const failed = await run(launcher.path, ['status', '--fail'], { cwd: home, check: false });
  assert.equal(failed.code, 7);
  assert.deepEqual(actions, ['pause', 'reload', 'pause', 'reload']);
  await assert.rejects(fs.access(path.join(root, 'maintenance.lock')), { code: 'ENOENT' });
  const help = await run(launcher.path, [], { cwd: home });
  assert.deepEqual(JSON.parse(help.stdout).args, ['--help']);
  const snapshots = await fs.readdir(path.join(root, 'backups'));
  const manifests = await Promise.all(
    snapshots.map(async (name) =>
      JSON.parse(await fs.readFile(path.join(root, 'backups', name, 'manifest.json'), 'utf8')),
    ),
  );
  assert.equal(manifests.filter(({ reason }) => reason === 'upstream status').length, 2);
  assert.ok(
    manifests.some(({ sources }) =>
      sources.some(({ source }) => source.endsWith('/data/multi-auth')),
    ),
  );
});

test('proxy launcher replacement is backed up, executable and idempotent with shared shell PATH', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-proxy-backup-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const config = { root: path.join(home, 'server'), node: process.execPath, appDir: project };
  const filename = path.join(home, '.local', 'bin', 'codex-multi-auth');
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, '# previous proxy launcher\n');
  const options = { home, shell: '/bin/zsh', zdotdir: '', pathEnv: '/usr/bin:/bin' };
  const installed = await installProxyLauncher(config, options);
  const manifest = JSON.parse(await fs.readFile(path.join(installed.backup, 'manifest.json')));
  const previous = manifest.sources.find(({ source }) => source === filename);
  assert.equal(
    await fs.readFile(path.join(installed.backup, previous.snapshot), 'utf8'),
    '# previous proxy launcher\n',
  );
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o755);
  assert.equal(installed.pathUpdated, true);
  const again = await installProxyLauncher(config, options);
  assert.equal(again.backup, null);
  assert.equal(again.pathUpdated, false);
  const invalid = await run(
    process.execPath,
    [path.join(project, 'bin/codex-multi-auth.mjs'), '--root', 'relative', '--', 'status'],
    { check: false },
  );
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /absolute installation path/);
});
