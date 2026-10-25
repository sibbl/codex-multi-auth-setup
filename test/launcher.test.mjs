import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installLauncher } from '../src/launcher.mjs';
import { run } from '../src/process.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "setup-launcher's "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const client = {
    clientRoot: path.join(root, 'profile'),
    clientAppDir: path.join(root, 'manager'),
    clientNode: process.execPath,
  };
  await fs.mkdir(path.join(client.clientAppDir, 'bin'), { recursive: true });
  await fs.writeFile(
    path.join(client.clientAppDir, 'bin/codex-ma-setup.mjs'),
    'process.stdout.write(JSON.stringify(process.argv.slice(2)));\nif (process.argv.includes("--fail")) process.exitCode = 7;\n',
  );
  const options = { home: root, shell: '/bin/zsh', pathEnv: '/usr/bin:/bin', zdotdir: '' };
  return { root, client, options };
}

test('global launcher works outside installation, preserves arguments, profile overrides and exit status', async (t) => {
  const { root, client, options } = await fixture(t);
  const launcher = await installLauncher(client, options);
  const cwd = path.join(root, 'another directory');
  await fs.mkdir(cwd);
  const invoke = (args, extra = {}) =>
    run(launcher.path, args, { cwd, env: { PATH: '/usr/bin:/bin' }, ...extra });
  const args = ['proxy', '--', '--client-root', 'literal argument', "quote ' and $(never run)"];
  assert.deepEqual(JSON.parse((await invoke(args)).stdout), [
    '--client-root',
    client.clientRoot,
    ...args,
  ]);
  const override = ['stats', '--client-root', '/another profile', '--json'];
  assert.deepEqual(JSON.parse((await invoke(override)).stdout), override);
  assert.equal((await invoke(['--fail'], { check: false })).code, 7);
  assert.equal((await fs.stat(launcher.path)).mode & 0o777, 0o755);
});

test('launcher and shell changes are backed up and repeated setup does not duplicate PATH entries', async (t) => {
  const { root, client, options } = await fixture(t);
  const launcherPath = path.join(root, '.local', 'bin', 'codex-ma-setup');
  const shellConfig = path.join(root, '.zshrc');
  await fs.mkdir(path.dirname(launcherPath), { recursive: true });
  await fs.writeFile(launcherPath, 'previous launcher');
  await fs.writeFile(shellConfig, '# previous shell config');
  const installed = await installLauncher(client, options);
  const manifest = JSON.parse(await fs.readFile(path.join(installed.backup, 'manifest.json')));
  for (const [filename, expected] of [
    [launcherPath, 'previous launcher'],
    [shellConfig, '# previous shell config'],
  ]) {
    const source = manifest.sources.find((entry) => entry.source === filename);
    assert.equal(await fs.readFile(path.join(installed.backup, source.snapshot), 'utf8'), expected);
  }
  const shellContent = await fs.readFile(shellConfig, 'utf8');
  assert.ok(shellContent.startsWith('# previous shell config\n'));
  assert.equal(installed.pathUpdated, true);
  const again = await installLauncher(client, options);
  assert.equal(again.backup, null);
  assert.equal(again.pathUpdated, false);
  assert.equal(await fs.readFile(shellConfig, 'utf8'), shellContent);
});

for (const [shell, relative, line] of [
  ['/bin/bash', '.bashrc', 'export PATH='],
  ['/bin/zsh', '.zshrc', 'export PATH='],
  ['/usr/bin/fish', '.config/fish/config.fish', 'fish_add_path --prepend -- '],
]) {
  test(`adds terminal PATH configuration for ${path.basename(shell)}`, async (t) => {
    const { root, client, options } = await fixture(t);
    const installed = await installLauncher(client, { ...options, shell, xdgConfigHome: '' });
    assert.equal(installed.shellConfig, path.join(root, relative));
    assert.ok((await fs.readFile(installed.shellConfig, 'utf8')).includes(line));
    assert.equal(installed.warning, undefined);
  });
}

test('existing PATH requires no shell configuration and unknown shells report manual PATH step', async (t) => {
  const { root, client, options } = await fixture(t);
  const installed = await installLauncher(client, {
    ...options,
    shell: '/bin/unknown-shell',
    pathEnv: `${path.join(root, '.local', 'bin')}:/usr/bin:/bin`,
  });
  assert.equal(installed.shellConfig, undefined);
  assert.equal(installed.warning, undefined);
  const unknown = await installLauncher(client, { ...options, shell: '/bin/unknown-shell' });
  assert.match(unknown.warning, /unknown-shell.*PATH/);
  assert.equal(unknown.pathUpdated, false);
});

test('shell configuration symlinks retain target and snapshot its previous contents', async (t) => {
  const { root, client, options } = await fixture(t);
  const target = path.join(root, 'dotfiles', 'zshrc');
  const shellConfig = path.join(root, '.zshrc');
  await fs.mkdir(path.dirname(target));
  await fs.writeFile(target, '# shared config\n');
  await fs.symlink(target, shellConfig);
  const installed = await installLauncher(client, options);
  assert.equal(await fs.readlink(shellConfig), target);
  const manifest = JSON.parse(await fs.readFile(path.join(installed.backup, 'manifest.json')));
  const realTarget = await fs.realpath(target);
  const source = manifest.sources.find((entry) => entry.source === realTarget);
  assert.equal(
    await fs.readFile(path.join(installed.backup, source.snapshot), 'utf8'),
    '# shared config\n',
  );
});

test('bash login and nonlogin profiles expose command and preserve the existing login file', async (t) => {
  const { root, client, options } = await fixture(t);
  const login = path.join(root, '.bash_login');
  await fs.writeFile(login, '# existing login configuration\n', { mode: 0o640 });
  const installed = await installLauncher(client, { ...options, shell: '/bin/bash' });
  assert.deepEqual(installed.shellConfigs, [path.join(root, '.bashrc'), login]);
  const env = { HOME: root, PATH: '/usr/bin:/bin' };
  const command = 'codex-ma-setup --version';
  const interactive = await run(
    '/bin/bash',
    ['--noprofile', '--norc', '-ic', '. "$1"; ' + command, 'bash', installed.shellConfig],
    { env },
  );
  // Source the selected login profile explicitly to isolate system-wide /etc/profile changes.
  const loginResult = await run(
    '/bin/bash',
    ['--noprofile', '-lc', '. "$1"; ' + command, 'bash', login],
    {
      env,
    },
  );
  for (const result of [interactive, loginResult])
    assert.deepEqual(JSON.parse(result.stdout), ['--client-root', client.clientRoot, '--version']);
  assert.equal((await fs.stat(login)).mode & 0o777, 0o640);
  assert.ok((await fs.readFile(login, 'utf8')).startsWith('# existing login configuration\n'));
  const manifest = JSON.parse(await fs.readFile(path.join(installed.backup, 'manifest.json')));
  const source = manifest.sources.find((entry) => entry.source === login);
  assert.equal(
    await fs.readFile(path.join(installed.backup, source.snapshot), 'utf8'),
    '# existing login configuration\n',
  );
  assert.equal((await installLauncher(client, { ...options, shell: '/bin/bash' })).backup, null);
  await assert.rejects(fs.access(path.join(root, '.bash_profile')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, '.profile')), { code: 'ENOENT' });
});

test('CLI umask preserves executable and existing shell modes without repeated backups', async (t) => {
  const { root, client, options } = await fixture(t);
  const shellConfig = path.join(root, '.zshrc');
  await fs.writeFile(shellConfig, '# existing shell configuration\n', { mode: 0o640 });
  const source = `
    import { installLauncher } from ${JSON.stringify(new URL('../src/launcher.mjs', import.meta.url).href)};
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const { client, options } = JSON.parse(input);
    process.umask(0o077);
    const first = await installLauncher(client, options);
    const second = await installLauncher(client, options);
    process.stdout.write(JSON.stringify({ first, second }));
  `;
  const result = JSON.parse(
    (
      await run(process.execPath, ['--input-type=module', '-e', source], {
        input: JSON.stringify({ client, options }),
      })
    ).stdout,
  );
  assert.equal((await fs.stat(result.first.path)).mode & 0o777, 0o755);
  assert.equal((await fs.stat(shellConfig)).mode & 0o777, 0o640);
  assert.equal(result.second.backup, null);
  assert.equal(result.second.pathUpdated, false);
});
