#!/usr/bin/env node
/**
 * @module demos/lib/run-lease
 * @description Atomic cross-process lease for demo runs. Acquired BEFORE any
 * build so two concurrently started wrappers cannot race on the same checkout
 * and build artifacts. Stale leases (dead owner PID) are reclaimed.
 *
 * Usage:
 *   node demos/lib/run-lease.mjs acquire --repo <checkout>
 *   node demos/lib/run-lease.mjs release --repo <checkout>
 *
 * @version v1
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function readOwner(leaseDir) {
  try {
    return JSON.parse(readFileSync(join(leaseDir, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Acquire the lease atomically. Throws when a live owner holds it; reclaims a
 * lease whose owner is no longer alive.
 */
export function acquireLease(repo, { pid = process.pid } = {}) {
  const leaseDir = demoLeasePath(repo);
  try {
    mkdirSync(leaseDir);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const owner = readOwner(leaseDir);
    if (ownerAlive(owner?.pid)) {
      throw new Error(
        `another demo run is active for ${repo} (pid ${String(owner.pid)}); lease ${leaseDir}`,
      );
    }
    rmSync(leaseDir, { recursive: true, force: true });
    mkdirSync(leaseDir);
  }
  writeFileSync(
    join(leaseDir, 'owner.json'),
    JSON.stringify({ pid, repo, startedAt: new Date().toISOString() }),
  );
  return {
    leaseDir,
    release() {
      rmSync(leaseDir, { recursive: true, force: true });
    },
  };
}

export function releaseLease(repo) {
  const leaseDir = demoLeasePath(repo);
  if (existsSync(leaseDir)) rmSync(leaseDir, { recursive: true, force: true });
  return leaseDir;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const repoIndex = rest.indexOf('--repo');
  const repo = repoIndex === -1 ? null : rest[repoIndex + 1];
  if (!repo) throw new Error('--repo <checkout> is required');
  if (command === 'acquire') {
    const lease = acquireLease(repo);
    console.log(lease.leaseDir);
    return;
  }
  if (command === 'release') {
    releaseLease(repo);
    return;
  }
  throw new Error(`unknown command: ${String(command)}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    console.error(`[run-lease] ${String(error)}`);
    process.exitCode = 1;
  }
}
