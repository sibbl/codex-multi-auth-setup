import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  planServices,
  updateCrontab,
  installServices,
  startService,
  stopService,
  serviceStatus,
} from '../src/services.mjs';

const config = {
  root: '/srv/storage/codex',
  appDir: '/srv/storage/codex/app',
  node: '/usr/bin/node',
  clientRoot: '/home/example/.codex/setup',
  clientNode: '/opt/node/bin/node',
  updates: { enabled: true, delayHours: 48, intervalHours: 1 },
};
const linux = { platform: 'linux', home: '/home/example', uid: 1000 };

test('Linux user services use absolute arguments and a separate update timer', () => {
  const plan = planServices(config, linux);
  assert.equal(plan.files.length, 3);
  const runtime = plan.files[0].content;
  assert.match(
    runtime,
    /ExecStart="\/usr\/bin\/node" "\/srv\/storage\/codex\/app\/src\/runtime.mjs" "--root" "\/srv\/storage\/codex"/,
  );
  assert.match(runtime, /UMask=0077/);
  assert.ok(
    plan.commands.every((command) => command[0] === 'systemctl' && command[1] === '--user'),
  );
  assert.match(plan.files[2].content, /OnUnitActiveSec=1h/);
});

test('System installation explicitly selects a non-root user and protected mount dependency', () => {
  const plan = planServices(
    { ...config, systemService: true, serviceUser: 'example', serviceGroup: 'users' },
    linux,
  );
  assert.match(plan.files[0].content, /User=example\nGroup=users/);
  assert.match(plan.files[0].content, /RequiresMountsFor="\/srv\/storage\/codex"/);
  assert.equal(plan.files[0].path.startsWith('/etc/systemd/system/'), true);
  assert.ok(
    plan.commands.every((command) => command.slice(0, 3).join(' ') === 'sudo -n systemctl'),
  );
  assert.throws(
    () => planServices({ ...config, systemService: true, serviceUser: 'root' }, linux),
    /non-root/,
  );
});

test('Client service runs forwarder with client root and never installs updates', () => {
  const plan = planServices(config, { ...linux, role: 'client' });
  assert.equal(plan.files.length, 1);
  assert.match(
    plan.files[0].content,
    /"\/opt\/node\/bin\/node".*forwarder.mjs" "--root" "\/home\/example\/.codex\/setup"/,
  );
  assert.equal(plan.updates, false);
});

test('Unit values preserve spaces and literal percent, dollar and quote characters', () => {
  const plan = planServices(
    { ...config, root: '/srv/a %i $HOME "b"', appDir: '/srv/a %i $HOME "b"/app' },
    linux,
  );
  assert.match(plan.files[0].content, /WorkingDirectory="\/srv\/a %%i \$HOME \\"b\\""/);
  assert.match(plan.files[0].content, /ExecStart=.*\$\$HOME/);
  assert.throws(
    () => planServices({ ...config, root: '/srv/bad\nExecStart=bad' }, linux),
    /Invalid/,
  );
});

test('LaunchAgents render valid XML and keep updater periodic, runtime persistent', async () => {
  const root = '/Users/example/a & b <c> "d"';
  const plan = planServices(
    { ...config, root },
    { platform: 'darwin', home: '/Users/example', uid: 501 },
  );
  assert.match(plan.files[0].content, /a &amp; b &lt;c&gt; &quot;d&quot;/);
  assert.match(plan.files[0].content, /<key>KeepAlive<\/key>/);
  assert.doesNotMatch(plan.files[1].content, /<key>KeepAlive<\/key>/);
  assert.match(plan.files[1].content, /<key>StartInterval<\/key><integer>3600/);
  if (process.platform === 'darwin') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-plist-'));
    try {
      for (const [index, file] of plan.files.entries()) {
        const target = path.join(directory, `${index}.plist`);
        await fs.writeFile(target, file.content);
        assert.match(
          execFileSync('/usr/bin/plutil', ['-lint', target], { encoding: 'utf8' }),
          /OK/,
        );
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

test('Cron rendering quotes shell metacharacters and escapes cron percent syntax', () => {
  const plan = planServices(
    {
      ...config,
      root: "/srv/it's $HOME;100%",
      scheduler: 'cron',
      updates: { enabled: true, intervalHours: 6 },
    },
    linux,
  );
  assert.match(plan.cronLine, /^0 \*\/6 /);
  assert.match(plan.cronLine, /'\/srv\/it'\\''s \$HOME;100\\%'/);
  assert.equal(plan.files.length, 1);
  assert.throws(
    () => planServices({ ...config, scheduler: 'cron', updates: { intervalHours: 5 } }, linux),
    /divide 24/,
  );
});

test('Cron add, update, remove roundtrip preserves unrelated jobs and detects malformed sections', () => {
  const original = '# Other work\n17 2 * * * /usr/bin/backup\n';
  const added = updateCrontab(original, 'our-job', '0 * * * * /bin/true');
  const updated = updateCrontab(added, 'our-job', '0 */2 * * * /bin/true');
  assert.equal(updated.match(/# BEGIN/g).length, 1);
  assert.equal(updateCrontab(updated, 'our-job', null), original);
  assert.equal(updateCrontab(original, 'our-job', null), original);
  assert.throws(() => updateCrontab('# BEGIN our-job\n', 'our-job', null), /Malformed/);
  assert.throws(
    () => updateCrontab('# END our-job\n# BEGIN our-job\n', 'our-job', null),
    /Malformed/,
  );
});

test('Installation snapshots existing service and complete crontab before any mutation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-services-'));
  const fixture = {
    ...config,
    root: path.join(directory, 'root'),
    appDir: path.join(directory, 'app'),
    scheduler: 'cron',
  };
  const options = { platform: 'linux', home: path.join(directory, 'home'), uid: 1000 };
  const plan = planServices(fixture, options);
  await fs.mkdir(path.dirname(plan.files[0].path), { recursive: true });
  await fs.writeFile(plan.files[0].path, 'original service');
  const previous = '# original cron\n0 4 * * * /usr/bin/backup\n';
  let installedCron;
  const calls = [];
  options.execute = async (command) => {
    calls.push(command);
    if (command.join(' ') === 'crontab -l') return { code: 0, stdout: previous, stderr: '' };
    if (command[0] === 'crontab') installedCron = await fs.readFile(command[1], 'utf8');
    return { code: 0, stdout: '', stderr: '' };
  };
  try {
    const result = await installServices(fixture, options);
    const manifest = JSON.parse(
      await fs.readFile(path.join(result.backupPath, 'manifest.json'), 'utf8'),
    );
    const original = manifest.files.find((file) => file.path === plan.files[0].path);
    assert.equal(
      await fs.readFile(path.join(result.backupPath, original.file), 'utf8'),
      'original service',
    );
    assert.equal(await fs.readFile(path.join(result.backupPath, 'crontab.txt'), 'utf8'), previous);
    assert.equal((await fs.stat(result.backupPath)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(result.backupPath, 'crontab.txt'))).mode & 0o777, 0o600);
    assert.ok(installedCron.startsWith(previous));
    assert.match(await fs.readFile(plan.files[0].path, 'utf8'), /runtime.mjs/);
    assert.ok(calls.some((command) => command.includes('restart')));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Unavailable manager fails before creating files, even with cron selected', async () => {
  await assert.rejects(
    installServices(
      { ...config, scheduler: 'cron' },
      { ...linux, execute: async () => ({ code: 1, stderr: 'No bus' }) },
    ),
    /Cron schedules updates only/,
  );
});

test('Failed activation restores files, crontab and previously active runtime', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-service-rollback-'));
  const fixture = {
    ...config,
    root: path.join(directory, 'root'),
    appDir: path.join(directory, 'app'),
    scheduler: 'cron',
  };
  const options = { platform: 'linux', home: path.join(directory, 'home'), uid: 1000 };
  const plan = planServices(fixture, options);
  await fs.mkdir(path.dirname(plan.files[0].path), { recursive: true });
  await fs.writeFile(plan.files[0].path, 'original service', { mode: 0o640 });
  let crontab = '# other jobs\n7 3 * * * /usr/bin/backup\n';
  const originalCron = crontab;
  const calls = [];
  options.execute = async (command) => {
    calls.push(command);
    if (command.join(' ') === 'crontab -l') return { code: 0, stdout: crontab, stderr: '' };
    if (command[0] === 'crontab') crontab = await fs.readFile(command[1], 'utf8');
    if (command.includes('is-active') || command.includes('is-enabled'))
      return { code: command.at(-1).endsWith('.timer') ? 3 : 0, stdout: '', stderr: '' };
    if (command.includes('restart'))
      return { code: 1, stdout: '', stderr: 'injected activation failure' };
    return { code: 0, stdout: '', stderr: '' };
  };
  try {
    await assert.rejects(
      installServices(fixture, options),
      /injected activation failure.*Previous service configuration restored/,
    );
    assert.equal(await fs.readFile(plan.files[0].path, 'utf8'), 'original service');
    assert.equal((await fs.stat(plan.files[0].path)).mode & 0o777, 0o640);
    assert.equal(crontab, originalCron);
    assert.ok(
      calls.some((command) => command.includes('start') && command.at(-1) === `${plan.id}.service`),
    );
    assert.equal(
      calls.some((command) => command.includes('start') && command.at(-1).endsWith('.timer')),
      false,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Lifecycle commands use exact instance ID and status respects exit code', async () => {
  const calls = [];
  const execute = async (command) => {
    calls.push(command);
    return { code: 0, stdout: 'active\n', stderr: '' };
  };
  await stopService(config, 'server', { ...linux, execute });
  await startService(config, 'server', { ...linux, execute });
  const status = await serviceStatus(config, { ...linux, execute });
  assert.equal(status.active, true);
  assert.equal(calls[0][2], 'stop');
  assert.equal(calls[1][2], 'start');
  assert.equal(calls[0][3], calls[1][3]);
});
