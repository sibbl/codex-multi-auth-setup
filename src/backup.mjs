import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJson } from './config.mjs';

async function copy(source, destination, files, prefix) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) {
    const link = await fs.readlink(source);
    await fs.symlink(link, destination);
    files.push({ path: prefix, symlink: link });
  } else if (stat.isDirectory()) {
    await fs.mkdir(destination, { mode: 0o700 });
    for (const name of await fs.readdir(source))
      await copy(path.join(source, name), path.join(destination, name), files, `${prefix}/${name}`);
  } else if (stat.isFile()) {
    await fs.copyFile(source, destination);
    await fs.chmod(destination, 0o600);
    files.push({
      path: prefix,
      mode: stat.mode & 0o777,
      sha256: crypto
        .createHash('sha256')
        .update(await fs.readFile(destination))
        .digest('hex'),
    });
  } else throw new Error(`Unsupported configuration file type: ${source}`);
}

/** Abort before mutation if any requested configuration cannot be backed up. */
export async function backupFiles(root, sources, reason) {
  const directory = path.join(
    root,
    'backups',
    `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`,
  );
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest = { createdAt: new Date().toISOString(), reason, sources: [], files: [] };
  for (const [index, source] of [...new Set(sources)].entries()) {
    const relative = path.relative(path.resolve(source), directory);
    if (
      relative === '' ||
      (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    )
      throw new Error('Cannot back up a directory containing its own snapshot destination');
    const name = `${index}-${path.basename(source)}`;
    try {
      await copy(source, path.join(directory, name), manifest.files, name);
      manifest.sources.push({ source, snapshot: name, existed: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Only a missing root is acceptable; files disappearing during a copy are not.
      try {
        await fs.lstat(source);
        throw new Error(`Configuration changed during backup: ${source}`, { cause: error });
      } catch (again) {
        if (again.code !== 'ENOENT') throw again;
      }
      manifest.sources.push({ source, existed: false });
    }
  }
  await atomicJson(path.join(directory, 'manifest.json'), manifest);
  return directory;
}

export function serverConfigFiles(config) {
  return [
    path.join(config.root, 'config.json'),
    path.join(config.root, 'router-state.json'),
    path.join(config.root, 'data', 'multi-auth'),
    path.join(config.root, 'data', 'codex'),
    ...(config.codexHome
      ? [path.join(config.codexHome, 'config.toml'), path.join(config.codexHome, 'auth.json')]
      : []),
  ];
}
