#!/usr/bin/env node
import { p, Cancelled } from '../src/prompts.mjs';
import { defaultClientRoot } from '../src/config.mjs';
import { Target } from '../src/target.mjs';
import {
  install,
  connect,
  resume,
  recover,
  configure,
  accountAction,
  updatesAction,
  doctor,
  loadClient,
} from '../src/installer.mjs';

import {
  poolAction,
  poolMenu,
  selectedPoolRoot,
  selectedPoolName,
  doctorPools,
} from '../src/pools.mjs';

const help = `Codex Multi Auth Setup

  codex-ma-setup                         Guided menu
  codex-ma-setup install                 Install locally or over SSH
  codex-ma-setup connect                 Connect an existing SSH proxy
  codex-ma-setup connect --container NAME Connect an existing Docker proxy to the forwarder profile
  codex-ma-setup resume                  Resume interrupted setup
  codex-ma-setup recover                 Recover interrupted maintenance
  codex-ma-setup configure               Change address, routing and updates
  codex-ma-setup accounts add|list|remove Official account management
  codex-ma-setup dashboard               Interactive pool menu
  codex-ma-setup accounts add --device-auth | --browser-auth
  codex-ma-setup usage                   Read-only usage and reset expirations
  codex-ma-setup stats                   codex-multi-auth status
  codex-ma-setup proxy -- <command>      Run any official proxy command
  codex-ma-setup updates enable|disable|configure|check|run|status
  codex-ma-setup doctor                  Check connection, models and maintenance
  codex-ma-setup doctor --all [--json]    Check every registered pool without pausing
  codex-ma-setup codex -- <args>          Run the managed Codex CLI on the target

  codex-ma-setup pools create|adopt|list|home|default|clear-default|run
  --pool NAME                           Select isolated pool

  --client-root /absolute/path           Separate installation / client configuration
  --help                                Show this help

Accounts are managed by the proxy tool. "remove" opens its official account manager.
Round-robin is unsupported upstream; sequential and hybrid are available.
`;

async function main() {
  process.umask(0o077);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('Node.js >=22.19 is required.');
  const args = process.argv.slice(2);
  let clientRoot = defaultClientRoot();
  const index = args.indexOf('--client-root');
  if (index !== -1 && (args.indexOf('--') === -1 || index < args.indexOf('--'))) {
    clientRoot = args[index + 1];
    if (!clientRoot?.startsWith('/') || /[\r\n\0]/.test(clientRoot))
      throw new Error('--client-root requires an absolute path.');
    args.splice(index, 2);
  }
  const poolIndex = args.indexOf('--pool');
  const delimiter = args.indexOf('--');
  const pool =
    poolIndex !== -1 && (delimiter === -1 || poolIndex < delimiter)
      ? args.splice(poolIndex, 2)[1]
      : undefined;
  if (poolIndex !== -1 && (delimiter === -1 || poolIndex < delimiter) && !pool)
    throw new Error('--pool requires a name');
  const command = args.shift();
  if (command === 'doctor' && args.includes('--all')) {
    if (pool || args.some((arg) => !['--all', '--json'].includes(arg)))
      throw new Error('doctor --all [--json] cannot select a single pool');
    return doctorPools(clientRoot, { json: args.includes('--json') });
  }
  if (command === 'pools') return poolAction(clientRoot, args);
  if (command === 'dashboard' || !command) return poolMenu(clientRoot);
  const poolBase = clientRoot;
  if (pool && ['install', 'connect'].includes(command))
    throw new Error('Use pools create NAME to install an isolated pool');
  clientRoot = await selectedPoolRoot(clientRoot, pool, command);
  const selected = await selectedPoolName(poolBase, pool, command);
  if (command === 'codex' && selected) return poolAction(poolBase, ['run', selected, ...args]);

  if (['--help', '-h', 'help'].includes(command)) {
    process.stdout.write(help);
    return;
  }
  if (command === '--version') {
    process.stdout.write('0.1.0\n');
    return;
  }
  const containerConnect = command === 'connect' && args[0] === '--container' && args.length === 2;
  if (
    (['install', 'connect', 'resume', 'recover', 'configure'].includes(command) || !command) &&
    !containerConnect
  ) {
    if (!process.stdin.isTTY)
      throw new Error('Interactive setup requires a terminal. Use --help to see commands.');
  }
  switch (command) {
    case 'install':
      return install(clientRoot);
    case 'connect':
      if (args.length && !containerConnect) throw new Error('connect: --container NAME');
      return connect(clientRoot, containerConnect ? { container: args[1] } : {});
    case 'resume':
      return resume(clientRoot);
    case 'recover':
      return recover(clientRoot);
    case 'configure':
      return configure(clientRoot);
    case 'doctor':
      return doctor(clientRoot);
    case 'usage':
      return accountAction(clientRoot, 'usage', args);
    case 'stats':
      return accountAction(clientRoot, 'stats', args);
    case 'list':
      return accountAction(clientRoot, 'list', args);
    case 'accounts': {
      const action = args.shift();
      if (!['add', 'list', 'remove', 'dashboard', 'usage'].includes(action))
        throw new Error('accounts: add | list | remove | dashboard | usage');
      return accountAction(clientRoot, action, args);
    }
    case 'proxy':
      return accountAction(clientRoot, 'proxy', args[0] === '--' ? args.slice(1) : args);
    case 'updates':
      return updatesAction(clientRoot, args[0] ?? 'configure');
    case 'codex': {
      const client = await loadClient(clientRoot);
      if (client.management?.type === 'docker' || client.configFile.endsWith('/forwarder.json'))
        throw new Error(
          'A managed Codex CLI is not configured for the existing Docker proxy. Use proxy for proxy commands.',
        );
      return new Target(client).worker(
        'codex',
        { args: args[0] === '--' ? args.slice(1) : args },
        { interactive: true },
      );
    }
    default:
      throw new Error(`Unknown command: ${command}. Use --help.`);
  }
}

main().catch((error) => {
  if (error instanceof Cancelled) p.cancel(error.message);
  else {
    p.log.error(error.message);
    p.log.info('Backups are preserved. Run diagnostics: codex-ma-setup doctor');
  }
  process.exitCode = error instanceof Cancelled ? 130 : 1;
});
