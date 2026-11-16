/**
 * @module persistence-lock-guard
 * @description Directory-based exclusive guard that serializes stale-lock reclamation.
 *
 * Why a guard at all: deciding that a lockfile is stale and then deleting it is
 * a time-of-check-to-time-of-use step. `unlink(path)` is unconditional, so a
 * reclaimer can remove a lock that another process created in the window
 * between its stale verdict and the deletion.
 *
 * This module removes the window instead of narrowing it. The guard is a
 * directory whose deletion is conditional on emptiness:
 *
 * - acquisition is `mkdir` (atomic, exactly one winner),
 * - ownership is `owner.<token>` inside that directory, so a release only ever
 *   unlinks its OWN entry by name,
 * - release is `unlink(own entry)` followed by `rmdir`, which fails with
 *   ENOTEMPTY while a foreign owner entry exists.
 *
 * Therefore no process can ever delete or displace a foreign guard, and a
 * claimant that lost its directory before writing detects the loss during the
 * post-write verification. Multiple claimants in one directory each withdraw
 * their own entry, so the state is self-healing rather than split.
 *
 * The main lockfile is only ever deleted by its own owner or while this guard
 * is held, and the guard refuses to be held for a live owner. That is what
 * makes the main lock's `read -> unlink` safe: while the lockfile exists no
 * acquirer can replace it (exclusive create fails), and no other reclaimer can
 * remove it (guard).
 *
 * Why not a kernel advisory lock (`flock`/`fcntl`): Node exposes no portable
 * advisory-lock API, `flock(1)` is not available on macOS, and a native addon
 * would add a platform-specific build dependency to this boundary. The guard
 * provides the property an advisory lock would provide here — a deletion that is
 * conditional on the object still being the one that was inspected — using only
 * `mkdir`/`rmdir`/`unlink` atomicity.
 *
 * Contract limit: the session directory is local per-user storage. This protocol
 * is NOT_VERIFIED on network filesystems whose `mkdir`/`rmdir` semantics are not
 * POSIX-atomic; cross-host session sharing is not part of the contract.
 *
 * Known residual risk: a process killed while writing its own guard entry can
 * leave a guard directory whose entry cannot be proven stale. Reclamation is
 * then unavailable for that session (acquisition still fails closed with
 * LOCK_TIMEOUT); it is never unsafe, because no unprovable entry is ever
 * evicted. The window is one `writeFile` of a fresh directory.
 *
 * @version v1
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  classifyLockOwner,
  defaultLivenessProbe,
  formatLockOwner,
  parseLockOwner,
  type LivenessProbe,
} from './persistence-lock-owner.js';

/** Suffix of the guard directory next to the lockfile it protects. */
export const RECLAIM_GUARD_SUFFIX = '.reclaim';

/** Poll interval while the guard is held by another process. */
const GUARD_POLL_MS = 25;

/** An empty guard directory older than this lost its claimant to a crash. */
const EMPTY_CLAIM_GRACE_MS = 2_000;

/** Upper bound on one guard acquisition attempt, whatever the caller's budget. */
const GUARD_MAX_WAIT_MS = 2_000;

export interface ReclaimGuard {
  release(): Promise<void>;
}

function guardDirPath(sessionDir: string, lockFile: string): string {
  return path.join(sessionDir, `${lockFile}${RECLAIM_GUARD_SUFFIX}`);
}

function isCode(err: unknown, ...codes: readonly string[]): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code !== undefined && codes.includes(code);
}

/** Remove a directory only when it is still empty; never touches entries. */
async function removeEmptyDir(dir: string): Promise<void> {
  try {
    await fs.rmdir(dir);
  } catch (err) {
    // ENOTEMPTY/EEXIST: a foreign owner entry appeared — leave it untouched.
    // EPERM/EBUSY: Windows keeps a directory busy while an entry is open.
    if (isCode(err, 'ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EBUSY')) return;
    throw err;
  }
}

async function readDirEntries(dir: string): Promise<string[] | null> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if (isCode(err, 'ENOENT')) return null;
    // A directory that exists but cannot be read is not a free guard.
    if (isCode(err, 'ENOTDIR', 'EACCES', 'EPERM')) return [];
    throw err;
  }
}

/** Withdraw only this claimant's own entry, then drop the directory if empty. */
async function withdrawClaim(dir: string, ownEntry: string): Promise<void> {
  await fs.unlink(path.join(dir, ownEntry)).catch((err: unknown) => {
    if (isCode(err, 'ENOENT')) return;
    if (isCode(err, 'EACCES', 'EPERM', 'EBUSY')) return;
    throw err;
  });
  await removeEmptyDir(dir);
}

/**
 * Write this claimant's entry and verify sole ownership of the directory.
 *
 * Verification re-reads the directory after the write, which is what detects a
 * claimant whose directory was reclaimed while it was descheduled: its file
 * either landed in a foreign directory (multiple entries) or its file is gone.
 * Any non-sole state withdraws its own entry and retries from `mkdir`.
 */
async function claimDirectory(dir: string, entry: string, content: string): Promise<boolean> {
  try {
    await fs.writeFile(path.join(dir, entry), content, { encoding: 'utf-8', flag: 'wx' });
  } catch (err) {
    if (isCode(err, 'ENOENT')) return false; // directory vanished — we lost
    if (isCode(err, 'EEXIST', 'EACCES', 'EPERM', 'EBUSY')) {
      await withdrawClaim(dir, entry);
      return false;
    }
    throw err;
  }
  const entries = await readDirEntries(dir);
  if (entries === null) return false;
  if (entries.length === 1 && entries[0] === entry) return true;
  // Lost the race: multiple claimants, or our directory was already reclaimed.
  await withdrawClaim(dir, entry);
  return false;
}

/** Reclaim a provably stale guard entry. Safe: only removes that exact name. */
async function reclaimStaleGuardEntry(
  dir: string,
  entries: readonly string[],
  probe: LivenessProbe,
): Promise<void> {
  const candidate = [...entries].sort()[0];
  if (candidate === undefined) return;
  if (entries.length !== 1) return;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, candidate), 'utf-8');
  } catch (err) {
    if (isCode(err, 'ENOENT')) return;
    if (isCode(err, 'EACCES', 'EPERM', 'EBUSY', 'EISDIR')) return;
    throw err;
  }
  const owner = parseLockOwner(raw);
  if (owner === null) return;
  const liveness = await classifyLockOwner(owner, probe);
  if (liveness.verdict !== 'stale') return;
  await fs.unlink(path.join(dir, candidate)).catch((err: unknown) => {
    if (isCode(err, 'ENOENT', 'EACCES', 'EPERM', 'EBUSY')) return;
    throw err;
  });
  await removeEmptyDir(dir);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the reclamation guard for one lockfile.
 *
 * Returns null when the guard could not be acquired inside the bounded window.
 * The caller must treat null as "do not reclaim now" and keep polling the main
 * lock: a missing guard never grants permission to delete anything.
 */
export async function acquireReclaimGuard(
  sessionDir: string,
  lockFile: string,
  timeoutMs: number,
  probe: LivenessProbe = defaultLivenessProbe(),
): Promise<ReclaimGuard | null> {
  const dir = guardDirPath(sessionDir, lockFile);
  const token = randomUUID();
  const entry = `owner.${token}`;
  const content = formatLockOwner({
    token,
    pid: process.pid,
    host: probe.host,
    bootRefMs: probe.bootRefMs,
    startIdentity: await probe.processStartIdentity(process.pid),
  });
  const waitMs = Math.max(0, Math.min(timeoutMs, GUARD_MAX_WAIT_MS));
  const deadline = Date.now() + waitMs;

  while (true) {
    try {
      await fs.mkdir(dir);
      if (await claimDirectory(dir, entry, content)) {
        return {
          release: async () => {
            await withdrawClaim(dir, entry);
          },
        };
      }
      // Lost the claim (vanished directory, competing claimant or a write the
      // filesystem refused). Bound the retry loop like every other path.
      if (Date.now() >= deadline) return null;
      await sleep(GUARD_POLL_MS);
      continue;
    } catch (err) {
      if (!isCode(err, 'EEXIST')) throw err;
    }

    const entries = await readDirEntries(dir);
    if (entries === null) continue; // freed between mkdir and readdir
    if (entries.length === 0) {
      // A claimant crashed between mkdir and its entry write. Only an empty
      // directory may be removed; rmdir fails if an entry appears meanwhile.
      const stats = await fs.stat(dir).catch(() => null);
      if (stats !== null && Date.now() - stats.mtimeMs > EMPTY_CLAIM_GRACE_MS) {
        await removeEmptyDir(dir);
        continue;
      }
    } else {
      await reclaimStaleGuardEntry(dir, entries, probe);
    }

    if (Date.now() >= deadline) return null;
    await sleep(GUARD_POLL_MS);
  }
}
