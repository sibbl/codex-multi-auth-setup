import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { installManager } from '../src/installer.mjs';
import { run } from '../src/process.mjs';

test('manager packs the durable CLI and example configuration before installing on target', async () => {
  const root = '/isolated setup/client';
  const calls = [];
  const uploads = [];
  const target = {
    async write(filename, content) {
      uploads.push({ filename, content });
    },
    async run(command, args, options) {
      calls.push({ command, args, options });
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  const installed = await installManager(target, root, process.execPath);
  assert.equal(installed, path.join(root, 'manager/node_modules/codex-multi-auth-setup'));
  assert.equal(uploads.length, 1);
  const [upload] = uploads;
  assert.equal(path.dirname(upload.filename), root);
  assert.match(path.basename(upload.filename), /^\.manager-[\da-f-]+\.tgz$/);
  assert.deepEqual([...upload.content.subarray(0, 2)], [0x1f, 0x8b]);
  const entries = (await run('tar', ['-tzf', '-'], { input: upload.content })).stdout.split('\n');
  for (const entry of [
    'package/bin/codex-ma-setup.mjs',
    'package/src/launcher.mjs',
    'package/src/installer.mjs',
    'package/examples/forwarder.json',
  ])
    assert.ok(entries.includes(entry), `Missing durable package entry: ${entry}`);
  assert.deepEqual(
    calls.map(({ command }) => command),
    ['mkdir', 'npm', 'rm'],
  );
  assert.deepEqual(calls[0].args, ['-p', path.join(root, 'manager')]);
  assert.deepEqual(calls[1].args, [
    'install',
    '--prefix',
    path.join(root, 'manager'),
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    upload.filename,
  ]);
  assert.ok(calls[1].options.env.PATH.startsWith(`${path.dirname(process.execPath)}:`));
  assert.deepEqual(calls[2].args, ['-f', upload.filename]);
});

test('manager removes the uploaded archive when target installation fails', async () => {
  const calls = [];
  let archive;
  const failure = new Error('target installation failed');
  const target = {
    async write(filename) {
      archive = filename;
    },
    async run(command, args) {
      calls.push({ command, args });
      if (command === 'npm') throw failure;
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  await assert.rejects(installManager(target, '/isolated setup/client', process.execPath), failure);
  assert.deepEqual(calls.at(-1), { command: 'rm', args: ['-f', archive] });
});
