import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { inspectDocker, installDockerManagement, renderDockerLauncher } from '../src/docker.mjs';

const execFileAsync = promisify(execFile);

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'setup-docker-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = path.join(root, 'docker.jsonl');
  const docker = path.join(root, 'fake docker');
  await writeFile(
    docker,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\\n');
if (args.includes('inspect')) {
  const format = args[args.indexOf('--format') + 1];
  if (format === '{{.State.Running}}') {
    process.stdout.write(process.env.FAKE_DOCKER_RUNNING || 'true');
  } else if (format === '{{.Image}}') {
    process.stdout.write('sha256:fixture');
  } else {
    process.exit(fs.existsSync(process.env.FAKE_DOCKER_COMPANION) ? 0 : 1);
  }
} else if (args[0] === 'run') {
  if (process.env.FAKE_DOCKER_LEAVE_COMPANION) {
    fs.writeFileSync(process.env.FAKE_DOCKER_COMPANION, 'running');
  }
  process.stdout.write('fixture maintenance result\\n');
  process.exit(Number(process.env.FAKE_DOCKER_RUN_EXIT || 0));
} else if (args[0] === 'exec') {
  process.stdout.write('fixture query result\\n');
} else if (args[0] === 'start') {
  process.exit(Number(process.env.FAKE_DOCKER_START_EXIT || 0));
} else if (args[0] === 'rm') {
  if (process.env.FAKE_DOCKER_REMOVE_EXIT) process.exit(Number(process.env.FAKE_DOCKER_REMOVE_EXIT));
  fs.rmSync(process.env.FAKE_DOCKER_COMPANION, { force: true });
}
`,
  );
  await chmod(docker, 0o700);
  const management = {
    type: 'docker',
    docker,
    container: 'router',
    node: '/usr/local/bin/node',
    entry: '/app/scripts/codex-multi-auth.js',
    codexHome: '/data/codex',
    accountDir: '/data/multi-auth',
    home: '/data',
    user: '1000:1000',
    launcher: path.join(root, 'codex-multi-auth'),
    identity: 'fixture-identity',
    stateRoot: path.join(root, 'docker-router'),
    ...overrides,
  };
  await writeFile(management.launcher, renderDockerLauncher(management));
  return {
    management,
    async run(args, extraEnv = {}) {
      let result;
      try {
        const output = await execFileAsync('/bin/sh', [management.launcher, ...args], {
          env: {
            ...process.env,
            FAKE_DOCKER_LOG: log,
            FAKE_DOCKER_COMPANION: path.join(root, 'companion'),
            ...extraEnv,
          },
          timeout: 10000,
        });
        result = { code: 0, ...output };
      } catch (error) {
        result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
      }
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
      return { ...result, calls };
    },
  };
}

function optionValues(args, ...names) {
  return args.flatMap((arg, index) => (names.includes(arg) ? [args[index + 1]] : []));
}

test('Docker launcher runs read-only queries in existing container without stopping service', async (t) => {
  for (const args of [
    ['status'],
    ['status', '--json'],
    ['list'],
    ['list', '--json'],
    ['--help'],
    ['-h'],
    ['--version'],
    ['-v'],
  ]) {
    await t.test(args.join(' '), async (t) => {
      const { management, run } = await fixture(t);
      const result = await run(args);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /fixture query result/);
      assert.equal(result.calls.length, 1);
      const [call] = result.calls;
      assert.equal(call[0], 'exec');
      assert.deepEqual(call.slice(-args.length - 3), [
        management.container,
        management.node,
        management.entry,
        ...args,
      ]);
      assert.ok(optionValues(call, '-e', '--env').includes('CODEX_HOME=/data/codex'));
      assert.ok(
        optionValues(call, '-e', '--env').includes('CODEX_MULTI_AUTH_DIR=/data/multi-auth'),
      );
    });
  }
});

test('Docker maintenance preserves existing data, image, user, and literal arguments', async (t) => {
  const { management, run } = await fixture(t);
  const args = ['remove', 'account with spaces;$(touch never-run)', '--force'];
  const result = await run(args);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /fixture maintenance result/);
  const stop = result.calls.findIndex((call) => call[0] === 'stop');
  const companion = result.calls.findIndex((call) => call[0] === 'run');
  const start = result.calls.findIndex((call) => call[0] === 'start');
  assert.ok(stop >= 0);
  assert.ok(companion > stop);
  assert.ok(start > companion);
  assert.ok(result.calls[stop].includes(management.container));
  assert.ok(result.calls[start].includes(management.container));
  const call = result.calls[companion];
  const backups = result.calls.filter((command) => command[0] === 'cp');
  assert.equal(backups.length, 2);
  assert.deepEqual(
    backups.map((command) => command[1]),
    ['router:/data/multi-auth', 'router:/data/codex'],
  );
  assert.ok(result.calls.indexOf(backups[0]) > stop);
  assert.ok(result.calls.indexOf(backups[1]) < companion);
  assert.ok(optionValues(call, '--volumes-from').includes(management.container));
  assert.ok(optionValues(call, '--user', '-u').includes(management.user));
  assert.ok(optionValues(call, '-e', '--env').includes('HOME=/data'));
  assert.ok(optionValues(call, '-e', '--env').includes('CODEX_HOME=/data/codex'));
  assert.ok(optionValues(call, '-e', '--env').includes('CODEX_MULTI_AUTH_DIR=/data/multi-auth'));
  assert.deepEqual(call.slice(-args.length - 3), [
    'sha256:fixture',
    management.node,
    management.entry,
    ...args,
  ]);
});

test('Docker maintenance failure restarts original router and preserves command exit code', async (t) => {
  const { management, run } = await fixture(t);
  const result = await run(['add', 'fixture account'], { FAKE_DOCKER_RUN_EXIT: '23' });
  assert.equal(result.code, 23, result.stderr);
  const companion = result.calls.findIndex((call) => call[0] === 'run');
  const start = result.calls.findIndex((call) => call[0] === 'start');
  assert.ok(companion >= 0);
  assert.ok(start > companion, 'Original router must restart even when account command fails');
  assert.ok(result.calls[start].includes(management.container));
});

test('Docker maintenance reports failed restart instead of claiming success', async (t) => {
  const { management, run } = await fixture(t);
  const result = await run(['remove', 'fixture account'], { FAKE_DOCKER_START_EXIT: '1' });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /restart.*proxy|proxy.*restart/i);
  assert.equal(
    (await stat(path.join(management.stateRoot, 'maintenance.lock'))).isDirectory(),
    true,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(management.stateRoot, 'maintenance.json'))).phase,
    'recovery-required',
  );
});

test('Docker launcher preserves argument boundaries when selecting safe query commands', async (t) => {
  const { run } = await fixture(t);
  const result = await run(['status --json']);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.calls.some((call) => call[0] === 'run'));
  assert.ok(!result.calls.some((call) => call[0] === 'exec'));
});

test('Docker cleanup failure keeps router stopped and lock held while account writer survives', async (t) => {
  const { management, run } = await fixture(t);
  const result = await run(['add', 'fixture account'], {
    FAKE_DOCKER_RUN_EXIT: '23',
    FAKE_DOCKER_LEAVE_COMPANION: '1',
    FAKE_DOCKER_REMOVE_EXIT: '1',
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /keeping proxy stopped/);
  assert.ok(result.calls.some((call) => call[0] === 'rm'));
  assert.ok(!result.calls.some((call) => call[0] === 'start'));
  assert.equal(
    (await stat(path.join(management.stateRoot, 'maintenance.lock'))).isDirectory(),
    true,
  );
});

function dockerTarget(installed) {
  return {
    async inspect() {
      return { home: '/home/fixture' };
    },
    async run(command, args) {
      if (command === 'sh') return { stdout: '/usr/bin/docker\n' };
      assert.equal(command, '/usr/bin/docker');
      if (args[0] === 'inspect') {
        return {
          stdout: JSON.stringify([
            {
              State: { Running: true },
              Config: { Cmd: ['node', '/app/scripts/codex-app-router.js'], User: '1000:1000' },
            },
          ]),
        };
      }
      assert.equal(args[0], 'exec');
      assert.equal(args[1], 'router');
      assert.equal(args.at(-1), '/app/scripts/codex-multi-auth.js');
      return { stdout: JSON.stringify(installed) };
    },
  };
}

test('Docker discovery uses existing container account directories and host launcher path', async () => {
  const installed = {
    node: '/usr/local/bin/node',
    codexHome: '/actual/codex',
    accountDir: '/actual/account-pool',
    home: '/actual/home',
    version: 'fixture',
  };
  const management = await inspectDocker(dockerTarget(installed), 'router');
  assert.equal(management.codexHome, installed.codexHome);
  assert.equal(management.accountDir, installed.accountDir);
  assert.equal(management.home, installed.home);
  assert.equal(management.node, installed.node);
  assert.equal(management.launcher, '/home/fixture/.local/bin/codex-multi-auth');
  assert.equal(management.user, '1000:1000');
});

test('Docker discovery rejects missing container data paths instead of assuming defaults', async () => {
  const installed = {
    node: '/usr/local/bin/node',
    codexHome: '/actual/codex',
    accountDir: '/actual/account-pool',
    home: '/actual/home',
  };
  for (const field of ['codexHome', 'accountDir', 'home']) {
    const incomplete = { ...installed };
    delete incomplete[field];
    await assert.rejects(inspectDocker(dockerTarget(incomplete), 'router'), /absolute path/);
  }
});

async function installationTarget(t, shell) {
  const root = await mkdtemp(path.join(os.tmpdir(), "setup docker path's-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: root,
    SHELL: `/bin/${shell}`,
    PATH: '/usr/bin:/bin',
    ZDOTDIR: path.join(root, 'zsh config'),
    XDG_CONFIG_HOME: path.join(root, 'xdg config'),
  };
  const discovery = dockerTarget({
    node: '/usr/local/bin/node',
    codexHome: '/existing/codex',
    accountDir: '/existing/multi-auth',
    home: '/existing/home',
  });
  const target = {
    async inspect() {
      return { home: root };
    },
    async run(command, args) {
      if (command === '/usr/bin/docker' || (command === 'sh' && args[1] === 'command -v docker'))
        return discovery.run(command, args);
      return execFileAsync(command, args, { env });
    },
    async exists(filename) {
      try {
        await lstat(filename);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    },
    async write(filename, content, mode) {
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, content, { mode });
    },
  };
  return { root, env, target };
}

test('Docker installation configures Bash globally, backs up symlink and content, and stays idempotent', async (t) => {
  const { root, env, target } = await installationTarget(t, 'bash');
  const original = '# existing interactive shell configuration\n';
  const dotfile = path.join(root, 'bash interactive');
  const rc = path.join(root, '.bashrc');
  await writeFile(dotfile, original);
  await symlink(dotfile, rc);
  await writeFile(path.join(root, '.bash_profile'), '# existing login shell configuration\n');

  const config = await installDockerManagement(target, 'router');
  assert.equal((await lstat(rc)).isSymbolicLink(), true);
  assert.equal(await readlink(rc), dotfile);
  const modified = await readFile(dotfile, 'utf8');
  assert.ok(modified.startsWith(original));
  const { stdout } = await execFileAsync(
    '/bin/bash',
    ['--noprofile', '-c', '. "$HOME/.bashrc"; command -v codex-multi-auth'],
    { env },
  );
  assert.equal(stdout.trim(), config.launcher);
  const loginResult = await execFileAsync(
    '/bin/bash',
    ['--noprofile', '-c', '. "$HOME/.bash_profile"; command -v codex-multi-auth'],
    { env },
  );
  assert.equal(loginResult.stdout.trim(), config.launcher);

  const backupRoot = path.join(config.stateRoot, 'backups');
  const [backupName] = await readdir(backupRoot);
  const backup = path.join(backupRoot, backupName);
  assert.equal((await lstat(path.join(backup, '1-link'))).isSymbolicLink(), true);
  assert.equal(await readlink(path.join(backup, '1-link')), dotfile);
  assert.equal(await readFile(path.join(backup, '1-content'), 'utf8'), original);
  assert.equal((await stat(backup)).mode & 0o777, 0o700);

  await installDockerManagement(target, 'router');
  assert.equal(await readFile(dotfile, 'utf8'), modified);
  assert.equal((await lstat(rc)).isSymbolicLink(), true);
});

test('Docker installation writes Zsh PATH through configured ZDOTDIR', async (t) => {
  const { env, target } = await installationTarget(t, 'zsh');
  const config = await installDockerManagement(target, 'router');
  const rc = path.join(env.ZDOTDIR, '.zshrc');
  const content = await readFile(rc, 'utf8');
  assert.match(content, /export PATH=/);
  const { stdout } = await execFileAsync(
    '/bin/sh',
    ['-c', '. "$ZDOTDIR/.zshrc"; command -v codex-multi-auth'],
    { env },
  );
  assert.equal(stdout.trim(), config.launcher);
});

test('Docker installation writes Fish PATH through configured XDG_CONFIG_HOME', async (t) => {
  const { env, target } = await installationTarget(t, 'fish');
  const config = await installDockerManagement(target, 'router');
  const rc = path.join(env.XDG_CONFIG_HOME, 'fish/config.fish');
  const content = await readFile(rc, 'utf8');
  assert.match(content, /fish_add_path --prepend -- /);
  const line = content.split('\n').find((value) => value.startsWith('fish_add_path'));
  const { stdout } = await execFileAsync(
    '/bin/sh',
    ['-c', `fish_add_path() { printf '%s' "$3"; }; ${line}`],
    { env },
  );
  assert.equal(stdout, path.dirname(config.launcher));
  await installDockerManagement(target, 'router');
  assert.equal(await readFile(rc, 'utf8'), content);
});

test('Docker rebind preserves verified proxy identity and launcher contents', async (t) => {
  const { env, target } = await installationTarget(t, 'bash');
  const initial = await installDockerManagement(target, 'router');
  target.config = { management: initial };
  const originalLauncher = await readFile(initial.launcher, 'utf8');
  const rebound = await installDockerManagement(target, 'router');
  assert.equal(rebound.identity, initial.identity);
  assert.equal(await readFile(rebound.launcher, 'utf8'), originalLauncher);
  const result = await execFileAsync(rebound.launcher, ['--setup-identity'], { env });
  assert.equal(result.stdout.trim(), initial.identity);
});

test('Docker rebind rejects mismatched identity before writing launcher', async (t) => {
  const { target } = await installationTarget(t, 'bash');
  const initial = await installDockerManagement(target, 'router');
  target.config = { management: initial };
  const changedLauncher = (await readFile(initial.launcher, 'utf8')).replace(
    initial.identity,
    'different-installation',
  );
  await writeFile(initial.launcher, changedLauncher);
  let writes = 0;
  target.write = async () => {
    writes++;
  };
  await assert.rejects(
    installDockerManagement(target, 'router'),
    /identity does not match.*no launcher replaced/,
  );
  assert.equal(writes, 0);
  assert.equal(await readFile(initial.launcher, 'utf8'), changedLauncher);
});
