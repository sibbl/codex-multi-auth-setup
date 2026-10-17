import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = [];
async function collect(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(target);
    else if (/\.(?:mjs|js)$/.test(entry.name)) files.push(target);
  }
}
await collect(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
process.stdout.write(`Syntax checked ${files.length} JavaScript files.\n`);
