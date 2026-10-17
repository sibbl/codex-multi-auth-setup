import * as p from '@clack/prompts';
import path from 'node:path';
import { validHost, defaultServerRoot } from './config.mjs';

export class Cancelled extends Error {
  constructor() {
    super('Cancelled. Existing backups are preserved.');
  }
}
export async function ask(promise) {
  const value = await promise;
  if (p.isCancel(value)) throw new Cancelled();
  return value;
}
export const confirm = (message, initialValue = false) =>
  ask(p.confirm({ message, initialValue, active: 'Yes', inactive: 'No' }));
export const text = (message, initialValue = '', validate) =>
  ask(p.text({ message, initialValue, validate }));
export const select = (message, options, initialValue) =>
  ask(p.select({ message, options, initialValue }));

export function absolutePath(value) {
  if (!value || !path.isAbsolute(value) || /[\r\n\0]/.test(value))
    return 'Enter an absolute path without control characters.';
  if (value === '/' || value === '/usr' || value === '/etc')
    return 'Choose a dedicated installation directory.';
}

export async function askSsh(previous = {}) {
  const host = await text(
    'SSH target: alias, user@hostname or user@IP',
    previous.host ?? '',
    (value) => (!validHost(value) ? 'Example: dev@server.local or my-nas' : undefined),
  );
  const port = Number(
    await text('SSH port', String(previous.port ?? 22), (value) =>
      !/^\d+$/.test(value ?? '') || Number(value) < 1 || Number(value) > 65535
        ? 'Enter a port from 1–65535.'
        : undefined,
    ),
  );
  const useFallback = await confirm(
    'Use a second address as a fallback, e.g. Tailscale when away from home?',
    Boolean(previous.fallbackHost),
  );
  const fallbackHost = useFallback
    ? await text(
        'Fallback SSH target (full alias or user@address)',
        previous.fallbackHost ?? '',
        (value) => (!validHost(value) ? 'Enter a valid SSH target.' : undefined),
      )
    : null;
  const customKey = await confirm('Use a specific SSH key file?', Boolean(previous.identityFile));
  const identityFile = customKey
    ? await text('Absolute path to the private SSH key', previous.identityFile ?? '', absolutePath)
    : null;
  p.note(
    'Both addresses must provide access to the same target server.\n.local names usually only work on the local network.\nYour SSH configuration and SSH agent are used.',
    'SSH connection',
  );
  return { host, port, fallbackHost, identityFile, hostKeyAlias: previous.hostKeyAlias ?? null };
}

export async function askStrategy(previous = 'sequential') {
  return select(
    'How should accounts be selected?',
    [
      {
        value: 'sequential',
        label: 'Sequential',
        hint: 'Follow account order; switch when limits are reached',
      },
      {
        value: 'hybrid',
        label: 'Hybrid',
        hint: 'Distribute by account health and available quota',
      },
      {
        value: 'round-robin',
        label: 'Round-Robin',
        hint: 'Currently unsupported by the proxy',
        disabled: true,
      },
    ],
    previous,
  );
}

export async function askUpdates(previous = {}) {
  const enabled = await confirm('Set up automatic updates?', previous.enabled ?? true);
  const cli = await confirm('Also install or update a managed Codex CLI?', previous.cli ?? true);
  const delayHours = Number(
    await text(
      'How many hours should proxy releases wait before installation?',
      String(previous.delayHours ?? 48),
      (value) =>
        !/^\d+(\.\d+)?$/.test(value ?? '') || Number(value) > 8760
          ? 'Enter 0–8760 hours; default: 48.'
          : undefined,
    ),
  );
  const intervalHours = enabled
    ? await select(
        'How often should updates be checked?',
        [1, 2, 3, 4, 6, 8, 12, 24].map((value) => ({
          value,
          label: value === 1 ? 'Hourly' : `Every ${value} hours`,
        })),
        previous.intervalHours ?? 1,
      )
    : (previous.intervalHours ?? 1);
  return { ...previous, enabled, cli, delayHours, intervalHours };
}

export async function askLocation(home, previous) {
  return text(
    'Installation directory on the target (e.g. a dedicated folder on NAS storage)',
    previous ?? defaultServerRoot(home),
    absolutePath,
  );
}

export async function busy(label, action) {
  const spinner = p.spinner();
  spinner.start(label);
  try {
    const result = await action();
    spinner.stop(label);
    return result;
  } catch (error) {
    spinner.stop(`${label}: failed`, 1);
    throw error;
  }
}

export { p };
