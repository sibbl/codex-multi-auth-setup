import test from 'node:test';
import assert from 'node:assert/strict';
import { Target } from '../src/target.mjs';

const config = {
  mode: 'ssh',
  ssh: { host: 'user@primary', fallbackHost: 'user@fallback', port: 22 },
  installationId: 'expected-installation',
  root: '/srv/setup',
  node: '/usr/bin/node',
  clientRoot: '/home/local/setup',
};

function fake({
  primaryAvailable = false,
  identity = config.installationId,
  actionError = false,
} = {}) {
  const calls = [];
  const execute = async (executable, args, options) => {
    const host = args.at(-2);
    const command = args.at(-1);
    const kind =
      command === "env 'true'" ? 'probe' : command.includes('readFileSync') ? 'identity' : 'action';
    calls.push({ executable, args, options, host, kind });
    if (kind === 'probe')
      return {
        code: host === config.ssh.host && !primaryAvailable ? 255 : 0,
        stdout: '',
        stderr: '',
      };
    if (kind === 'identity')
      return { code: 0, stdout: JSON.stringify({ installationId: identity }), stderr: '' };
    if (actionError) throw new Error('SSH response lost after command dispatch');
    return { code: 0, stdout: 'done', stderr: '' };
  };
  return { calls, target: new Target(config, execute) };
}

test('management selects primary once and does not probe or switch between actions', async () => {
  const { calls, target } = fake({ primaryAvailable: true });
  await target.run('first-action');
  await target.run('second-action');
  assert.deepEqual(
    calls.map((call) => [call.host, call.kind]),
    [
      ['user@primary', 'probe'],
      ['user@primary', 'action'],
      ['user@primary', 'action'],
    ],
  );
  assert.ok(calls[0].args.includes('BatchMode=yes'));
  assert.ok(calls[0].args.includes('StrictHostKeyChecking=yes'));
});

test('unreachable primary uses verified fallback and never replays an uncertain mutation', async () => {
  const { calls, target } = fake({ actionError: true });
  await assert.rejects(target.run('mutating-action'), /response lost/);
  assert.deepEqual(
    calls.map((call) => [call.host, call.kind]),
    [
      ['user@primary', 'probe'],
      ['user@fallback', 'probe'],
      ['user@fallback', 'identity'],
      ['user@fallback', 'action'],
    ],
  );
});

test('failed primary action does not trigger a fallback attempt', async () => {
  const { calls, target } = fake({ primaryAvailable: true, actionError: true });
  await assert.rejects(target.run('mutating-action'), /response lost/);
  assert.deepEqual(
    calls.map((call) => [call.host, call.kind]),
    [
      ['user@primary', 'probe'],
      ['user@primary', 'action'],
    ],
  );
});

test('fallback identity mismatch blocks all actual actions', async () => {
  const { calls, target } = fake({ identity: 'another-installation' });
  await assert.rejects(target.run('mutating-action'), /different installation/);
  assert.equal(calls.filter((call) => call.kind === 'action').length, 0);
});

test('trust always addresses the explicit host without fallback probes', async () => {
  const { calls, target } = fake();
  await target.trust();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, 'user@primary');
  assert.ok(calls[0].args.includes('BatchMode=no'));
  assert.ok(calls[0].args.includes('StrictHostKeyChecking=ask'));
});

test('known fallback identity is checked once for successive commands', async () => {
  const { calls, target } = fake();
  await target.run('first-action');
  await target.run('second-action');
  assert.equal(calls.filter((call) => call.kind === 'identity').length, 1);
  assert.equal(calls.filter((call) => call.kind === 'action').length, 2);
  assert.equal(calls.at(-1).host, 'user@fallback');
});
