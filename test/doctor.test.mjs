import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectVersions } from '../src/doctor.mjs';

test('version diagnostics query native daemon without leaking arbitrary response fields', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'setup-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'native');
  const bin = path.join(codexHome, 'packages', 'app-server-daemon', 'current', 'bin');
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(root, 'current-proxy'));
  await writeFile(
    path.join(root, 'current-proxy', 'package.json'),
    '{"name":"codex-multi-auth","version":"2.23.0"}',
  );
  const executable = path.join(bin, 'codex');
  await writeFile(
    executable,
    `#!${process.execPath}
if (process.argv.slice(2).join(' ') !== 'app-server daemon version' || process.env.CODEX_HOME !== ${JSON.stringify(codexHome)}) process.exit(1);
console.log(JSON.stringify({status:'running',appServerVersion:'0.162.0',managedCodexVersion:'0.163.0',token:'must-not-leak',account:'must-not-leak'}));
`,
  );
  await chmod(executable, 0o700);
  const checks = await inspectVersions({ root, codexHome });
  assert.equal(checks[0].detail, '2.23.0');
  assert.deepEqual(checks[1].detail, {
    status: 'running',
    runningVersion: '0.162.0',
    selectedVersion: '0.163.0',
  });
  assert.ok(!JSON.stringify(checks).includes('must-not-leak'));
});
