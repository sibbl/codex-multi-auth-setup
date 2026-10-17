#!/usr/bin/env node
import path from 'node:path';
import { dispatch } from '../src/worker.mjs';

async function main() {
  process.umask(0o077);
  const [option, root, separator, ...args] = process.argv.slice(2);
  if (option !== '--root' || !root || !path.isAbsolute(root) || /[\r\n\0]/.test(root))
    throw new Error('--root requires an absolute installation path.');
  if (separator !== '--') throw new Error('Proxy arguments must follow --.');
  const result = await dispatch('accounts', root, {
    command: 'proxy',
    args: args.length ? args : ['--help'],
    interactive: true,
  });
  process.exitCode = result.code;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
});
