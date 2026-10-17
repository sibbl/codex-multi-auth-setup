import { spawn } from 'node:child_process';

export class CommandError extends Error {
  constructor(command, code, stderr = '') {
    super(`${command} exited with ${code}${stderr ? `: ${stderr.slice(-1500).trim()}` : ''}`);
    this.exitCode = code;
  }
}

export function run(executable, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const interactive = options.interactive ?? false;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let timeout;
    let killTimeout;
    let exceeded = false;
    let spawnCallbackError;
    const terminate = () => {
      if (exceeded) return;
      exceeded = true;
      child.kill('SIGTERM');
      killTimeout = setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimeout.unref();
    };
    if (!interactive) {
      child.stdout.on('data', (data) => {
        if (exceeded) return;
        stdout += data;
        if (stdout.length > (options.maxOutput ?? 16 * 1024 * 1024)) {
          stdout = '';
          terminate();
        }
      });
      child.stderr.on('data', (data) => {
        stderr = (stderr + data).slice(-65536);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(options.input);
    }
    if (options.timeoutMs ?? !interactive) {
      timeout = setTimeout(() => {
        terminate();
      }, options.timeoutMs ?? 120000);
      timeout.unref();
    }
    child.once('error', (error) => {
      clearTimeout(timeout);
      clearTimeout(killTimeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimeout);
      if (spawnCallbackError) return reject(spawnCallbackError);
      if (exceeded) return reject(new Error(`${executable} exceeded its time/output limit`));
      if (code !== 0 && options.check !== false)
        return reject(new CommandError(executable, code ?? signal, stderr));
      resolve({ code, stdout, stderr });
    });
    if (Number.isSafeInteger(child.pid) && options.onSpawn) {
      try {
        const result = options.onSpawn(child.pid);
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch(() => {});
          throw new Error('onSpawn must complete synchronously');
        }
      } catch (error) {
        spawnCallbackError = error;
        // Do not leave an untracked child running when durable bookkeeping fails.
        terminate();
      }
    }
  });
}

export function shellQuote(value) {
  const text = String(value);
  if (text.includes('\0')) throw new Error('NUL is not allowed in a shell argument');
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export function shellCommand(executable, args = [], { cwd, env = {} } = {}) {
  const variables = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid environment name');
    return `${key}=${shellQuote(value)}`;
  });
  const command = ['env', ...variables, shellQuote(executable), ...args.map(shellQuote)].join(' ');
  return cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
}
