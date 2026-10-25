import { formatUsage } from './usage.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  p,
  confirm,
  select,
  askSsh,
  askStrategy,
  askUpdates,
  askLocation,
  busy,
  Cancelled,
  text,
} from './prompts.mjs';
import { Target, ensureNode } from './target.mjs';
import {
  atomicJson,
  readJson,
  publicConfig,
  setDesktopEndpoint,
  defaultClientRoot,
  validHost,
} from './config.mjs';
import { backupFiles } from './backup.mjs';
import { run } from './process.mjs';
import { installServices } from './services.mjs';
import { installTailscale } from './tailscale.mjs';
import { installLauncher } from './launcher.mjs';
import { accountArguments } from './worker.mjs';
import { snapshotCommand } from './maintenance-status.mjs';
import { installDockerManagement, validateDockerManagement } from './docker.mjs';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsonResult = (result) => JSON.parse(result.stdout.trim().split('\n').at(-1));

export async function loadClient(root = defaultClientRoot()) {
  const managedFile = path.join(root, 'client.json');
  const forwarderFile = path.join(root, 'forwarder.json');
  const managed = await readJson(managedFile, null);
  const forwarder = await readJson(forwarderFile, null);
  if (managed && forwarder)
    throw new Error('Both client.json and forwarder.json exist. Keep exactly one active profile.');
  const config = managed ?? forwarder;
  if (!config) throw new Error('No installation found. Run: codex-ma-setup install');
  if (forwarder) validateForwarderProfile(config);
  Object.defineProperty(config, 'configFile', { value: managed ? managedFile : forwarderFile });
  if (!config.clientRoot) Object.defineProperty(config, 'clientRoot', { value: root });
  if (!config.codexHome)
    Object.defineProperty(config, 'codexHome', {
      value: process.env.CODEX_HOME
        ? path.resolve(process.env.CODEX_HOME)
        : path.join(os.homedir(), '.codex'),
    });
  return config;
}

function validateForwarderProfile(config) {
  if (!['local', 'ssh'].includes(config.mode))
    throw new Error('Forwarder mode must be local or ssh');
  for (const name of ['client', 'gateway', ...(config.mode === 'ssh' ? ['tunnel'] : [])])
    if (
      !Number.isInteger(config.ports?.[name]) ||
      config.ports[name] < 1 ||
      config.ports[name] > 65535
    )
      throw new Error(`Invalid ${name} port`);
  if (
    config.mode === 'ssh' &&
    (!validHost(config.ssh?.host) ||
      (config.ssh.fallbackHost && !validHost(config.ssh.fallbackHost)))
  )
    throw new Error('Invalid SSH hostname/address');
  if (config.management) validateDockerManagement(config.management);
  return config;
}

function requireManaged(client) {
  if (client.management?.type === 'docker' || client.configFile?.endsWith('/forwarder.json'))
    throw new Error(
      'Existing Docker proxy: this command requires a managed installation. Use stats, accounts, proxy, configure, or doctor.',
    );
  return client;
}

function requireDockerManagement(client) {
  if (!client.management)
    throw new Error(
      'Forwarder found, but account management is not configured. Connect the existing proxy: codex-ma-setup connect --container CONTAINER',
    );
  return validateDockerManagement(client.management);
}

export async function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function choosePorts() {
  const preferred = [64412, 64413, 64414, 64415];
  const ports = [];
  for (let port of preferred) {
    while (ports.includes(port) || !(await portAvailable(port))) port++;
    if (port > 65535) throw new Error('No available local port found.');
    ports.push(port);
  }
  const [client, router, gateway, tunnel] = ports;
  return { client, router, gateway, tunnel };
}

async function targetPorts(target, node, requested) {
  const ports = { ...requested };
  for (const name of ['router', 'gateway']) {
    const source = `const net=require('node:net');const s=net.createServer();s.on('error',()=>process.exit(2));s.listen(Number(process.argv[1]),'127.0.0.1',()=>s.close());`;
    let attempts = 0;
    while (
      (await target.run(node, ['-e', source, String(ports[name])], { check: false })).code !== 0
    ) {
      if (++attempts > 100) throw new Error('No available ports found on the target.');
      do {
        ports[name]++;
      } while (Object.entries(ports).some(([key, value]) => key !== name && value === ports[name]));
    }
  }
  return ports;
}

export async function installManager(target, root, node) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-ma-pack-'));
  try {
    const result = await run(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
      { cwd: projectRoot },
    );
    const report = JSON.parse(result.stdout);
    const packages = Array.isArray(report) ? report : Object.values(report);
    const filename = packages.length === 1 ? packages[0]?.filename : undefined;
    if (
      typeof filename !== 'string' ||
      path.basename(filename) !== filename ||
      !filename.endsWith('.tgz')
    )
      throw new Error('npm pack returned an invalid package archive');
    const archive = path.join(root, `.manager-${crypto.randomUUID()}.tgz`);
    await target.write(archive, await fs.readFile(path.join(temporary, filename)));
    const directory = path.join(root, 'manager');
    try {
      await target.run('mkdir', ['-p', directory]);
      await target.run(
        'npm',
        [
          'install',
          '--prefix',
          directory,
          '--omit=dev',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          archive,
        ],
        {
          env: { PATH: `${path.dirname(node)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin` },
          timeoutMs: 600_000,
        },
      );
      return path.join(directory, 'node_modules', 'codex-multi-auth-setup');
    } finally {
      await target.run('rm', ['-f', archive]);
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function clientServiceConfig(client) {
  return {
    ...client,
    root: client.clientRoot,
    appDir: client.clientAppDir,
    node: client.clientNode,
    systemService: process.platform === 'linux' && Boolean(client.clientSystemService),
    serviceUser: os.userInfo().username,
    serviceGroup: undefined,
    scheduler: process.platform === 'darwin' ? 'launchd' : 'systemd',
    updates: { ...client.updates, enabled: false },
  };
}

async function startClientServices(client) {
  const config = clientServiceConfig(client);
  if (config.systemService) await run('sudo', ['-v'], { interactive: true });
  p.log.step('Install/start the local connection service');
  return installServices(config, { role: 'client' });
}

async function installClientLauncher(client) {
  const launcher = await installLauncher(client);
  p.log.info(`Terminal command ready: ${launcher.path}`);
  if (launcher.pathUpdated)
    p.log.info('Open a new terminal to make the command available in PATH.');
  if (launcher.warning) p.log.warn(launcher.warning);
  return launcher;
}

export async function writeDesktop(client) {
  const filename = path.join(client.codexHome, 'config.toml');
  let previous = '';
  try {
    previous = await fs.readFile(filename, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const next = setDesktopEndpoint(previous, `http://127.0.0.1:${client.ports.client}`);
  const backup = await backupFiles(
    client.clientRoot,
    [filename, path.join(client.codexHome, 'auth.json')],
    'desktop endpoint',
  );
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.setup-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, next, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, filename);
  return backup;
}

export async function waitForClient(client, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${client.ports.client}/__setup_health`, {
        signal: AbortSignal.timeout(2000),
      });
      const body = await response.json();
      if (
        response.ok &&
        body.ready &&
        body.service === 'codex-multi-auth-setup' &&
        (!client.installationId || body.installationId === client.installationId)
      )
        return body;
    } catch {
      /* Connection can be unavailable while the service starts. */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    'Connection is not ready yet. Configuration and backups have been saved. Check doctor, SSH port forwarding, and service logs.',
  );
}

async function configureTailscale(target, info, clientRoot, serverRoot, mode) {
  const choice = await select(
    'Install Tailscale (optional)?',
    [
      { value: 'skip', label: 'Skip / already configured' },
      { value: 'client', label: 'On this computer' },
      ...(mode === 'ssh'
        ? [
            { value: 'server', label: 'On the SSH target' },
            { value: 'both', label: 'On both devices' },
          ]
        : []),
    ],
    'skip',
  );
  const destinations = [];
  if (choice === 'client' || choice === 'both')
    destinations.push({
      target: new Target({ mode: 'local' }),
      info: { platform: process.platform },
      root: clientRoot,
    });
  if (choice === 'server' || choice === 'both')
    destinations.push({ target, info, root: serverRoot });
  for (const destination of destinations) {
    const installed = await installTailscale(
      destination.target,
      destination.info,
      destination.root,
    );
    p.log.success(
      `Tailscale ${installed.installed ? 'installed' : 'already installed'}${installed.backup ? `; Backup: ${installed.backup}` : ''}.`,
    );
    p.note(
      destination.info.platform === 'darwin'
        ? 'Open the Tailscale app, sign in, and enable the connection. Then continue here.'
        : 'Run sudo tailscale up on the target and follow the sign-in link.\nThen continue here. Existing Tailscale settings will be preserved.',
      'Sign-in',
    );
    if (!(await confirm('Signed in to Tailscale? Continue?', true))) throw new Cancelled();
  }
}

export async function install(clientRoot = defaultClientRoot(), options = {}) {
  p.intro('Codex Multi Auth · Setup');
  if (await readJson(path.join(clientRoot, 'forwarder.json'), null)) {
    await loadClient(clientRoot);
    throw new Error(
      'Forwarder found. Connect the existing proxy using codex-ma-setup connect --container CONTAINER.',
    );
  }
  const existingClient = await readJson(path.join(clientRoot, 'client.json'), null);
  if (existingClient?.pending) return resume(clientRoot);
  if (existingClient) {
    p.log.info('Installation found. Opening configuration.');
    return configure(clientRoot);
  }
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error(
      'Nutze macOS, Linux oder WSL2. Native Windows-Dienste sind nicht implementiert.',
    );
  const localHome =
    options.codexHome ??
    (process.env.CODEX_HOME
      ? path.resolve(process.env.CODEX_HOME)
      : path.join(os.homedir(), '.codex'));
  const backup = await backupFiles(
    clientRoot,
    [
      path.join(clientRoot, 'client.json'),
      path.join(localHome, 'config.toml'),
      path.join(localHome, 'auth.json'),
      path.join(os.homedir(), '.ssh/known_hosts'),
    ],
    'installation preflight',
  );
  p.log.info(`Konfiguration gesichert: ${backup}`);
  const mode = options.pool
    ? 'local'
    : await select(
        'Wo soll der Account-Proxy laufen?',
        [
          { value: 'local', label: 'Lokal auf diesem Computer' },
          { value: 'ssh', label: 'Auf NAS / Server per SSH' },
        ],
        'local',
      );
  const ssh = mode === 'ssh' ? await askSsh() : null;
  const target = new Target({ mode, ssh });
  if (mode === 'ssh') {
    p.note(
      'An SSH key/agent is required so the background service can connect without a password.\nVerify new server fingerprints against your server records.',
      'SSH access',
    );
    await target.trust();
  }
  const info = await busy('Zielsystem prüfen', () => target.inspect());
  const root = options.serverRoot ?? (await askLocation(info.home));
  if (await target.exists(path.join(root, 'config.json')))
    throw new Error('This server is already configured. Use connect to add another computer.');
  if (await target.exists(root)) {
    const contents = await target.run('ls', ['-A', root]);
    const owned = await target.exists(path.join(root, '.codex-ma-setup-owner'));
    if (contents.stdout.trim() && !owned)
      throw new Error(
        'Choose a dedicated empty installation folder. Existing manual installations will not be overwritten.',
      );
  }
  await target.write(path.join(root, '.codex-ma-setup-owner'), 'codex-multi-auth-setup\n');
  await configureTailscale(target, info, clientRoot, root, mode);
  if (ssh?.fallbackHost)
    await new Target({ mode, ssh: { ...ssh, host: ssh.fallbackHost } }).trust();
  const strategy = await askStrategy();
  const updates = await askUpdates();
  let scheduler = info.platform === 'darwin' ? 'launchd' : 'systemd';
  if (updates.enabled && info.platform === 'linux')
    scheduler = await select(
      'Manage the update schedule with',
      [
        { value: 'systemd', label: 'systemd timer', hint: 'Recommended' },
        { value: 'cron', label: 'Cron', hint: 'Dedicated entry; other jobs are preserved' },
      ],
      'systemd',
    );
  const systemService =
    info.platform === 'linux' &&
    (await confirm('Set up a system service that runs without signing in? (sudo)', mode === 'ssh'));
  const clientSystemService =
    process.platform === 'linux' &&
    (mode === 'local'
      ? systemService
      : await confirm('Also run the local connection service as a system service? (sudo)', false));
  if (info.platform === 'linux' && !systemService)
    p.note(
      'A systemd user service requires a running user manager.\nTo keep it running after logout: sudo loginctl enable-linger <username>.',
      'Linux user service',
    );
  const desktop = options.pool
    ? true
    : await confirm('Codex Desktop auf diesem Computer mit dem Proxy verbinden?', true);
  let ports = await choosePorts();
  p.note(
    `Target: ${mode === 'ssh' ? ssh.host : 'this computer'}\nFolder: ${root}\nAccounts: ${strategy === 'sequential' ? 'Sequential' : 'Hybrid'}\nAutomatic updates: ${updates.enabled ? `every ${updates.intervalHours} h` : 'off'}\nProxy update delay: ${updates.delayHours} h\nDesktop: ${desktop ? `127.0.0.1:${ports.client}` : 'unchanged'}`,
    'Installation plan',
  );
  if (!(await confirm('Install now?', true)))
    return p.cancel('No installation performed. Backup preserved.');
  const node = await busy('Check the Node runtime / install if needed', () =>
    ensureNode(target, info, root),
  );
  ports = await targetPorts(target, node, ports);
  const appDir = path.join(root, 'manager', 'node_modules', 'codex-multi-auth-setup');
  const config = {
    schemaVersion: 1,
    installationId: crypto.randomUUID(),
    root,
    node,
    appDir,
    mode,
    ssh,
    strategy,
    updates,
    scheduler,
    ports,
    systemService,
    serviceUser: info.username,
    codexHome: options.pool ? path.join(root, 'cli-home') : path.join(info.home, '.codex'),
    clientApiKey: crypto.randomBytes(32).toString('hex'),
  };
  target.config = config;
  const clientAppDir =
    mode === 'local'
      ? appDir
      : path.join(clientRoot, 'manager', 'node_modules', 'codex-multi-auth-setup');
  const client = {
    ...publicConfig(config),
    clientRoot,
    clientNode: process.execPath,
    clientAppDir,
    serverCodexHome: config.codexHome,
    codexHome: localHome,
    desktop,
    clientSystemService,
    pending: true,
  };
  await atomicJson(path.join(clientRoot, 'client.json'), client);
  await busy('Install the setup manager on the target', () => installManager(target, root, node));
  if (mode === 'ssh')
    await busy('Install the local connection service', () =>
      installManager(new Target({ mode: 'local' }), clientRoot, process.execPath),
    );
  await installClientLauncher(client);
  const initialized = await busy('Check and install the proxy and optional CLI', async () =>
    jsonResult(await target.worker('initialize', { config })),
  );
  p.log.success(
    `Proxy ${initialized.proxyVersion}${initialized.cliVersion ? ` · Codex CLI ${initialized.cliVersion}` : ''}. Backup: ${initialized.backup}`,
  );
  return finishOnboarding(client, target);
}

export async function chooseLogin(args = []) {
  const device = args.includes('--device-auth');
  const browser = args.includes('--browser-auth');
  if (device && browser) throw new Error('Nur --device-auth ODER --browser-auth angeben.');
  let loginMethod = device ? 'device' : browser ? 'browser' : undefined;
  if (!loginMethod) {
    if (!process.stdin.isTTY)
      throw new Error(
        'Anmeldemethode wählen: --device-auth oder --browser-auth (oder interaktiv im Terminal starten).',
      );
    loginMethod = await select('Wie möchtest du den Account anmelden?', [
      {
        value: 'browser',
        label: 'Standard-Flow im Browser',
        hint: 'OAuth mit lokaler Callback-Weiterleitung',
      },
      {
        value: 'device',
        label: 'Device-Code',
        hint: 'Link öffnen und Gerätecode eingeben; auch für SSH',
      },
    ]);
  }
  p.note(
    loginMethod === 'device'
      ? 'Link öffnen und Gerätecode eingeben. Bei jedem Account den gewünschten Account wählen.'
      : 'Standard-Browser-Anmeldung mit Callback auf dem Proxy-Rechner. Bei SSH muss der Callback vom Browser erreichbar sein; alternativ Device-Code wählen.',
    loginMethod === 'device' ? 'Device-Code-Anmeldung' : 'Standard-Browser-Anmeldung',
  );
  return {
    loginMethod,
    args: args.filter((arg) => !['--device-auth', '--browser-auth'].includes(arg)),
  };
}

async function finishOnboarding(client, target) {
  let add = await confirm('Sign in to an account now?', true);
  while (add) {
    const login = await chooseLogin();
    await target.worker('accounts', { command: 'add', ...login }, { interactive: true });
    add = await confirm('Weiteren Account hinzufügen?', false);
  }
  if (
    client.updates.cli &&
    (await confirm(
      'Link the managed CLI as ~/.local/bin/codex on the target? Any existing entry will be backed up.',
      false,
    ))
  ) {
    const linked = jsonResult(await target.worker('link-cli'));
    p.log.info(
      `CLI ready at ${linked.path}. This folder must be in PATH. Backup: ${linked.backup}`,
    );
  }
  await target.worker('services', {}, { interactive: true });
  await startClientServices(client);
  await busy('Test the proxy connection', () => waitForClient(client));
  if (client.desktop) p.log.info(`Desktop configuration backed up: ${await writeDesktop(client)}`);
  await backupFiles(
    client.clientRoot,
    [path.join(client.clientRoot, 'client.json')],
    'complete onboarding',
  );
  await atomicJson(path.join(client.clientRoot, 'client.json'), { ...client, pending: false });
  p.outro(
    client.desktop
      ? 'Done. Fully quit and reopen Codex Desktop, then test a short request.'
      : 'Done. Desktop configuration unchanged; connect later using configure.',
  );
  p.note(
    'Accounts: codex-ma-setup accounts add | list | remove\nStats: codex-ma-setup stats\nConfiguration: codex-ma-setup configure\nDiagnostics: codex-ma-setup doctor\nAll proxy commands: codex-ma-setup proxy -- --help',
    'Manage later',
  );
  return client;
}

export async function resume(clientRoot = defaultClientRoot()) {
  p.intro('Resume interrupted setup');
  const client = requireManaged(await loadClient(clientRoot));
  if (!client.pending) throw new Error('Setup is already complete. Use configure.');
  const target = new Target(client);
  if (client.clientOnly) {
    const local = new Target({ mode: 'local' });
    if (!(await local.exists(path.join(client.clientAppDir, 'bin/codex-ma-setup.mjs'))))
      await installManager(local, clientRoot, client.clientNode);
    await installClientLauncher(client);
    await startClientServices(client);
    await waitForClient(client);
    if (client.desktop) await writeDesktop(client);
    await backupFiles(
      clientRoot,
      [path.join(clientRoot, 'client.json')],
      'complete client connection',
    );
    await atomicJson(path.join(clientRoot, 'client.json'), { ...client, pending: false });
    p.outro('Connection ready. Fully restart Codex Desktop if its configuration changed.');
    return;
  }
  if (!(await target.exists(path.join(client.appDir, 'src/worker.mjs'))))
    await installManager(target, client.root, client.node);
  if (
    client.mode === 'ssh' &&
    !(await new Target({ mode: 'local' }).exists(
      path.join(client.clientAppDir, 'src/forwarder.mjs'),
    ))
  ) {
    await installManager(new Target({ mode: 'local' }), clientRoot, client.clientNode);
  }
  await installClientLauncher(client);
  if (await target.exists(path.join(client.root, 'config.json'))) {
    const state = jsonResult(await target.worker('read'));
    if (state.installationId !== client.installationId)
      throw new Error('Server identity does not match the installation in progress.');
    if (!state.initialized)
      await busy('Check packages and resume setup', () => target.worker('resume'));
  } else {
    const config = {
      ...client,
      codexHome: client.serverCodexHome,
      clientApiKey: crypto.randomBytes(32).toString('hex'),
    };
    await busy('Install packages', () => target.worker('initialize', { config }));
  }
  return finishOnboarding(client, target);
}

export async function recover(clientRoot = defaultClientRoot()) {
  const client = requireManaged(await loadClient(clientRoot));
  p.note(
    'Recovers interrupted maintenance using its journal.\nCurrent account tokens will not be replaced with backups.\nMaintenance that is still running will not be taken over.',
    'Recovery',
  );
  if (!(await confirm('Try recovery now?', true))) throw new Cancelled();
  const result = jsonResult(await new Target(client).worker('recover', { confirmed: true }));
  p.note(JSON.stringify(result, null, 2), 'Result');
}

export async function connect(clientRoot = defaultClientRoot(), { container } = {}) {
  p.intro('Connect an existing proxy');
  const forwarder = await readJson(path.join(clientRoot, 'forwarder.json'), null);
  if (forwarder || container) {
    const client = await loadClient(clientRoot);
    if (!client.configFile.endsWith('/forwarder.json'))
      throw new Error('A Docker connection requires an existing forwarder.json profile.');
    const selected =
      container ??
      (await text('Existing proxy container name', client.management?.container ?? '', (value) =>
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value ?? '')
          ? 'Enter a valid Docker container name.'
          : undefined,
      ));
    const target = new Target(client);
    const management = await installDockerManagement(target, selected);
    const clientAppDir = await installManager(
      new Target({ mode: 'local' }),
      clientRoot,
      process.execPath,
    );
    const next = {
      ...client,
      management,
      clientRoot,
      clientNode: process.execPath,
      clientAppDir,
      codexHome: client.codexHome,
    };
    await backupFiles(clientRoot, [client.configFile], 'connect existing Docker proxy');
    await atomicJson(client.configFile, next);
    await installClientLauncher(next);
    p.outro(`Existing proxy connected. CLI on the proxy host: ${management.launcher}`);
    return next;
  }
  if (await readJson(path.join(clientRoot, 'client.json'), null))
    throw new Error('Client already exists. Use configure or a different --client-root.');
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
  await backupFiles(
    clientRoot,
    [
      path.join(codexHome, 'config.toml'),
      path.join(codexHome, 'auth.json'),
      path.join(os.homedir(), '.ssh/known_hosts'),
    ],
    'connect existing server',
  );
  const ssh = await askSsh();
  const target = new Target({ mode: 'ssh', ssh });
  await target.trust();
  const info = await target.inspect();
  const root = await askLocation(info.home);
  // Read only installation metadata; the server secret never enters client.json.
  const metadata = JSON.parse(await target.read(path.join(root, 'config.json')));
  target.config = { ...publicConfig(metadata), mode: 'ssh', ssh };
  const existing = jsonResult(await target.worker('read'));
  if (ssh.fallbackHost)
    await new Target({ mode: 'ssh', ssh: { ...ssh, host: ssh.fallbackHost } }).trust();
  const available = await choosePorts();
  const clientAppDir = await busy('Install the local manager', () =>
    installManager(new Target({ mode: 'local' }), clientRoot, process.execPath),
  );
  const clientSystemService =
    process.platform === 'linux' &&
    (await confirm('Run the local connection service as a system service? (sudo)', false));
  const client = {
    ...existing,
    mode: 'ssh',
    ssh,
    clientRoot,
    clientNode: process.execPath,
    clientAppDir,
    codexHome,
    pending: true,
    clientOnly: true,
    ports: { ...existing.ports, client: available.client, tunnel: available.tunnel },
    clientSystemService,
    desktop: await confirm('Connect Codex Desktop?', true),
  };
  await atomicJson(path.join(clientRoot, 'client.json'), client);
  await installClientLauncher(client);
  await startClientServices(client);
  await busy('Check the connection', () => waitForClient(client));
  if (client.desktop) await writeDesktop(client);
  await backupFiles(
    clientRoot,
    [path.join(clientRoot, 'client.json')],
    'complete client connection',
  );
  await atomicJson(path.join(clientRoot, 'client.json'), { ...client, pending: false });
  p.outro('Connected. Fully quit and reopen Codex Desktop.');
}

export async function configure(clientRoot = defaultClientRoot(), requested) {
  p.intro('Codex Multi Auth · Configuration');
  let client = await loadClient(clientRoot);
  if (client.configFile.endsWith('/forwarder.json')) {
    const choice =
      requested ??
      (await select('What would you like to change?', [
        ...(client.mode === 'ssh'
          ? [{ value: 'host', label: 'Hostname / IP / SSH key / fallback' }]
          : []),
        { value: 'desktop', label: 'Set up / repair the Desktop connection' },
      ]));
    if (choice === 'desktop') {
      await writeDesktop(client);
      p.outro('Desktop configuration updated. Fully restart Codex Desktop.');
      return;
    }
    if (choice !== 'host' || client.mode !== 'ssh') requireManaged(client);
    const management = requireDockerManagement(client);
    const ssh = await askSsh(client.ssh);
    await backupFiles(
      clientRoot,
      [client.configFile, path.join(os.homedir(), '.ssh', 'known_hosts')],
      'configure external SSH host',
    );
    const target = new Target({ ...client, clientRoot, ssh });
    await target.trust();
    const identity = (await target.run(management.launcher, ['--setup-identity'])).stdout.trim();
    if (identity !== management.identity)
      throw new Error('The new address points to a different proxy. No changes saved.');
    if (ssh.fallbackHost)
      await new Target({ ...client, clientRoot, ssh: { ...ssh, host: ssh.fallbackHost } }).trust();
    await atomicJson(client.configFile, { ...client, ssh });
    p.outro(
      'Address updated in the existing profile. Restart your connection service to reload the file.',
    );
    return;
  }
  if (
    client.clientAppDir &&
    (await new Target({ mode: 'local' }).exists(
      path.join(client.clientAppDir, 'bin/codex-ma-setup.mjs'),
    ))
  )
    await installClientLauncher(client);
  const choice =
    requested ??
    (await select('What would you like to change?', [
      ...(client.mode === 'ssh'
        ? [{ value: 'host', label: 'Hostname / IP / SSH key / fallback' }]
        : []),
      { value: 'strategy', label: 'Account distribution' },
      { value: 'updates', label: 'Automatic updates / delay / CLI' },
      { value: 'desktop', label: 'Set up / repair the Desktop connection' },
      { value: 'tailscale', label: 'Install Tailscale' },
    ]));
  await backupFiles(
    clientRoot,
    [
      path.join(clientRoot, 'client.json'),
      path.join(client.codexHome, 'config.toml'),
      path.join(os.homedir(), '.ssh/known_hosts'),
    ],
    `configure ${choice}`,
  );
  if (choice === 'host') {
    const ssh = await askSsh(client.ssh);
    const target = new Target({ ...client, ssh });
    await target.trust();
    const remote = jsonResult(await target.worker('read'));
    if (
      remote.root !== client.root ||
      remote.ports.gateway !== client.ports.gateway ||
      remote.installationId !== client.installationId
    )
      throw new Error(
        'The new address does not point to the expected installation. Use connect for a different server.',
      );
    if (ssh.fallbackHost)
      await new Target({ ...client, ssh: { ...ssh, host: ssh.fallbackHost } }).trust();
    client = { ...client, ssh };
    await atomicJson(path.join(clientRoot, 'client.json'), client);
    await startClientServices(client);
    await waitForClient(client);
    p.outro(
      'Address updated. A Desktop restart is usually unnecessary; the local address is unchanged.',
    );
    return;
  }
  const target = new Target(client);
  if (choice === 'desktop') {
    await writeDesktop(client);
    p.outro('Configuration backed up and updated. Fully restart Codex Desktop.');
    return;
  }
  if (choice === 'tailscale') {
    await configureTailscale(target, await target.inspect(), clientRoot, client.root, client.mode);
    p.outro('Tailscale is ready. Change the fallback address using configure.');
    return;
  }
  const changes =
    choice === 'strategy'
      ? { strategy: await askStrategy(client.strategy) }
      : { updates: await askUpdates(client.updates) };
  if (choice === 'updates' && (await target.inspect()).platform === 'linux')
    changes.scheduler = await select(
      'Update schedule',
      [
        { value: 'systemd', label: 'systemd timer' },
        { value: 'cron', label: 'Cron' },
      ],
      client.scheduler ?? 'systemd',
    );
  const result = jsonResult(await target.worker('configure', { changes }));
  if (changes.updates?.cli && !client.updates.cli) {
    p.log.info(
      'The CLI will be installed with the next update. Run updates run to install it now.',
    );
  }
  if (choice === 'updates') await target.worker('services', {}, { interactive: true });
  client = { ...client, ...changes };
  await atomicJson(path.join(clientRoot, 'client.json'), client);
  p.outro(`Change applied. Backup: ${result.backup}. No Desktop restart needed.`);
}

export async function accountAction(clientRoot, command, args = []) {
  const client = await loadClient(clientRoot);
  if (command === 'usage') {
    if (args.some((arg) => arg !== '--json'))
      throw new Error('usage: only --json is supported; this command never redeems resets');
    const report = jsonResult(await new Target(client).worker('usage-summary'));
    process.stdout.write(
      args.includes('--json') ? JSON.stringify(report, null, 2) + '\n' : formatUsage(report),
    );
    return;
  }
  const login = command === 'add' ? await chooseLogin(args) : {};
  if (command === 'add') args = login.args;
  const external = client.configFile.endsWith('/forwarder.json');
  const management = external ? requireDockerManagement(client) : null;
  if (!external && snapshotCommand(accountArguments({ command, args, ...login }))) {
    const result = jsonResult(
      await new Target(client).worker('accounts', { command, args, interactive: false }),
    );
    process.stdout.write(result.stdout);
    return;
  }

  if (command === 'remove')
    p.note(
      'The official proxy has no direct remove subcommand.\nIts account manager will open: select an account, then choose Delete (D).',
      'codex-multi-auth login',
    );
  if (['add', 'remove', 'dashboard'].includes(command))
    p.note(
      'The proxy pauses during account management.\nRequests in progress are allowed to finish first.',
      'Protect account files',
    );
  const reference = `codex-multi-auth ${command === 'add' ? `login ${login.loginMethod === 'device' ? '--device-auth ' : ''}--preserve-selection` : command === 'remove' ? 'login' : command === 'stats' ? 'status' : command === 'proxy' ? '(Proxy-Befehl)' : command}`;
  const structured =
    args.includes('--json') &&
    (['stats', 'list', 'usage'].includes(command) ||
      (command === 'proxy' &&
        [
          'list',
          'status',
          'usage',
          'limits',
          'report',
          'models',
          'forecast',
          'history',
          'resets',
          'doctor',
        ].includes(args[0])));
  if (structured) {
    process.stderr.write(`Forwarding to ${reference}\n`);
    if (management) {
      const result = await new Target(client).run(
        management.launcher,
        accountArguments({ command, args }),
        { interactive: false },
      );
      process.stdout.write(result.stdout);
      return result;
    }
    const result = jsonResult(
      await new Target(client).worker('accounts', { command, args, interactive: false }),
    );
    process.stdout.write(result.stdout);
    return;
  }
  p.log.info(`Forwarding to ${reference}.`);
  if (management)
    return new Target(client).run(
      management.launcher,
      accountArguments({ command, args, ...login }),
      {
        interactive: true,
      },
    );
  await new Target(client).worker('accounts', { command, args, ...login }, { interactive: true });
}

export async function updatesAction(clientRoot, action) {
  requireManaged(await loadClient(clientRoot));
  if (['configure', 'enable', 'disable'].includes(action)) {
    if (action === 'configure') return configure(clientRoot, 'updates');
    const client = await loadClient(clientRoot);
    const target = new Target(client);
    await backupFiles(clientRoot, [path.join(clientRoot, 'client.json')], `updates ${action}`);
    const updates = { ...client.updates, enabled: action === 'enable' };
    await target.worker('configure', { changes: { updates } });
    await target.worker('services', {}, { interactive: true });
    await atomicJson(path.join(clientRoot, 'client.json'), { ...client, updates });
    p.outro(`Automatic updates ${updates.enabled ? 'enabled' : 'disabled'}.`);
    return;
  }
  const client = await loadClient(clientRoot);
  if (action === 'status') {
    p.note(JSON.stringify(client.updates, null, 2), 'Update policy');
    return doctor(clientRoot);
  }
  if (!['check', 'run'].includes(action))
    throw new Error('updates: enable | disable | configure | check | run | status');
  const result = await busy(
    action === 'check' ? 'Check releases' : 'Check and apply updates',
    async () =>
      jsonResult(
        await new Target(client).worker('updates', {
          checkOnly: action === 'check',
          force: action === 'run',
        }),
      ),
  );
  p.note(JSON.stringify(result, null, 2), 'Update result');
}

export async function doctor(clientRoot, { quiet = false } = {}) {
  const client = await loadClient(clientRoot);
  if (client.configFile.endsWith('/forwarder.json')) {
    const management = requireDockerManagement(client);
    const target = new Target(client);
    const checks = [];
    try {
      const locked = await target.exists(path.posix.join(management.stateRoot, 'maintenance.lock'));
      checks.push({
        name: 'Maintenance',
        ok: !locked,
        detail: locked
          ? 'Account maintenance active or abandoned; inspect maintenance.json in the management state directory'
          : 'idle',
      });
    } catch (error) {
      checks.push({ name: 'Maintenance', ok: false, detail: error.message });
    }
    try {
      const identity = (await target.run(management.launcher, ['--setup-identity'])).stdout.trim();
      if (identity !== management.identity)
        throw new Error('Proxy identity does not match the profile.');
      checks.push({ name: 'Proxy CLI', ok: true, detail: management.launcher });
      const status = JSON.parse(
        (await target.run(management.launcher, ['status', '--json'])).stdout,
      );
      const count = status.accountCount ?? status.accounts?.length ?? status.summary?.totalAccounts;
      checks.push({
        name: 'Account pool',
        ok: true,
        detail: count === undefined ? 'Status available' : `${count} accounts`,
      });
    } catch (error) {
      checks.push({ name: 'Proxy CLI', ok: false, detail: error.message });
    }
    try {
      const response = await fetch(
        `http://127.0.0.1:${client.ports.client}/${client.healthCheck === 'legacy' ? '__websocket_auth_check__' : '__setup_health'}`,
        { signal: AbortSignal.timeout(5000) },
      );
      const ready =
        client.healthCheck === 'legacy'
          ? response.status === 404
          : response.ok && (await response.json()).ready === true;
      checks.push({
        name: 'Desktop connection',
        ok: ready,
        detail: `127.0.0.1:${client.ports.client}`,
      });
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      checks.push({ name: 'Desktop connection', ok: false, detail: error.message });
    }
    if (!quiet)
      for (const check of checks)
        p.log[check.ok ? 'success' : 'warn'](`${check.name}: ${check.detail}`);
    return { checks };
  }
  const result = jsonResult(await new Target(client).worker('doctor'));
  if (!quiet)
    for (const check of result.checks)
      p.log[check.ok ? 'success' : 'warn'](
        `${check.name}: ${typeof check.detail === 'string' ? check.detail : JSON.stringify(check.detail)}`,
      );
  try {
    await waitForClient(client, 5000);
    result.checks.push({ name: 'Desktop connection', ok: true, detail: 'reachable' });
    if (!quiet) p.log.success('Local Desktop endpoint is reachable.');
  } catch (error) {
    result.checks.push({ name: 'Desktop connection', ok: false, detail: error.message });
    if (!quiet) p.log.warn(error.message);
  }
  if (!quiet)
    p.note(
      'After changing the Desktop configuration, fully quit and reopen Codex.\nAn old Desktop background service can also cause "model not advertised".\nCheck app-server daemon version using the CLI bundled with your Desktop app.\nThis setup does not automatically replace an unrelated or running background service.',
      'Desktop / mobile sessions',
    );
  return result;
}

export async function menu(clientRoot) {
  const present =
    (await readJson(path.join(clientRoot, 'client.json'), null)) ??
    (await readJson(path.join(clientRoot, 'forwarder.json'), null));
  const existing = present ? await loadClient(clientRoot) : null;
  const external = existing?.configFile.endsWith('/forwarder.json');
  const choice = await select(
    'Codex Multi Auth',
    existing
      ? [
          ...(existing.pending ? [{ value: 'resume', label: 'Resume setup in progress' }] : []),
          { value: 'stats', label: 'Account status' },
          { value: 'add', label: 'Add an account' },
          { value: 'remove', label: 'Remove an account' },
          { value: 'configure', label: 'Change installation' },
          { value: 'doctor', label: 'Diagnostics' },
          ...(external
            ? [{ value: 'connect', label: 'Connect an existing Docker proxy / repair CLI' }]
            : [
                { value: 'updates', label: 'Check updates' },
                { value: 'recover', label: 'Recover interrupted maintenance' },
              ]),
        ]
      : [
          { value: 'install', label: 'New installation' },
          { value: 'connect', label: 'Connect an existing SSH server' },
        ],
  );
  if (['stats', 'add', 'remove'].includes(choice)) return accountAction(clientRoot, choice);
  if (choice === 'updates') return updatesAction(clientRoot, 'check');
  return { install, connect, resume, recover, configure, doctor }[choice](clientRoot);
}
