import path from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readJson, atomicJson } from './config.mjs';

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'ESRCH' ? false : null;
  }
}

export async function maintenanceStatus(root) {
  const owner = await readJson(path.join(root, 'maintenance.lock/owner.json'), null);
  if (!owner)
    return { state: existsSync(path.join(root, 'maintenance.lock')) ? 'unknown' : 'idle' };
  const ownerAlive = alive(owner.pid);
  const childAlive = owner.childPid === undefined ? false : alive(owner.childPid);
  return {
    state: ownerAlive === false && childAlive === false ? 'abandoned' : 'active',
    operationId: owner.operationId ?? null,
    reason: owner.reason,
    phase: owner.phase ?? 'unknown',
    createdAt: owner.createdAt,
    updatedAt: owner.updatedAt ?? owner.createdAt,
    ageSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(owner.createdAt)) / 1000)),
    ownerPid: owner.pid,
    childPid: owner.childPid ?? null,
    ownerAlive,
    childAlive,
    requiresRecovery:
      owner.requiresRecovery === true || (ownerAlive === false && childAlive === false),
  };
}

export async function maintenanceRecord(root, owner, phase, extra = {}) {
  const next = { ...owner, ...extra, phase, updatedAt: new Date().toISOString() };
  // Keep credentials, command arguments and upstream error bodies out of the journal.
  await atomicJson(path.join(root, 'maintenance.lock/owner.json'), next);
  await atomicJson(path.join(root, 'maintenance-state/operation.json'), next);
  return next;
}

export function newMaintenance(reason) {
  return {
    operationId: randomUUID(),
    pid: process.pid,
    reason,
    createdAt: new Date().toISOString(),
  };
}

export async function accountSnapshot(root) {
  const data = await readJson(path.join(root, 'data/multi-auth/openai-codex-accounts.json'), {});
  return {
    source: 'local-snapshot',
    activeIndex: data.activeIndex ?? null,
    pinnedAccountIndex: data.pinnedAccountIndex ?? null,
    accounts: (data.accounts ?? []).map((account, index) => ({
      index: index + 1,
      email: account.email ?? null,
      enabled: account.enabled !== false,
      active: data.activeIndex === index,
      pinned: data.pinnedAccountIndex === index,
    })),
    maintenance: await maintenanceStatus(root),
  };
}

export function snapshotCommand(args) {
  return (
    ['status', 'list'].includes(args[0]) &&
    (args.length === 1 || (args.length === 2 && args[1] === '--json'))
  );
}
