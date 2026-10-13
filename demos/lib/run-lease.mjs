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
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
 * Acquire the lease atomically. The owner PID must be the process that stays
 * alive for the whole run (the wrapper passes its own PID). Throws when a live
 * owner holds it; reclaims a lease whose owner is gone.
 */
export function acquireLease(repo, { pid = process.pid } = {}) {
  const leaseFile = demoLeasePath(repo);
  const token = randomUUID();
  const record = JSON.stringify({ pid, token, repo, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(leaseFile, record, { flag: 'wx' });
      return {
        leaseFile,
        token,
        release: () => releaseLease(repo, token),
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = readOwner(leaseFile);
      if (ownerAlive(owner?.pid)) {
        throw new Error(
          `another demo run is active for ${repo} (pid ${String(owner?.pid)}); lease ${leaseFile}`,
        );
      }
      try {
        unlinkSync(leaseFile);
      } catch (reclaimError) {
        if (reclaimError?.code !== 'ENOENT') throw reclaimError;
      }
    }
  }
  throw new Error(`could not acquire the demo run lease ${leaseFile}`);
}

/**
 * Release only the lease owned by `token`; never removes a successor's lease.
 */
export function releaseLease(repo, token) {
  const leaseFile = demoLeasePath(repo);
  const owner = readOwner(leaseFile);
  if (owner === null) return false;
  if (token !== undefined && owner.token !== token) return false;
  try {
    unlinkSync(leaseFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return false;
  }
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
