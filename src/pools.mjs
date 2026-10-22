import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, readJson } from './config.mjs';
import { backupFiles } from './backup.mjs';
import {
  install,
  loadClient,
  waitForClient,
  writeDesktop,
  accountAction,
  doctor,
  configure,
  resume,
} from './installer.mjs';
import { select, text, confirm, p } from './prompts.mjs';
import { run } from './process.mjs';

export function poolPaths(base, name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(name))
    throw new Error(
      'Pool name must be 1–40 lowercase letters, digits or hyphens, starting with a letter',
    );
  const root = path.join(base, 'pools', name);
  return {
    clientRoot: path.join(root, 'client'),
    serverRoot: path.join(root, 'server'),
    codexHome: path.join(root, 'codex'),
  };
}

const registryFile = (base) => path.join(base, 'pools.json');
async function registry(base) {
  return readJson(registryFile(base), { schemaVersion: 1, defaultPool: null });
}

export async function selectedPoolRoot(base, name, command) {
  // Legacy installs remain untouched. With a default, management commands select
  // that pool; installation always requires an explicit pool to avoid surprises.
  const selected =
    name ?? (!['install', 'connect'].includes(command) ? (await registry(base)).defaultPool : null);
  return selected ? poolPaths(base, selected).clientRoot : base;
}

export async function seedPoolHome(destination, source) {
  if (!path.isAbsolute(source)) throw new Error('Seed source must be absolute');
  if (!(await fs.stat(source)).isDirectory()) throw new Error('Seed source must be a directory');
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.mkdir(destination, { mode: 0o700 }); // Never merge or overwrite an existing home.
  // Explicit snapshot, not a symlink: no concurrent token writes across pools.
  // Live SQLite databases are deliberately excluded.
  for (const name of [
    'config.toml',
    'auth.json',
    'history.jsonl',
    'sessions',
    'skills',
    'plugins',
  ]) {
    const from = path.join(source, name);
    try {
      await fs.cp(from, path.join(destination, name), {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
        filter: async (entry) => {
          const stat = await fs.lstat(entry);
          if (stat.isSymbolicLink())
            throw new Error('Seed contains a symlink; copy a reviewed snapshot instead');
          return stat.isFile() || stat.isDirectory();
        },
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  // Imported credentials must remain private regardless of source permissions.
  for (const name of ['auth.json', 'config.toml', 'history.jsonl'])
    await fs.chmod(path.join(destination, name), 0o600).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
}

export async function poolAction(base, args) {
  const [action, name, ...rest] = args;
  if (!action || ['menu', 'dashboard'].includes(action)) return poolMenu(base);
  if (action === 'list') {
    const state = await registry(base);
    const entries = await fs
      .readdir(path.join(base, 'pools'), { withFileTypes: true })
      .catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const paths = poolPaths(base, entry.name);
      const client = await readJson(path.join(paths.clientRoot, 'client.json'), null);
      process.stdout.write(
        `${entry.name}${state.defaultPool === entry.name ? ' (default)' : ''}${!client || client.pending ? ' (unfinished)' : ''}\n`,
      );
    }
    return;
  }
  if (action === 'clear-default') {
    // Does not guess the old endpoint. Restore the reported backup explicitly.
    await backupFiles(base, [registryFile(base)], 'clear default pool');
    await atomicJson(registryFile(base), { schemaVersion: 1, defaultPool: null });
    process.stdout.write(
      'Default selection cleared. Desktop endpoint is unchanged; restore its backup to disconnect.\n',
    );
    return;
  }
  const paths = poolPaths(base, name);
  if (action === 'create') {
    if (rest.length && (rest[0] !== '--seed-from' || rest.length !== 2))
      throw new Error('pools create NAME [--seed-from /absolute/codex-home]');
    if (!process.stdin.isTTY) throw new Error('Pool setup requires a terminal');
    if (rest[0]) await seedPoolHome(paths.codexHome, rest[1]);
    return install(paths.clientRoot, { ...paths, pool: true });
  }
  const client = await loadClient(paths.clientRoot);
  if (client.pending) throw new Error(`Pool unfinished: use --pool ${name} resume`);
  if (action === 'default') {
    if (rest.length) throw new Error('pools default NAME');
    await waitForClient(client);
    const desktopHome = process.env.CODEX_HOME
      ? path.resolve(process.env.CODEX_HOME)
      : path.join(os.homedir(), '.codex');
    if (desktopHome === client.codexHome)
      throw new Error('Desktop home must be separate from pool home');
    const backup = await writeDesktop({ ...client, codexHome: desktopHome });
    await backupFiles(base, [registryFile(base)], 'select default pool');
    await atomicJson(registryFile(base), { schemaVersion: 1, defaultPool: name });
    process.stdout.write(
      `Default pool: ${name}. Desktop backup: ${backup}. Restart the desktop app. Login/history unchanged.\n`,
    );
    return;
  }
  if (action === 'run') {
    await waitForClient(client);
    // Run locally even when the selected pool's proxy lives over SSH.
    // The client home contains this pool's endpoint, config, tools and history.
    return run('codex', rest[0] === '--' ? rest.slice(1) : rest, {
      interactive: true,
      env: { CODEX_HOME: client.codexHome },
    });
  }
  throw new Error('pools: create | list | default | clear-default | run');
}

export async function availablePools(base) {
  const state = await registry(base);
  const entries = await fs
    .readdir(path.join(base, 'pools'), { withFileTypes: true })
    .catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  const pools = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const paths = poolPaths(base, entry.name);
    const client = await readJson(path.join(paths.clientRoot, 'client.json'), null);
    pools.push({
      name: entry.name,
      ...paths,
      ready: Boolean(client && !client.pending),
      default: state.defaultPool === entry.name,
    });
  }
  return pools.sort((a, b) => a.name.localeCompare(b.name));
}

export async function poolMenu(base) {
  if (!process.stdin.isTTY) throw new Error('Pool dashboard requires a terminal');
  while (true) {
    const pools = await availablePools(base);
    const legacy = await readJson(path.join(base, 'client.json'), null);
    const choice = await select('Pools verwalten', [
      { value: ':create', label: 'Pool anlegen' },
      ...pools.map((pool) => ({
        value: pool.name,
        label: `${pool.name}${pool.default ? ' (Standard)' : ''}${pool.ready ? '' : ' (unfertig)'}`,
      })),
      ...(legacy
        ? [{ value: ':legacy', label: 'Bestehende Installation / bisherige Konten' }]
        : []),
      { value: ':exit', label: 'Beenden' },
    ]);
    if (choice === ':exit') return;
    if (choice === ':create') {
      const name = await text('Pool-Name (z. B. work oder personal)', '', (value) => {
        try {
          poolPaths(base, value);
        } catch (error) {
          return error.message;
        }
      });
      const seed = await confirm(
        'Konfiguration und History aus einem gestoppten Codex-Home kopieren?',
        false,
      );
      const source = seed
        ? await text('Absoluter Pfad des Snapshots', '', (value) =>
            path.isAbsolute(value) ? undefined : 'Absoluten Pfad angeben',
          )
        : null;
      await poolAction(base, ['create', name, ...(source ? ['--seed-from', source] : [])]);
      continue;
    }
    const selected = pools.find((pool) => pool.name === choice);
    const root = selected?.clientRoot ?? base;
    const ready = selected ? selected.ready : !legacy.pending;
    const action = await select(`Pool: ${selected?.name ?? 'bestehende Installation'}`, [
      ...(!ready ? [{ value: 'resume', label: 'Einrichtung fortsetzen' }] : []),
      { value: 'add', label: 'Account diesem Pool hinzufügen (Anmeldung)' },
      { value: 'list', label: 'Zugeordnete Accounts anzeigen' },
      { value: 'dashboard', label: 'Interaktives Account-Dashboard dieses Pools' },
      { value: 'remove', label: 'Account aus diesem Pool entfernen' },
      ...(ready
        ? [
            { value: 'stats', label: 'Usage / Account-Status' },
            { value: 'configure', label: 'Routing / Updates konfigurieren' },
            { value: 'doctor', label: 'Diagnose' },
            ...(selected
              ? [
                  { value: ':default', label: 'Als Desktop-Standard wählen' },
                  { value: ':run', label: 'Separate Codex-CLI starten' },
                ]
              : []),
          ]
        : []),
      { value: ':back', label: 'Zurück' },
    ]);
    if (action === ':back') continue;
    p.note(
      'Accounts sind dem ausgewählten Pool zugeordnet. Ein Login in einem anderen Pool verschiebt oder entfernt keine bestehende Zuordnung. App-Login und Cloud-History bleiben getrennt.',
      'Pool-Grenze',
    );
    if (action === ':default') await poolAction(base, ['default', selected.name]);
    else if (action === ':run') await poolAction(base, ['run', selected.name]);
    else if (action === 'configure') await configure(root);
    else if (action === 'doctor') await doctor(root);
    else if (action === 'resume') await resume(root);
    else await accountAction(root, action);
  }
}
