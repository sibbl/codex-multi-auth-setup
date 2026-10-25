import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validHost } from './config.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function sshArguments(config, host) {
  if (!validHost(host)) throw new Error('Invalid SSH destination');
  const ssh = config.ssh || {};
  if (ssh.port !== undefined && (!Number.isInteger(ssh.port) || ssh.port < 1 || ssh.port > 65535))
    throw new Error('Invalid SSH port');
  for (const option of ['identityFile', 'hostKeyAlias']) {
    if (
      ssh[option] !== undefined &&
      (typeof ssh[option] !== 'string' || /[\r\n\0]/.test(ssh[option]))
    )
      throw new Error('Invalid SSH option');
  }
  const args = [
    '-N',
    '-T',
    '-n',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=5',
    '-o',
    'ConnectionAttempts=1',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=10',
    '-o',
    'ServerAliveCountMax=2',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'LogLevel=ERROR',
    '-p',
    String(ssh.port || 22),
  ];
  if (ssh.identityFile) args.push('-i', ssh.identityFile, '-o', 'IdentitiesOnly=yes');
  if (ssh.hostKeyAlias) args.push('-o', `HostKeyAlias=${ssh.hostKeyAlias}`);
  args.push('-L', `127.0.0.1:${config.ports.tunnel}:127.0.0.1:${config.ports.gateway}`, host);
  return args;
}

async function health(port, config) {
  const legacy = config.healthCheck === 'legacy';
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port,
        path: legacy ? '/__websocket_auth_check__' : '/__setup_health',
        timeout: 1000,
      },
      (response) => {
        response.on('error', () => resolve(false));
        if (legacy) {
          response.on('end', () => resolve(response.statusCode === 404));
          response.resume();
          return;
        }
        let data = '';
        response.on('data', (chunk) => {
          data += chunk;
          if (data.length > 4096) request.destroy();
        });
        response.on('end', () => {
          try {
            const report = JSON.parse(data);
            resolve(
              response.statusCode === 200 &&
                report.service === 'codex-multi-auth-setup' &&
                report.ready === true &&
                (!config.installationId || report.installationId === config.installationId),
            );
          } catch {
            resolve(false);
          }
        });
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

export async function startForwarder(config) {
  if (!['local', 'ssh'].includes(config.mode))
    throw new Error('Forwarder mode must be local or ssh');
  if (config.healthCheck !== undefined && !['setup', 'legacy'].includes(config.healthCheck))
    throw new Error('Forwarder healthCheck must be setup or legacy');
  if (config.healthCheck === 'legacy' && config.installationId)
    throw new Error('Legacy health check cannot verify installationId');
  for (const name of ['gateway', 'client', ...(config.mode === 'ssh' ? ['tunnel'] : [])]) {
    if (
      !Number.isInteger(config.ports[name]) ||
      config.ports[name] < 1 ||
      config.ports[name] > 65535
    )
      throw new Error(`Invalid ${name} port`);
  }
  const targetPort = config.mode === 'local' ? config.ports.gateway : config.ports.tunnel;
  if (targetPort === config.ports.client)
    throw new Error('Client and forwarding ports must differ');
  const routes =
    config.mode === 'ssh'
      ? [...new Set([config.ssh?.host, config.ssh?.fallbackHost].filter(Boolean))]
      : [];
  if (config.mode === 'ssh' && !routes.length) throw new Error('An SSH destination is required');
  for (const route of routes) sshArguments(config, route);
  let closing = false;
  let ready = false;
  let child;
  let closePromise;
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  async function stopChild() {
    const previous = child;
    child = undefined;
    if (!previous || previous.exitCode !== null || previous.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => previous.kill('SIGKILL'), 2000);
      previous.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      previous.kill('SIGTERM');
    });
  }

  const server = net.createServer((socket) => {
    if (sockets.size >= 256) {
      socket.destroy();
      return;
    }
    track(socket);
    socket.on('error', () => socket.destroy());
    socket.pause();
    (async () => {
      const deadline = Date.now() + 30000;
      while (!ready && !closing && !socket.destroyed && Date.now() < deadline) await sleep(100);
      if (!ready || closing || socket.destroyed) {
        socket.destroy();
        return;
      }
      const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
      track(upstream);
      upstream.on('error', () => socket.destroy());
      upstream.once('close', () => socket.destroy());
      socket.once('close', () => upstream.destroy());
      upstream.once('connect', () => {
        if (socket.destroyed) {
          upstream.destroy();
          return;
        }
        socket.pipe(upstream);
        upstream.pipe(socket);
        socket.resume();
      });
    })().catch(() => socket.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.ports.client, '127.0.0.1', resolve);
  });

  const supervise = (async () => {
    let routeIndex = 0;
    while (!closing) {
      if (config.mode === 'local') {
        ready = await health(targetPort, config);
        await sleep(500);
        continue;
      }
      const current = spawn('ssh', sshArguments(config, routes[routeIndex]), {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child = current;
      let exited = false;
      current.once('error', () => {
        exited = true;
      });
      current.once('close', () => {
        exited = true;
        ready = false;
      });
      const deadline = Date.now() + 12000;
      while (!closing && !exited && Date.now() < deadline) {
        if (await health(targetPort, config)) {
          ready = true;
          break;
        }
        await sleep(150);
      }
      const connected = ready;
      let failures = 0;
      while (!closing && !exited && ready) {
        await sleep(1000);
        if (closing || exited) break;
        failures = (await health(targetPort, config)) ? 0 : failures + 1;
        if (failures >= 3) ready = false;
      }
      ready = false;
      await stopChild();
      // Keep a healthy fallback until it fails; then try the preferred route first.
      routeIndex = connected ? 0 : (routeIndex + 1) % routes.length;
      if (!closing) await sleep(500);
    }
  })();
  supervise
    .finally(() => {
      ready = false;
    })
    .catch(() => {});

  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closing = true;
      ready = false;
      const stopped = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await stopChild();
      await supervise;
      await stopped;
    })();
    return closePromise;
  }
  return { close, ready: () => ready, address: server.address() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || !['--root', '--config'].includes(args[0]) || !args[1])
      throw new Error('Usage: forwarder.mjs --root ROOT | --config FILE');
    const filename = args[0] === '--root' ? path.join(args[1], 'client.json') : args[1];
    const config = JSON.parse(await readFile(filename, 'utf8'));
    const forwarder = await startForwarder(config);
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.once(signal, () => forwarder.close().then(() => process.exit(0)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
