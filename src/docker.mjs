import path from 'node:path';
import crypto from 'node:crypto';
import { shellQuote } from './process.mjs';

function absolute(value, label) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\r\n\0]/.test(value))
    throw new Error(`Docker ${label} must be an absolute path`);
  return value;
}

export function validateDockerManagement(config) {
  if (config?.type !== 'docker') throw new Error('Docker management configuration required');
  if (
    typeof config.container !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(config.container)
  )
    throw new Error('Invalid Docker container name');
  for (const field of [
    'docker',
    'node',
    'entry',
    'codexHome',
    'accountDir',
    'home',
    'launcher',
    'stateRoot',
  ])
    absolute(config[field], field);
  if (typeof config.identity !== 'string' || !/^[a-zA-Z0-9-]+$/.test(config.identity))
    throw new Error('Invalid Docker installation identity');
  if (typeof config.user !== 'string' || !/^[a-zA-Z0-9_.:-]*$/.test(config.user))
    throw new Error('Invalid Docker container user');
  return config;
}

export function renderDockerLauncher(config) {
  validateDockerManagement(config);
  const quote = shellQuote;
  const command = (args) => args.map(quote).join(' ');
  const env = [
    `HOME=${config.home}`,
    `CODEX_HOME=${config.codexHome}`,
    `CODEX_MULTI_AUTH_DIR=${config.accountDir}`,
    'CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0',
    'CODEX_MULTI_AUTH_SYNC_CODEX_CLI=0',
    'CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE=0',
    'CODEX_MULTI_AUTH_APP_BIND=0',
    'CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL=0',
  ].flatMap((value) => ['--env', value]);
  const exec = (tty) =>
    command([config.docker, 'exec', tty, ...env, config.container, config.node, config.entry]);
  const companion = `${config.container}-setup-cli`;
  const run = (tty) =>
    command([
      config.docker,
      'run',
      '--rm',
      '--name',
      companion,
      '--pull',
      'never',
      '--volumes-from',
      config.container,
      ...(config.user ? ['--user', config.user] : []),
      tty,
      ...env,
    ]);
  const docker = quote(config.docker);
  const container = quote(config.container);
  return `#!/bin/sh
# Managed by codex-multi-auth-setup. Uses the existing Docker account pool.
set -eu
if [ "$#" -eq 1 ] && [ "$1" = '--setup-identity' ]; then
  printf '%s\\n' ${quote(config.identity)}
  exit 0
fi
if [ "$#" -eq 0 ]; then set -- --help; fi
readonly=0
if [ "$#" -eq 1 ]; then
  case "$1" in '--help'|'-h'|'--version'|'-v'|'status'|'list') readonly=1 ;; esac
elif [ "$#" -eq 2 ] && [ "$2" = '--json' ]; then
  case "$1" in 'status'|'list') readonly=1 ;; esac
fi
if [ "$readonly" -eq 1 ]; then
  if [ -t 0 ] && [ -t 1 ]; then exec ${exec('-it')} "$@"; fi
  exec ${exec('-i')} "$@"
fi
umask 077
state=${quote(config.stateRoot)}
mkdir -p "$state"
if ! mkdir "$state/maintenance.lock"; then
  printf '%s\\n' 'Another account operation is running; inspect the maintenance lock before retrying.' >&2
  exit 1
fi
restart=0
companion=0
keep_lock=0
operation="$(date +%Y%m%dT%H%M%S)-$$"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
record() {
  phase=$1
  printf '{"operationId":"%s","pid":%s,"createdAt":"%s","updatedAt":"%s","phase":"%s"}\\n' "$operation" "$$" "$started" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$phase" > "$state/maintenance.json.tmp-$$"
  mv "$state/maintenance.json.tmp-$$" "$state/maintenance.json"
}
record starting
finish() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ "$companion" -eq 1 ]; then
    if ${docker} inspect ${quote(companion)} >/dev/null 2>&1; then
      if ! ${docker} rm -f ${quote(companion)} >/dev/null; then
        printf '%s\\n' 'CLI container could not be removed; keeping proxy stopped and maintenance lock to protect account files.' >&2
        restart=0
        keep_lock=1
        result=1
      fi
    fi
  fi
  if [ "$restart" -eq 1 ]; then
    record resuming
    if ! ${docker} start ${container} >/dev/null; then
      printf '%s\\n' 'Could not restart the proxy container; start it before retrying.' >&2
      result=1
      keep_lock=1
    fi
  fi
  if [ "$keep_lock" -eq 0 ]; then
    if [ "$result" -eq 0 ]; then record completed; else record failed; fi
  else record recovery-required; fi
  if [ "$keep_lock" -eq 0 ]; then rmdir "$state/maintenance.lock" || true; fi
  exit "$result"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "$(${docker} inspect --format '{{.State.Running}}' ${container})" != 'true' ]; then
  printf '%s\\n' 'Proxy container must be running before account maintenance.' >&2
  exit 1
fi
if ${docker} inspect ${quote(companion)} >/dev/null 2>&1; then
  printf '%s\\n' 'An earlier CLI container still exists; inspect it before retrying.' >&2
  exit 1
fi
image=$(${docker} inspect --format '{{.Image}}' ${container})
restart=1
record stopping
${docker} stop --timeout -1 ${container} >/dev/null
backup="$state/backups/$(date +%Y%m%dT%H%M%S)-$$"
mkdir -p "$backup"
${docker} cp ${quote(`${config.container}:${config.accountDir}`)} "$backup/multi-auth"
${docker} cp ${quote(`${config.container}:${config.codexHome}`)} "$backup/codex"
printf 'Backup: %s\\n' "$backup" >&2
companion=1
record running
if [ -t 0 ] && [ -t 1 ]; then
  ${run('-it')} "$image" ${quote(config.node)} ${quote(config.entry)} "$@"
else
  ${run('-i')} "$image" ${quote(config.node)} ${quote(config.entry)} "$@"
fi
`;
}

export async function inspectDocker(target, container) {
  if (typeof container !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container))
    throw new Error('Invalid Docker container name');
  const info = await target.inspect();
  const docker = (await target.run('sh', ['-c', 'command -v docker'])).stdout.trim();
  absolute(docker, 'executable');
  const report = JSON.parse((await target.run(docker, ['inspect', container])).stdout)[0];
  if (!report?.State?.Running) throw new Error('Choose a running proxy container');
  const router = report.Config?.Cmd?.find(
    (arg) => typeof arg === 'string' && arg.endsWith('/scripts/codex-app-router.js'),
  );
  if (!router) throw new Error('Container does not run the codex-multi-auth router');
  const entry = path.posix.join(path.posix.dirname(router), 'codex-multi-auth.js');
  const source = `const fs=require('node:fs');const path=require('node:path');const entry=process.argv[1];fs.accessSync(entry);const pkg=JSON.parse(fs.readFileSync(path.join(path.dirname(entry),'../package.json'),'utf8'));if(pkg.name!=='codex-multi-auth')throw new Error('Unexpected proxy package');console.log(JSON.stringify({node:process.execPath,codexHome:process.env.CODEX_HOME,accountDir:process.env.CODEX_MULTI_AUTH_DIR,home:process.env.HOME,version:pkg.version}));`;
  const installed = JSON.parse(
    (await target.run(docker, ['exec', container, 'node', '-e', source, entry])).stdout,
  );
  const identity = crypto.randomUUID();
  return validateDockerManagement({
    type: 'docker',
    docker,
    container,
    entry,
    node: installed.node,
    codexHome: installed.codexHome,
    accountDir: installed.accountDir,
    home: installed.home,
    user: report.Config.User ?? '',
    launcher: path.posix.join(info.home, '.local/bin/codex-multi-auth'),
    stateRoot: path.posix.join(
      info.home,
      '.local/share/codex-multi-auth-setup',
      `docker-${container}`,
    ),
    identity,
  });
}

export async function installDockerManagement(target, container) {
  const config = await inspectDocker(target, container);
  const existing = target.config?.management;
  if (existing?.type === 'docker' && existing.container === container) {
    validateDockerManagement(existing);
    const identity = (await target.run(existing.launcher, ['--setup-identity'])).stdout.trim();
    if (identity !== existing.identity)
      throw new Error('Existing proxy identity does not match the profile; no launcher replaced');
    config.identity = existing.identity;
  }
  const backup = path.posix.join(
    config.stateRoot,
    'backups',
    `launcher-${Date.now()}-${crypto.randomUUID()}`,
  );
  if (await target.exists(config.launcher)) {
    await target.run('mkdir', ['-p', backup]);
    await target.run('chmod', ['700', backup]);
    await target.run('cp', ['-Pp', config.launcher, path.posix.join(backup, 'codex-multi-auth')]);
  }
  await target.write(config.launcher, renderDockerLauncher(config), 0o755);
  const pathEnv = (await target.run('sh', ['-c', 'printf "%s" "$PATH"'])).stdout;
  if (!pathEnv.split(':').includes(path.posix.dirname(config.launcher))) {
    const directory = shellQuote(path.posix.dirname(config.launcher));
    const script = `set -eu
umask 077
backup=${shellQuote(backup)}
index=0
update() {
  file=$1
  line=$2
  if [ -f "$file" ] && grep -Fqx -- "$line" "$file"; then return; fi
  mkdir -p "$backup" "$(dirname "$file")"
  index=$((index + 1))
  if [ -e "$file" ] || [ -L "$file" ]; then
    cp -Pp "$file" "$backup/$index-link"
    cp -Lp "$file" "$backup/$index-content"
  fi
  printf '\\n# codex-multi-auth-setup: terminal command\\n%s\\n' "$line" >> "$file"
}
case "\${SHELL##*/}" in
  bash)
    line=${shellQuote(`export PATH=${directory}:"$PATH"`)}
    update "$HOME/.bashrc" "$line"
    login="$HOME/.profile"
    for candidate in .bash_profile .bash_login .profile; do
      if [ -e "$HOME/$candidate" ]; then login="$HOME/$candidate"; break; fi
    done
    update "$login" "$line"
    ;;
  zsh) update "\${ZDOTDIR:-$HOME}/.zshrc" ${shellQuote(`export PATH=${directory}:"$PATH"`)} ;;
  fish) update "\${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" ${shellQuote(`fish_add_path --prepend -- ${directory}`)} ;;
  *) printf '%s\\n' 'Unsupported shell: add the installed CLI directory to PATH manually.' >&2; exit 1 ;;
esac`;
    await target.run('sh', ['-c', script]);
  }
  return config;
}
