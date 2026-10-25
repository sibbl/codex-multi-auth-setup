import path from 'node:path';
import crypto from 'node:crypto';
import { shellQuote } from './process.mjs';

/** Explicit opt-in only. Preserve existing daemon/package-manager configuration. */
export async function installTailscale(target, info, root) {
  const found = await target.run('sh', ['-c', 'command -v tailscale || true']);
  if (found.stdout.trim()) return { installed: false, executable: found.stdout.trim() };
  if (info.platform === 'darwin') {
    const existingApp = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
    if (await target.exists(existingApp))
      return { installed: false, executable: existingApp, gui: true };
    const brew = await target.run('sh', ['-c', 'command -v brew || true']);
    if (!brew.stdout.trim())
      throw new Error(
        'Tailscale on macOS requires Homebrew or the official app: https://tailscale.com/download/mac',
      );
    await target.run(brew.stdout.trim(), ['install', '--cask', 'tailscale'], { interactive: true });
    return {
      installed: true,
      executable: '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      gui: true,
    };
  }
  if (info.platform !== 'linux')
    throw new Error('Tailscale installation supports Linux and macOS.');
  const backup = path.join(
    root,
    'backups',
    `tailscale-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`,
  );
  await target.run('mkdir', ['-p', backup]);
  await target.run('chmod', ['700', backup]);
  const backupScript = `set -eu\numask 077\nset --\nfor entry in /etc/default/tailscaled /etc/sysconfig/tailscaled /etc/tailscale /var/lib/tailscale /etc/apt/sources.list.d/tailscale.list /usr/share/keyrings/tailscale-archive-keyring.gpg /etc/yum.repos.d/tailscale.repo; do\n  if [ -e "$entry" ]; then set -- "$@" "$entry"; fi\ndone\nif [ "$#" -gt 0 ]; then tar -czf ${shellQuote(path.join(backup, 'configuration.tar.gz'))} "$@"; else printf 'No existing Tailscale configuration\\n' > ${shellQuote(path.join(backup, 'absent.txt'))}; fi`;
  // The same terminal handles sudo authentication. Nothing is piped into a root shell.
  const script = path.join(root, `.tailscale-backup-${crypto.randomUUID()}.sh`);
  const installer = path.join(root, `.tailscale-install-${crypto.randomUUID()}.sh`);
  await target.write(script, backupScript);
  try {
    await target.run('sudo', ['sh', script], { interactive: true });
    await target.run('curl', [
      '--fail',
      '--show-error',
      '--location',
      '--proto',
      '=https',
      '--proto-redir',
      '=https',
      '--max-time',
      '60',
      '-o',
      installer,
      'https://tailscale.com/install.sh',
    ]);
    await target.run('sh', [installer], { interactive: true });
    return { installed: true, executable: 'tailscale', backup };
  } finally {
    await target.run('rm', ['-f', script, installer]);
  }
}
