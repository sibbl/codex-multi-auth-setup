import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { backupFiles } from './backup.mjs';
import { shellQuote } from './process.mjs';

async function readOptional(filename) {
  try {
    return await fs.readFile(filename, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return '';
  }
}

async function replaceFile(filename, content, mode) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.setup-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, content, { mode, flag: 'wx' });
  await fs.chmod(temporary, mode);
  await fs.rename(temporary, filename);
}

async function installTerminalLauncher(
  { name, content, root, reason },
  {
    home = os.homedir(),
    shell = process.env.SHELL ?? '',
    pathEnv = process.env.PATH ?? '',
    zdotdir = process.env.ZDOTDIR,
    xdgConfigHome = process.env.XDG_CONFIG_HOME,
  } = {},
) {
  const directory = path.join(home, '.local', 'bin');
  const filename = path.join(directory, name);
  let shellConfig;
  const shellConfigs = [];
  const shellChanges = [];
  let warning;
  let pathUpdated = false;
  const sources = [];
  const previous = await readOptional(filename);
  // Replace symlinks too: this launcher must always use the installed Node runtime.
  let launcherChanged = previous !== content;
  try {
    const stat = await fs.lstat(filename);
    launcherChanged ||= stat.isSymbolicLink() || (stat.mode & 0o111) !== 0o111;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (launcherChanged) sources.push(filename);
  if (!pathEnv.split(path.delimiter).includes(directory)) {
    const name = path.basename(shell);
    if (name === 'zsh') shellConfig = path.join(zdotdir || home, '.zshrc');
    else if (name === 'bash') {
      shellConfig = path.join(home, '.bashrc');
      let login = path.join(home, '.profile');
      for (const candidate of ['.bash_profile', '.bash_login', '.profile']) {
        try {
          await fs.lstat(path.join(home, candidate));
          login = path.join(home, candidate);
          break;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      shellConfigs.push(login);
    } else if (name === 'fish')
      shellConfig = path.join(xdgConfigHome || path.join(home, '.config'), 'fish', 'config.fish');
    else
      warning = `Shell ${shell || '(unbekannt)'}: ${directory} bitte selbst zum PATH hinzufügen.`;
    if (shellConfig) {
      shellConfigs.unshift(shellConfig);
      const line =
        name === 'fish'
          ? `fish_add_path --prepend -- ${shellQuote(directory)}`
          : `export PATH=${shellQuote(directory)}:"$PATH"`;
      for (const config of shellConfigs) {
        let shellContent = await readOptional(config);
        if (shellContent.split(/\r?\n/).includes(line)) continue;
        const shellTarget = await fs.realpath(config).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
          return config;
        });
        sources.push(config, shellTarget);
        shellContent += `${shellContent && !shellContent.endsWith('\n') ? '\n' : ''}\n# codex-multi-auth-setup: Terminal-Befehl\n${line}\n`;
        shellChanges.push({ target: shellTarget, content: shellContent });
        pathUpdated = true;
      }
    }
  }
  const backup = sources.length ? await backupFiles(root, sources, reason) : null;
  if (launcherChanged) await replaceFile(filename, content, 0o755);
  for (const change of shellChanges) {
    let mode = 0o600;
    try {
      mode = (await fs.stat(change.target)).mode & 0o777;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await replaceFile(change.target, change.content, mode);
  }
  return { path: filename, backup, shellConfig, shellConfigs, pathUpdated, warning };
}

export async function installLauncher(client, options) {
  const entry = path.join(client.clientAppDir, 'bin', 'codex-ma-setup.mjs');
  await fs.access(entry);
  await fs.access(client.clientNode, fs.constants.X_OK);
  const command = `${shellQuote(client.clientNode)} ${shellQuote(entry)}`;
  const content = `#!/bin/sh
# Managed by codex-multi-auth-setup.
for argument do
  case "$argument" in
    --) break ;;
    --client-root) exec ${command} "$@" ;;
  esac
done
exec ${command} --client-root ${shellQuote(client.clientRoot)} "$@"
`;
  return installTerminalLauncher(
    {
      name: 'codex-ma-setup',
      content,
      root: client.clientRoot,
      reason: 'install global setup command',
    },
    options,
  );
}

export async function installProxyLauncher(config, options) {
  const entry = path.join(config.appDir, 'bin', 'codex-multi-auth.mjs');
  await fs.access(entry);
  await fs.access(config.node, fs.constants.X_OK);
  const content = `#!/bin/sh
# Managed by codex-multi-auth-setup.
exec ${shellQuote(config.node)} ${shellQuote(entry)} --root ${shellQuote(config.root)} -- "$@"
`;
  return installTerminalLauncher(
    {
      name: 'codex-multi-auth',
      content,
      root: config.root,
      reason: 'install global proxy command',
    },
    options,
  );
}
