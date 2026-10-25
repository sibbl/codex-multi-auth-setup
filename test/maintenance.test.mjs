import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { accountSnapshot, maintenanceStatus } from '../src/maintenance-status.mjs';
import { maintenance } from '../src/worker.mjs';
import { run } from '../src/process.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-maintenance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('snapshot filters secrets, preserves selection and does not acquire a maintenance lock', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'data/multi-auth'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'data/multi-auth/openai-codex-accounts.json'),
    JSON.stringify({
      activeIndex: 1,
      pinnedAccountIndex: 1,
      accounts: [
        { email: 'one@example.test', refreshToken: 'SECRET' },
        { email: 'two@example.test', accessToken: 'SECRET' },
      ],
    }),
  );
  const before = await fs.readFile(
    path.join(root, 'data/multi-auth/openai-codex-accounts.json'),
    'utf8',
  );
  const result = await accountSnapshot(root);
  assert.equal(result.accounts[1].pinned, true);
  assert.equal(result.accounts[1].active, true);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal(result.maintenance.state, 'idle');
  assert.equal(
    await fs.readFile(path.join(root, 'data/multi-auth/openai-codex-accounts.json'), 'utf8'),
    before,
  );
  await assert.rejects(fs.stat(path.join(root, 'maintenance.lock')), { code: 'ENOENT' });
});
test('abandoned owners are distinguished from live owners and live orphan children', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'maintenance.lock'));
  const file = path.join(root, 'maintenance.lock/owner.json');
  const owner = { pid: 99999999, reason: 'upstream login', createdAt: new Date().toISOString() };
  await fs.writeFile(file, JSON.stringify(owner));
  assert.equal((await maintenanceStatus(root)).state, 'abandoned');
  await fs.writeFile(file, JSON.stringify({ ...owner, childPid: process.pid }));
  assert.equal((await maintenanceStatus(root)).state, 'active');
  await fs.writeFile(file, JSON.stringify({ ...owner, pid: process.pid }));
  assert.equal((await maintenanceStatus(root)).state, 'active');
});
test('failed operation resumes router and retains a credential-free phase journal', async (t) => {
  const root = await fixture(t);
  const actions = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    actions.push(JSON.parse(options.body).action);
    return new Response(JSON.stringify({ ready: true }));
  });
  await assert.rejects(
    maintenance(
      { root, initialized: true, ports: { gateway: 1 }, clientApiKey: 'private' },
      'configuration change',
      async () => {
        throw new Error('PRIVATE UPSTREAM BODY');
      },
    ),
    /PRIVATE UPSTREAM BODY/,
  );
  assert.deepEqual(actions, ['pause', 'reload']);
  await assert.rejects(fs.stat(path.join(root, 'maintenance.lock')), { code: 'ENOENT' });
  const journal = JSON.parse(
    await fs.readFile(path.join(root, 'maintenance-state/operation.json')),
  );
  assert.equal(journal.phase, 'failed');
  assert.ok(journal.operationId);
  assert.ok(!JSON.stringify(journal).includes('PRIVATE'));
});
test('reload failure retains tracked lock requiring explicit recovery', async (t) => {
  const root = await fixture(t);
  t.mock.method(
    globalThis,
    'fetch',
    async (url, options) =>
      new Response(JSON.stringify({ ready: true }), {
        status: JSON.parse(options.body).action === 'reload' ? 500 : 200,
      }),
  );
  await assert.rejects(
    maintenance(
      { root, initialized: true, ports: { gateway: 1 }, clientApiKey: 'private' },
      'configuration change',
      async () => {},
    ),
    /could not resume/,
  );
  const owner = JSON.parse(await fs.readFile(path.join(root, 'maintenance.lock/owner.json')));
  assert.equal(owner.phase, 'recovery-required');
  assert.equal(owner.requiresRecovery, true);
});
test('aborting a subprocess waits for its termination', async () => {
  const controller = new AbortController();
  let pid;
  const running = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    signal: controller.signal,
    onSpawn: (value) => {
      pid = value;
    },
  });
  controller.abort();
  await assert.rejects(running, /time\/output limit/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test(
  'SIGTERM during account work terminates the child, resumes and removes lock',
  { timeout: 10000 },
  async (t) => {
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const root = await fixture(t);
    const workerUrl = new URL('../src/worker.mjs', import.meta.url).href;
    const processUrl = new URL('../src/process.mjs', import.meta.url).href;
    const script = path.join(root, 'interrupt.mjs');
    await fs.writeFile(
      script,
      `
    import {maintenance} from ${JSON.stringify(workerUrl)};
    import {run} from ${JSON.stringify(processUrl)};
    import fs from 'node:fs/promises';
    globalThis.fetch = async (url, options) => {
      await fs.appendFile(${JSON.stringify(path.join(root, 'actions'))}, JSON.parse(options.body).action+'\\n');
      return new Response(JSON.stringify({ready:true}));
    };
    try {
      await maintenance({root:${JSON.stringify(root)},initialized:true,ports:{gateway:1},clientApiKey:'test'},'upstream check',async (backup,signal)=>run(process.execPath,['-e','setInterval(()=>{},1000)'],{signal,onSpawn:pid=>{process.stdout.write(String(pid)+'\\n');}}));
    } catch { process.exitCode=143; }
  `,
    );
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGKILL'));
    const closed = once(child, 'close');
    const [data] = await once(child.stdout, 'data');
    const upstreamPid = Number(data.toString().trim());
    child.kill('SIGTERM');
    const [code] = await closed;
    assert.equal(code, 143);
    assert.throws(() => process.kill(upstreamPid, 0), { code: 'ESRCH' });
    assert.equal(await fs.readFile(path.join(root, 'actions'), 'utf8'), 'pause\nreload\n');
    await assert.rejects(fs.stat(path.join(root, 'maintenance.lock')), { code: 'ENOENT' });
  },
);
