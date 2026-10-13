#!/usr/bin/env node
/**
 * @module demos/lib/run-lease
 * @description Atomic cross-process lease for demo runs, acquired BEFORE any
 * build. The lease file itself is the mutex (`wx` create, atomic); ownership is
 * the PID of the long-lived wrapper process plus a unique token, so a
 * short-lived helper cannot leave a dead-owner lease and release is
 * identity-checked. Stale leases (dead owner PID) are reclaimed once.
 *
 * Usage:
 *   node demos/lib/run-lease.mjs acquire --repo <checkout> [--pid <pid>]
 *   node demos/lib/run-lease.mjs release --repo <checkout> --token <token>
 *   node demos/lib/run-lease.mjs hold --repo <checkout> --hold-ms <ms>
 *
 * @version v2
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function demoLeasePath(repo) {
  const hash = createHash('sha256').update(repo).digest('hex').slice(0, 16);
  return join(tmpdir(), `flowguard-demo-run-${hash}.lease`);
}

function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readOwner(leaseFile) {
  try {
    return JSON.parse(readFileSync(leaseFile, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Acquire the lease atomically (`wx` create is the only mutation). The owner
 * PID must be the process that stays alive for the whole run (the wrapper
 * passes its own PID). A live owner blocks; a stale owner is reported for
 * EXPLICIT removal — automatically deleting a stale lease is racy, because a
 * second process can then delete a successor's fresh lease (same reasoning as
 * the installer lock).
 */
export function acquireLease(repo, { pid = process.pid } = {}) {
  const leaseFile = demoLeasePath(repo);
  const token = randomUUID();
  const record = JSON.stringify({ pid, token, repo, startedAt: new Date().toISOString() });
  try {
    writeFileSync(leaseFile, record, { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const owner = readOwner(leaseFile);
    if (ownerAlive(owner?.pid)) {
      throw new Error(
        `another demo run is active for ${repo} (pid ${String(owner?.pid)}); lease ${leaseFile}`,
      );
    }
    throw new Error(
      `stale demo run lease ${leaseFile} (owner pid ${String(owner?.pid ?? 'unknown')} is not ` +
        'running); administrative removal: node demos/lib/run-lease.mjs force-remove --repo <checkout>',
    );
  }
  return {
    leaseFile,
    token,
    release: () => releaseLease(repo, token),
  };
}

/**
 * Release ONLY the lease owned by `token`. A token is mandatory: without it
 * there is no owner proof, and no non-owner path may unlink a lease.
 */
export function releaseLease(repo, token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(
      'releaseLease requires the owner token; use forceRemoveLease for administrative removal',
    );
  }
  const leaseFile = demoLeasePath(repo);
  const owner = readOwner(leaseFile);
  if (owner === null) return false;
  if (owner.token !== token) return false;
  try {
    unlinkSync(leaseFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return false;
  }
  return true;
}

/**
 * Explicit administrative removal of a PROVABLY stale lease. Refuses when the
 * owner process is still alive or when the expected owner identity does not
 * match; an unreadable lease file must be removed manually after verification.
 */
export function forceRemoveLease(repo, { expectPid } = {}) {
  const leaseFile = demoLeasePath(repo);
  if (!existsSync(leaseFile)) return false;
  const owner = readOwner(leaseFile);
  if (owner === null) {
    throw new Error(
      `lease ${leaseFile} is unreadable; verify manually that no run is active, then remove the file`,
    );
  }
  if (ownerAlive(owner.pid)) {
    throw new Error(
      `refusing to remove an active demo run lease (pid ${String(owner.pid)}); stop the run first`,
    );
  }
  if (expectPid !== undefined && owner.pid !== expectPid) {
    throw new Error(
      `lease owner changed (expected pid ${String(expectPid)}, observed ${String(owner.pid)}); refusing`,
    );
  }
  unlinkSync(leaseFile);
  return true;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const value = (flag) => {
    const index = rest.indexOf(flag);
    if (index === -1 || rest[index + 1] === undefined) throw new Error(`${flag} is required`);
    return rest[index + 1];
  };
  const repo = value('--repo');
  if (command === 'acquire') {
    const pid = rest.includes('--pid') ? Number(value('--pid')) : process.pid;
    const lease = acquireLease(repo, { pid });
    console.log(JSON.stringify({ leaseFile: lease.leaseFile, token: lease.token }));
    return;
  }
  if (command === 'release') {
    const token = rest.includes('--token') ? value('--token') : undefined;
    const released = releaseLease(repo, token);
    console.log(JSON.stringify({ released }));
    return;
  }
  if (command === 'force-remove') {
    const expectPid = rest.includes('--expect-pid') ? Number(value('--expect-pid')) : undefined;
    const removed = forceRemoveLease(repo, { expectPid });
    console.log(JSON.stringify({ removed }));
    return;
  }
  if (command === 'hold') {
    const holdMs = Number(value('--hold-ms'));
    const lease = acquireLease(repo);
    console.log(JSON.stringify({ leaseFile: lease.leaseFile, token: lease.token }));
    const finish = () => {
      lease.release();
      process.exit(0);
    };
    process.on('SIGTERM', finish);
    process.on('SIGINT', finish);
    setTimeout(finish, holdMs);
    return;
  }
  throw new Error(`unknown command: ${String(command)}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(`[run-lease] ${String(error)}`);
    process.exitCode = 1;
  });
}
