import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startForwarder, sshArguments } from '../src/forwarder.mjs';

const execFileAsync = promisify(execFile);
const executable = fileURLToPath(new URL('../src/forwarder.mjs', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function fixture(t, legacyStatus = 404) {
  const requests = [];
  const gateway = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/models') {
      response.end(JSON.stringify({ data: [{ id: 'configured-gateway-model' }] }));
      return;
    }
    response.writeHead(request.url === '/__websocket_auth_check__' ? legacyStatus : 404);
    response.write('legacy gateway'.repeat(1024));
    const timer = setTimeout(() => response.end('last health-check chunk'), 10);
    response.once('close', () => clearTimeout(timer));
  });
  const gatewayPort = await listen(gateway);
  t.after(
    () =>
      new Promise((resolve) => {
        gateway.close(resolve);
        gateway.closeAllConnections();
      }),
  );
  const reservation = net.createServer();
  const clientPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  return {
    requests,
    config: {
      mode: 'local',
      ports: { gateway: gatewayPort, client: clientPort },
    },
  };
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  assert.fail('Timed out waiting for forwarder');
}

test('explicit legacy health forwards through configured local ports', async (t) => {
  const { config, requests } = await fixture(t);
  const forwarder = await startForwarder({ ...config, healthCheck: 'legacy' });
  t.after(() => forwarder.close());
  const response = await fetch(`http://127.0.0.1:${config.ports.client}/models`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.deepEqual(await response.json(), { data: [{ id: 'configured-gateway-model' }] });
  assert.equal(forwarder.address.port, config.ports.client);
  assert.equal(forwarder.ready(), true);
  assert.ok(requests.includes('/__websocket_auth_check__'));
  assert.ok(!requests.includes('/__setup_health'));
});

test('default health refuses a legacy gateway without an owned health marker', async (t) => {
  const { config, requests } = await fixture(t);
  const forwarder = await startForwarder(config);
  t.after(() => forwarder.close());
  await waitUntil(() => requests.filter((url) => url === '/__setup_health').length >= 2);
  assert.equal(forwarder.ready(), false);
  assert.ok(!requests.includes('/__websocket_auth_check__'));
});

test('legacy health requires the exact expected status', async (t) => {
  const { config, requests } = await fixture(t, 200);
  const forwarder = await startForwarder({ ...config, healthCheck: 'legacy' });
  t.after(() => forwarder.close());
  await waitUntil(() => requests.filter((url) => url === '/__websocket_auth_check__').length >= 2);
  assert.equal(forwarder.ready(), false);
});

test('invalid health configuration and legacy installation identity reject before binding', async (t) => {
  const occupied = net.createServer();
  const port = await listen(occupied);
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const config = {
    mode: 'local',
    ports: { client: port, gateway: port + (port < 65535 ? 1 : -1) },
  };
  for (const healthCheck of ['tcp', '', null, {}, 404]) {
    await assert.rejects(startForwarder({ ...config, healthCheck }), /health/i);
  }
  await assert.rejects(
    startForwarder({ ...config, healthCheck: 'legacy', installationId: 'owned-installation' }),
    /legacy|installation/i,
  );
});

test('SSH configuration rejects invalid ports, destinations, and unsafe options', () => {
  const config = { ports: { gateway: 23456, tunnel: 34567 }, ssh: { port: 22 } };
  for (const port of [0, -1, 65536, 1.5, '22']) {
    assert.throws(() => sshArguments({ ...config, ssh: { port } }, 'alice@server'), /port/i);
  }
  for (const option of ['identityFile', 'hostKeyAlias']) {
    for (const value of [123, true, 'unsafe\rvalue', 'unsafe\nvalue', 'unsafe\0value']) {
      assert.throws(
        () => sshArguments({ ...config, ssh: { port: 22, [option]: value } }, 'alice@server'),
        /SSH|option|identity|alias/i,
      );
    }
  }
  for (const destination of [
    '-oProxyCommand=bad',
    'user@@server',
    'user@server/path',
    'bad host',
  ]) {
    assert.throws(() => sshArguments(config, destination), /SSH|destination|host/i);
  }
  for (const port of [1, 65535]) {
    const args = sshArguments({ ...config, ssh: { port } }, 'alice@server');
    assert.equal(args[args.indexOf('-p') + 1], String(port));
  }
});

test('forwarder CLI loads the selected config file and shuts down cleanly', async (t) => {
  const { config } = await fixture(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'setup-forwarder-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'chosen forwarder.json');
  await writeFile(filename, JSON.stringify({ ...config, healthCheck: 'legacy' }));
  const child = spawn(process.execPath, [executable, '--config', filename], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const stopped = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await stopped;
  });
  const deadline = Date.now() + 5000;
  let response;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      response = await fetch(`http://127.0.0.1:${config.ports.client}/models`, {
        signal: AbortSignal.timeout(1000),
      });
      break;
    } catch {
      await sleep(25);
    }
  }
  assert.ok(response, `Forwarder did not start: ${stderr}`);
  assert.deepEqual(await response.json(), { data: [{ id: 'configured-gateway-model' }] });
  child.kill('SIGTERM');
  assert.deepEqual(await stopped, { code: 0, signal: null });
});

test('forwarder CLI rejects conflicting root and config arguments', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [executable, '--root', '/unused', '--config', '/unused.json']),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /root|config|usage/i);
      assert.doesNotMatch(error.stderr, /ENOENT/);
      return true;
    },
  );
});
