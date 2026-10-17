import * as p from '@clack/prompts';
import path from 'node:path';
import { validHost, defaultServerRoot } from './config.mjs';

export class Cancelled extends Error {
  constructor() {
    super('Abgebrochen. Bestehende Backups bleiben erhalten.');
  }
}
export async function ask(promise) {
  const value = await promise;
  if (p.isCancel(value)) throw new Cancelled();
  return value;
}
export const confirm = (message, initialValue = false) =>
  ask(p.confirm({ message, initialValue, active: 'Ja', inactive: 'Nein' }));
export const text = (message, initialValue = '', validate) =>
  ask(p.text({ message, initialValue, validate }));
export const select = (message, options, initialValue) =>
  ask(p.select({ message, options, initialValue }));

export function absolutePath(value) {
  if (!value || !path.isAbsolute(value) || /[\r\n\0]/.test(value))
    return 'Bitte absoluten Pfad ohne Steuerzeichen angeben.';
  if (value === '/' || value === '/usr' || value === '/etc')
    return 'Bitte einen eigenen Installationsordner wählen.';
}

export async function askSsh(previous = {}) {
  const host = await text(
    'SSH-Ziel: Alias, user@Hostname oder user@IP',
    previous.host ?? '',
    (value) => (!validHost(value) ? 'Beispiel: dev@server.local oder mein-nas' : undefined),
  );
  const port = Number(
    await text('SSH-Port', String(previous.port ?? 22), (value) =>
      !/^\d+$/.test(value ?? '') || Number(value) < 1 || Number(value) > 65535
        ? 'Port 1–65535 angeben.'
        : undefined,
    ),
  );
  const useFallback = await confirm(
    'Zweite Adresse als Fallback nutzen, z. B. Tailscale für unterwegs?',
    Boolean(previous.fallbackHost),
  );
  const fallbackHost = useFallback
    ? await text(
        'Fallback-SSH-Ziel (vollständiger Alias oder user@Adresse)',
        previous.fallbackHost ?? '',
        (value) => (!validHost(value) ? 'Gültiges SSH-Ziel angeben.' : undefined),
      )
    : null;
  const customKey = await confirm(
    'Bestimmte SSH-Schlüsseldatei verwenden?',
    Boolean(previous.identityFile),
  );
  const identityFile = customKey
    ? await text(
        'Absoluter Pfad zum privaten SSH-Schlüssel',
        previous.identityFile ?? '',
        absolutePath,
      )
    : null;
  p.note(
    'Beide Adressen benötigen denselben Zugang zum Zielserver.\n.local-Namen funktionieren normalerweise nur im lokalen Netz.\nSSH-Konfiguration und SSH-Agent werden berücksichtigt.',
    'SSH-Verbindung',
  );
  return { host, port, fallbackHost, identityFile, hostKeyAlias: previous.hostKeyAlias ?? null };
}

export async function askStrategy(previous = 'sequential') {
  return select(
    'Wie sollen Accounts ausgewählt werden?',
    [
      {
        value: 'sequential',
        label: 'Sequenziell',
        hint: 'Account-Reihenfolge; bei Limits ausweichen',
      },
      {
        value: 'hybrid',
        label: 'Hybrid',
        hint: 'Verteilung nach Gesundheit und verfügbarer Quota',
      },
      {
        value: 'round-robin',
        label: 'Round-Robin',
        hint: 'Vom Proxy derzeit nicht unterstützt',
        disabled: true,
      },
    ],
    previous,
  );
}

export async function askUpdates(previous = {}) {
  const enabled = await confirm('Automatische Updates einrichten?', previous.enabled ?? true);
  const cli = await confirm(
    'Zusätzlich eine verwaltete Codex-CLI installieren/aktualisieren?',
    previous.cli ?? true,
  );
  const delayHours = Number(
    await text(
      'Proxy-Releases erst nach wie vielen Stunden installieren?',
      String(previous.delayHours ?? 48),
      (value) =>
        !/^\d+(\.\d+)?$/.test(value ?? '') || Number(value) > 8760
          ? '0–8760 Stunden angeben; Standard: 48.'
          : undefined,
    ),
  );
  const intervalHours = enabled
    ? await select(
        'Wie oft nach Updates suchen?',
        [1, 2, 3, 4, 6, 8, 12, 24].map((value) => ({
          value,
          label: value === 1 ? 'Stündlich' : `Alle ${value} Stunden`,
        })),
        previous.intervalHours ?? 1,
      )
    : (previous.intervalHours ?? 1);
  return { ...previous, enabled, cli, delayHours, intervalHours };
}

export async function askLocation(home, previous) {
  return text(
    'Installationsordner auf dem Ziel (z. B. eigener Ordner auf dem NAS-Storage)',
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
    spinner.stop(`${label}: fehlgeschlagen`, 1);
    throw error;
  }
}

export { p };
