import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const prefix = 'codex-multi-auth-setup';

function safe(value, label) {
  if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value))
    throw new Error(`Invalid ${label}`);
  return value;
}

function absolute(value, label) {
  safe(value, label);
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return value;
}

const xml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const unit = (value) =>
  `"${safe(String(value), 'unit argument').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
const execUnit = (value) => unit(value).replaceAll('$', () => '$$');
const shellQuote = (value) => `'${safe(String(value), 'cron argument').replaceAll("'", "'\\''")}'`;

function context(config, options = {}) {
  const role = options.role ?? 'server';
  if (!['server', 'client'].includes(role)) throw new Error('Invalid service role');
  const platform = options.platform ?? process.platform;
  if (!['linux', 'darwin'].includes(platform))
    throw new Error('Background services require Linux or macOS');
  const home = absolute(options.home ?? os.homedir(), 'home');
  const root = absolute(role === 'client' ? config.clientRoot : config.root, 'service root');
  const appDir = absolute(config.appDir, 'appDir');
  const node = absolute(
    role === 'client' ? (config.clientNode ?? config.node) : config.node,
    'node',
  );
  const uid = options.uid ?? process.getuid?.();
  if (!Number.isInteger(uid) || uid < 0) throw new Error('Numeric user ID required');
  const id = `${prefix}-${crypto.createHash('sha256').update(root).digest('hex').slice(0, 12)}-${role}`;
  const updates = role === 'server' && config.updates?.enabled === true;
  const intervalHours = config.updates?.intervalHours ?? 1;
  if (!Number.isFinite(intervalHours) || intervalHours <= 0 || intervalHours > 168)
    throw new Error('Update interval must be between 0 and 168 hours');
  const scheduler = config.scheduler ?? (platform === 'darwin' ? 'launchd' : 'systemd');
  if (!['cron', platform === 'darwin' ? 'launchd' : 'systemd'].includes(scheduler))
    throw new Error('Unsupported scheduler for this platform');
  if (scheduler === 'cron' && (!Number.isInteger(intervalHours) || 24 % intervalHours !== 0))
    throw new Error('Cron update interval must divide 24 hours exactly (1, 2, 3, 4, 6, 8, 12, 24)');
  const runtime =
    role === 'server'
      ? [node, path.join(appDir, 'src/runtime.mjs'), '--root', root]
      : [node, path.join(appDir, 'src/forwarder.mjs'), '--root', root];
  const updater = [node, path.join(appDir, 'src/updater.mjs'), '--root', root, '--apply'];
  return {
    role,
    platform,
    home,
    root,
    uid,
    id,
    updates,
    scheduler,
    intervalHours,
    runtime,
    updater,
    system: platform === 'linux' && config.systemService === true,
  };
}

function systemctl(ctx, ...args) {
  return ctx.system ? ['sudo', '-n', 'systemctl', ...args] : ['systemctl', '--user', ...args];
}

function plist(label, args, ctx, timer = false) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(label)}</string>\n<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>\n<key>WorkingDirectory</key><string>${xml(ctx.root)}</string>\n<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(ctx.home)}</string><key>PATH</key><string>${xml(`${path.dirname(args[0])}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</string></dict>\n<key>Umask</key><integer>63</integer>\n<key>RunAtLoad</key><true/>\n${timer ? `<key>StartInterval</key><integer>${Math.ceil(ctx.intervalHours * 3600)}</integer>` : '<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>10</integer>'}\n<key>StandardOutPath</key><string>${xml(path.join(ctx.root, 'logs', timer ? 'updates.log' : `${ctx.role}.log`))}</string>\n<key>StandardErrorPath</key><string>${xml(path.join(ctx.root, 'logs', timer ? 'updates-error.log' : `${ctx.role}-error.log`))}</string>\n</dict></plist>\n`;
}

/** Pure rendering; no file or service changes. Commands always use argv arrays. */
export function planServices(config, options = {}) {
  const ctx = context(config, options);
  const files = [];
  const removeFiles = [];
  const commands = [];
  const unload = [];
  if (ctx.platform === 'linux') {
    const dir = ctx.system ? '/etc/systemd/system' : path.join(ctx.home, '.config/systemd/user');
    let identity = '';
    if (ctx.system) {
      const username = safe(config.serviceUser ?? os.userInfo().username, 'serviceUser');
      if (username === 'root')
        throw new Error('Set serviceUser to a non-root account for system services');
      if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*[$]?$/.test(username)) throw new Error('Invalid service user');
      identity = `User=${username}\n`;
      if (config.serviceGroup) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*[$]?$/.test(config.serviceGroup))
          throw new Error('Invalid service group');
        identity += `Group=${config.serviceGroup}\n`;
      }
    }
    const service = (args, updater = false) =>
      `[Unit]\nDescription=Codex multi-account ${updater ? 'updates' : ctx.role}\nAfter=network-online.target\nWants=network-online.target\n${ctx.system ? `RequiresMountsFor=${unit(ctx.root)}\n` : ''}\n[Service]\nType=${updater ? 'oneshot' : 'simple'}\n${identity}WorkingDirectory=${unit(ctx.root)}\nEnvironment=${unit(`HOME=${ctx.home}`)}\nEnvironment=${unit(`PATH=${path.dirname(args[0])}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}\nExecStart=${args.map(execUnit).join(' ')}\nUMask=0077\n${updater ? 'TimeoutStartSec=45min\n' : 'Restart=on-failure\nRestartSec=5\nTimeoutStopSec=90\n'}\n[Install]\nWantedBy=${ctx.system ? 'multi-user.target' : 'default.target'}\n`;
    files.push({
      path: path.join(dir, `${ctx.id}.service`),
      content: service(ctx.runtime),
      mode: 0o644,
    });
    const updateService = path.join(dir, `${ctx.id}-update.service`);
    const timer = path.join(dir, `${ctx.id}-update.timer`);
    unload.push({
      path: timer,
      command: systemctl(ctx, 'disable', '--now', `${ctx.id}-update.timer`),
    });
    if (ctx.updates && ctx.scheduler === 'systemd') {
      files.push({ path: updateService, content: service(ctx.updater, true), mode: 0o644 });
      files.push({
        path: timer,
        mode: 0o644,
        content: `[Unit]\nDescription=Check Codex releases automatically\n\n[Timer]\nOnBootSec=5min\nOnUnitActiveSec=${ctx.intervalHours}h\nRandomizedDelaySec=60\nUnit=${ctx.id}-update.service\n\n[Install]\nWantedBy=timers.target\n`,
      });
    } else removeFiles.push(timer, updateService);
    commands.push(
      systemctl(ctx, 'daemon-reload'),
      systemctl(ctx, 'enable', `${ctx.id}.service`),
      systemctl(ctx, 'restart', `${ctx.id}.service`),
    );
    if (ctx.updates && ctx.scheduler === 'systemd')
      commands.push(systemctl(ctx, 'enable', '--now', `${ctx.id}-update.timer`));
  } else {
    const dir = path.join(ctx.home, 'Library/LaunchAgents');
    const runtimePath = path.join(dir, `${ctx.id}.plist`);
    const updatePath = path.join(dir, `${ctx.id}-update.plist`);
    unload.push({
      path: runtimePath,
      command: ['launchctl', 'bootout', `gui/${ctx.uid}`, runtimePath],
    });
    unload.push({
      path: updatePath,
      command: ['launchctl', 'bootout', `gui/${ctx.uid}`, updatePath],
    });
    files.push({ path: runtimePath, content: plist(ctx.id, ctx.runtime, ctx), mode: 0o600 });
    commands.push(['launchctl', 'bootstrap', `gui/${ctx.uid}`, runtimePath]);
    if (ctx.updates && ctx.scheduler === 'launchd') {
      files.push({
        path: updatePath,
        content: plist(`${ctx.id}-update`, ctx.updater, ctx, true),
        mode: 0o600,
      });
      commands.push(['launchctl', 'bootstrap', `gui/${ctx.uid}`, updatePath]);
    } else removeFiles.push(updatePath);
  }
  const cronLine =
    ctx.updates && ctx.scheduler === 'cron'
      ? `0 */${ctx.intervalHours} * * * ${ctx.updater.map(shellQuote).join(' ')} >> ${shellQuote(path.join(ctx.root, 'logs/updates.log'))} 2>&1`.replaceAll(
          '%',
          '\\%',
        )
      : null;
  return { ...ctx, files, removeFiles, commands, unload, cronLine, cronMarker: ctx.id };
}

/** Replaces only our marked section; preserves all unrelated crontab bytes. */
export function updateCrontab(previous, marker, line) {
  if (!/^[a-zA-Z0-9-]+$/.test(marker)) throw new Error('Invalid crontab marker');
  const start = `# BEGIN ${marker}`;
  const end = `# END ${marker}`;
  const lines = previous.split('\n');
  const starts = lines.flatMap((value, index) => (value === start ? [index] : []));
  const ends = lines.flatMap((value, index) => (value === end ? [index] : []));
  if (starts.length !== ends.length || starts.length > 1 || (starts.length && starts[0] > ends[0]))
    throw new Error('Malformed managed crontab section; repair it before updating');
  if (starts.length) lines.splice(starts[0], ends[0] - starts[0] + 1);
  let result = lines.join('\n');
  if (line) result += `${result && !result.endsWith('\n') ? '\n' : ''}${start}\n${line}\n${end}\n`;
  return result;
}

async function defaultExec(argv) {
  try {
    const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1), {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message,
    };
  }
}

async function checked(execute, argv) {
  const result = await execute(argv);
  if (result.code !== 0)
    throw new Error(
      `Service command failed (${argv[0]}): ${result.stderr || result.stdout || result.code}`,
    );
  return result;
}

async function exists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readCrontab(execute, required) {
  const result = await execute(['crontab', '-l']);
  if (result.code === 0) return { present: true, content: result.stdout };
  if (/no crontab for/i.test(result.stderr)) return { present: false, content: '' };
  if (!required && /not found|ENOENT/i.test(result.stderr)) return null;
  throw new Error(`Cannot read crontab safely: ${result.stderr}`);
}

async function snapshot(plan, cron) {
  const backupPath = path.join(
    plan.root,
    'backups',
    `services-${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomBytes(3).toString('hex')}`,
  );
  await fs.mkdir(backupPath, { recursive: true, mode: 0o700 });
  const manifest = {
    createdAt: new Date().toISOString(),
    files: [],
    crontab: cron === null ? null : { present: cron.present, file: 'crontab.txt' },
  };
  const targets = [...new Set([...plan.files.map((file) => file.path), ...plan.removeFiles])];
  for (const [index, target] of targets.entries()) {
    if (!(await exists(target))) {
      manifest.files.push({ path: target, present: false });
      continue;
    }
    const stat = await fs.lstat(target);
    if (!stat.isFile()) throw new Error(`Refusing to replace non-regular service file: ${target}`);
    const content = await fs.readFile(target);
    const file = `${index}-${path.basename(target)}`;
    await fs.writeFile(path.join(backupPath, file), content, { mode: 0o600, flag: 'wx' });
    manifest.files.push({
      path: target,
      present: true,
      file,
      mode: stat.mode & 0o777,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    });
  }
  if (cron !== null)
    await fs.writeFile(path.join(backupPath, 'crontab.txt'), cron.content, {
      mode: 0o600,
      flag: 'wx',
    });
  await fs.writeFile(
    path.join(backupPath, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  return backupPath;
}

async function captureManagerState(plan, execute) {
  const ids = [plan.id, `${plan.id}-update`];
  const states = [];
  for (const [index, id] of ids.entries()) {
    if (plan.platform === 'linux') {
      const name = `${id}.${index ? 'timer' : 'service'}`;
      states.push({
        name,
        active: (await execute(systemctl(plan, 'is-active', name))).code === 0,
        enabled: (await execute(systemctl(plan, 'is-enabled', name))).code === 0,
      });
    } else {
      const file = path.join(plan.home, 'Library/LaunchAgents', `${id}.plist`);
      states.push({
        name: id,
        file,
        active: (await execute(['launchctl', 'print', `gui/${plan.uid}/${id}`])).code === 0,
      });
    }
  }
  return states;
}

async function restoreInstallation(plan, backupPath, states, cron, cronChanged, execute) {
  const failures = [];
  const attempt = async (action) => {
    try {
      await action();
    } catch (error) {
      failures.push(error.message);
    }
  };
  const manifest = JSON.parse(await fs.readFile(path.join(backupPath, 'manifest.json'), 'utf8'));
  for (const state of states) {
    // A missing/not-loaded new unit is harmless during cleanup.
    await execute(
      plan.platform === 'linux'
        ? systemctl(plan, 'stop', state.name)
        : ['launchctl', 'bootout', `gui/${plan.uid}/${state.name}`],
    );
  }
  for (const file of manifest.files) {
    await attempt(async () => {
      if (file.present) {
        const saved = path.join(backupPath, file.file);
        if (plan.system)
          await checked(execute, [
            'sudo',
            '-n',
            'install',
            '-m',
            file.mode.toString(8),
            '--',
            saved,
            file.path,
          ]);
        else {
          await fs.copyFile(saved, file.path);
          await fs.chmod(file.path, file.mode);
        }
      } else if (await exists(file.path)) {
        if (plan.system) await checked(execute, ['sudo', '-n', 'rm', '--', file.path]);
        else await fs.unlink(file.path);
      }
    });
  }
  if (cronChanged) {
    await attempt(async () => {
      const current = await readCrontab(execute, true);
      const installed = await fs.readFile(path.join(backupPath, 'crontab-next.txt'), 'utf8');
      if (current.content !== installed)
        throw new Error('Crontab changed concurrently; refusing to overwrite it during rollback');
      await checked(
        execute,
        cron.present ? ['crontab', path.join(backupPath, 'crontab.txt')] : ['crontab', '-r'],
      );
    });
  }
  if (plan.platform === 'linux')
    await attempt(() => checked(execute, systemctl(plan, 'daemon-reload')));
  for (const state of states) {
    await attempt(async () => {
      if (plan.platform === 'linux') {
        // Remove symlinks for failed new units before restoring previous enablement.
        if (state.enabled) await checked(execute, systemctl(plan, 'enable', state.name));
        else await execute(systemctl(plan, 'disable', state.name));
        if (state.active) await checked(execute, systemctl(plan, 'start', state.name));
      } else if (state.active)
        await checked(execute, ['launchctl', 'bootstrap', `gui/${plan.uid}`, state.file]);
    });
  }
  return failures;
}

/** Install or reconfigure services. No package managers and no implicit sudo prompts. */
export async function installServices(config, options = {}) {
  const plan = planServices(config, options);
  const execute = options.execute ?? defaultExec;
  const prerequisite =
    plan.platform === 'linux'
      ? systemctl(plan, 'show-environment')
      : ['launchctl', 'print', `gui/${plan.uid}`];
  const available = await execute(prerequisite);
  if (available.code !== 0)
    throw new Error(
      plan.platform === 'linux'
        ? 'No usable systemd manager. Enable the user manager and lingering, or explicitly choose systemService with sudo access. Cron schedules updates only; it does not replace the runtime supervisor.'
        : 'No logged-in macOS user session for LaunchAgents. Log in with this user before installing background services.',
    );
  const cron = await readCrontab(execute, plan.scheduler === 'cron');
  const backupPath = await snapshot(plan, cron);
  const previousStates = await captureManagerState(plan, execute);
  await fs.writeFile(
    path.join(backupPath, 'manager-state.json'),
    `${JSON.stringify(previousStates, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  let cronChanged = false;
  try {
    await fs.mkdir(path.join(plan.root, 'logs'), { recursive: true, mode: 0o700 });
    for (const item of plan.unload) {
      if (await exists(item.path)) {
        const result = await execute(item.command);
        if (
          result.code !== 0 &&
          !(
            plan.platform === 'darwin' &&
            /Could not find service|No such process|Input\/output error/i.test(result.stderr)
          )
        ) {
          throw new Error(`Could not unload old service; backup: ${backupPath}: ${result.stderr}`);
        }
      }
    }
    for (const file of plan.files) {
      const temporary = path.join(backupPath, `new-${path.basename(file.path)}`);
      await fs.writeFile(temporary, file.content, { mode: 0o600, flag: 'wx' });
      if (plan.system)
        await checked(execute, [
          'sudo',
          '-n',
          'install',
          '-m',
          file.mode.toString(8),
          '--',
          temporary,
          file.path,
        ]);
      else {
        await fs.mkdir(path.dirname(file.path), { recursive: true, mode: 0o700 });
        const staging = `${file.path}.new-${crypto.randomBytes(3).toString('hex')}`;
        await fs.writeFile(staging, file.content, { mode: file.mode, flag: 'wx' });
        await fs.rename(staging, file.path);
      }
    }
    for (const file of plan.removeFiles) {
      if (!(await exists(file))) continue;
      if (plan.system) await checked(execute, ['sudo', '-n', 'rm', '--', file]);
      else await fs.unlink(file);
    }
    if (cron !== null) {
      const next = updateCrontab(cron.content, plan.cronMarker, plan.cronLine);
      if (next !== cron.content) {
        const latest = await readCrontab(execute, true);
        if (latest.present !== cron.present || latest.content !== cron.content)
          throw new Error('Crontab changed concurrently; retry installation');
        const cronPath = path.join(backupPath, 'crontab-next.txt');
        await fs.writeFile(cronPath, next, { mode: 0o600, flag: 'wx' });
        await checked(execute, ['crontab', cronPath]);
        cronChanged = true;
      }
    }
    for (const command of plan.commands) await checked(execute, command);
    return { backupPath, service: plan.id, scheduler: plan.scheduler, updates: plan.updates };
  } catch (error) {
    const failures = await restoreInstallation(
      plan,
      backupPath,
      previousStates,
      cron,
      cronChanged,
      execute,
    );
    throw new Error(
      `${error.message}. ${failures.length ? `Rollback incomplete: ${failures.join('; ')}` : 'Previous service configuration restored'}. Backup: ${backupPath}`,
      { cause: error },
    );
  }
}

function actionCommand(config, role, options, action) {
  const ctx = context(config, { ...options, role });
  if (ctx.platform === 'linux') return systemctl(ctx, action, `${ctx.id}.service`);
  const file = path.join(ctx.home, 'Library/LaunchAgents', `${ctx.id}.plist`);
  return action === 'stop'
    ? ['launchctl', 'bootout', `gui/${ctx.uid}`, file]
    : ['launchctl', 'bootstrap', `gui/${ctx.uid}`, file];
}

export async function stopService(config, role = 'server', options = {}) {
  return checked(options.execute ?? defaultExec, actionCommand(config, role, options, 'stop'));
}

export async function startService(config, role = 'server', options = {}) {
  return checked(options.execute ?? defaultExec, actionCommand(config, role, options, 'start'));
}

export async function serviceStatus(config, options = {}) {
  const ctx = context(config, options);
  const command =
    ctx.platform === 'linux'
      ? systemctl(ctx, 'is-active', `${ctx.id}.service`)
      : ['launchctl', 'print', `gui/${ctx.uid}/${ctx.id}`];
  const result = await (options.execute ?? defaultExec)(command);
  return {
    service: ctx.id,
    active: result.code === 0,
    detail: (result.stdout || result.stderr).trim(),
  };
}

export const status = serviceStatus;
