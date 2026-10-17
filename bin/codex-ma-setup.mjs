#!/usr/bin/env node
import { p, Cancelled } from '../src/prompts.mjs';
import { defaultClientRoot } from '../src/config.mjs';
import { Target } from '../src/target.mjs';
import {
  install,
  connect,
  resume,
  recover,
  configure,
  accountAction,
  updatesAction,
  doctor,
  menu,
  loadClient,
} from '../src/installer.mjs';

const help = `Codex Multi Auth Setup

  codex-ma-setup                         Geführtes Menü
  codex-ma-setup install                 Lokal oder per SSH installieren
  codex-ma-setup connect                 Vorhandenen SSH-Proxy verbinden
  codex-ma-setup resume                  Unterbrochene Einrichtung fortsetzen
  codex-ma-setup recover                 Unterbrochene Wartung wiederherstellen
  codex-ma-setup configure               Adresse, Routing, Updates ändern
  codex-ma-setup accounts add|list|remove Offizielle Account-Verwaltung
  codex-ma-setup stats                   codex-multi-auth status
  codex-ma-setup proxy -- <command>      Beliebigen offiziellen Proxy-Befehl öffnen
  codex-ma-setup updates enable|disable|configure|check|run|status
  codex-ma-setup doctor                  Verbindung und Modelle prüfen
  codex-ma-setup codex -- <args>          Verwaltete Codex-CLI auf dem Ziel starten

  --client-root /absoluter/pfad          Separate Installation / Client-Konfiguration
  --help                                Diese Hilfe

Accounts bleiben beim Proxy-Tool. „remove“ öffnet dessen offiziellen Account-Manager.
Round-Robin wird upstream nicht unterstützt; angeboten werden sequenziell und hybrid.
`;

async function main() {
  process.umask(0o077);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('Node.js >=22.19 erforderlich.');
  const args = process.argv.slice(2);
  let clientRoot = defaultClientRoot();
  const index = args.indexOf('--client-root');
  if (index !== -1 && (args.indexOf('--') === -1 || index < args.indexOf('--'))) {
    clientRoot = args[index + 1];
    if (!clientRoot?.startsWith('/') || /[\r\n\0]/.test(clientRoot))
      throw new Error('--client-root benötigt einen absoluten Pfad.');
    args.splice(index, 2);
  }
  const command = args.shift();
  if (['--help', '-h', 'help'].includes(command)) {
    process.stdout.write(help);
    return;
  }
  if (command === '--version') {
    process.stdout.write('0.1.0\n');
    return;
  }
  if (['install', 'connect', 'resume', 'recover', 'configure'].includes(command) || !command) {
    if (!process.stdin.isTTY)
      throw new Error('Der Einrichtungsdialog benötigt ein Terminal. Nutze --help für Befehle.');
  }
  switch (command) {
    case undefined:
      return menu(clientRoot);
    case 'install':
      return install(clientRoot);
    case 'connect':
      return connect(clientRoot);
    case 'resume':
      return resume(clientRoot);
    case 'recover':
      return recover(clientRoot);
    case 'configure':
      return configure(clientRoot);
    case 'doctor':
      return doctor(clientRoot);
    case 'stats':
      return accountAction(clientRoot, 'stats', args);
    case 'list':
      return accountAction(clientRoot, 'list', args);
    case 'accounts': {
      const action = args.shift();
      if (!['add', 'list', 'remove', 'dashboard', 'usage'].includes(action))
        throw new Error('accounts: add | list | remove | dashboard | usage');
      return accountAction(clientRoot, action, args);
    }
    case 'proxy':
      return accountAction(clientRoot, 'proxy', args[0] === '--' ? args.slice(1) : args);
    case 'updates':
      return updatesAction(clientRoot, args[0] ?? 'configure');
    case 'codex':
      return new Target(await loadClient(clientRoot)).worker(
        'codex',
        { args: args[0] === '--' ? args.slice(1) : args },
        { interactive: true },
      );
    default:
      throw new Error(`Unbekannter Befehl: ${command}. Nutze --help.`);
  }
}

main().catch((error) => {
  if (error instanceof Cancelled) p.cancel(error.message);
  else {
    p.log.error(error.message);
    p.log.info('Backups bleiben erhalten. Diagnose: codex-ma-setup doctor');
  }
  process.exitCode = error instanceof Cancelled ? 130 : 1;
});
