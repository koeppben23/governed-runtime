/**
 * @module persistence-lock
 * @description Session-state write lock serialization.
 *
 * Guarantees that only one process writes session-state.json (or any other
 * named resource under the session directory) at a time. Uses atomic lockfile
 * acquisition (O_EXCL), owner identity instead of bare PID liveness, and
 * token-protected release.
 *
 * Removal invariant: the current owner releases its own lock at any time; every
 * other deletion of the lockfile happens only while the reclamation guard
 * ({@link acquireReclaimGuard}) is held. While the lockfile exists an acquirer
 * cannot create it (exclusive create fails), and a second reclaimer cannot
 * remove it (guard). That is what makes both `release()` and the stale
 * reclamation `read -> unlink` sequences safe: the only party able to replace
 * the lock in those windows is the current owner itself.
 *
 * A live owner is never evicted. Staleness requires positive proof (dead PID, a
 * different boot, or a reused PID detected by start identity); anything unknown
 * stays fail-closed and is treated as alive.
 *
 * @version v2
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { ensureDir, PersistenceError, isEnoent } from './persistence-core.js';
import { acquireReclaimGuard, type ReclaimGuard } from './persistence-lock-guard.js';
import {
  classifyLockOwner,
  defaultLivenessProbe,
  formatLockOwner,
  parseLockOwner,
  type LivenessProbe,
  type OwnerLiveness,
} from './persistence-lock-owner.js';

// -- Constants ----------------------------------------------------------------

const SESSION_LOCK_FILE = 'session-state.json.lock';
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_INTERVAL_MS = 100;

// -- Path Helper --------------------------------------------------------------

/** Resolve the session write lock file path. */
export function sessionLockPath(sessionDir: string): string {
  return path.join(sessionDir, SESSION_LOCK_FILE);
}

// -- Internals ----------------------------------------------------------------

function isEexist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'EEXIST';
}

/** Sentinel distinguishing "unreadable" from "missing" without throwing. */
const LOCK_UNREADABLE = '\u0000unreadable';

async function readLockContent(lockPath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(lockPath, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return undefined; // lockfile disappeared
    return LOCK_UNREADABLE; // EACCES or other — caller must fail closed
  }
}

/**
 * Liveness of an already-read lock body.
 *
 * - `undefined` body → the lockfile disappeared → effectively stale.
 * - unreadable/malformed body → fail-closed: treated as alive, never deleted.
 * - parseable owner → owner identity decides (boot, PID, start identity).
 */
async function classifyLockBody(
  raw: string | undefined,
  probe: LivenessProbe,
): Promise<OwnerLiveness & { readonly vanished: boolean }> {
  if (raw === undefined) {
    return { verdict: 'stale', reason: 'lockfile disappeared', vanished: true };
  }
  const owner = parseLockOwner(raw);
  if (owner === null) {
    return {
      verdict: 'alive',
      reason: 'lockfile is unreadable or carries no owner identity',
      vanished: false,
    };
  }
  return { ...(await classifyLockOwner(owner, probe)), vanished: false };
}

async function unlinkStaleLock(lockPath: string): Promise<void> {
  try {
    await fs.unlink(lockPath);
  } catch (err) {
    if (isEnoent(err)) return; // already removed by its owner
    throw new PersistenceError(
      'LOCK_TIMEOUT',
      `Cannot remove stale lock file: ${err instanceof Error ? err.message : String(err)}. ` +
        `Lock file: ${lockPath}`,
    );
  }
}

/**
 * Stage the complete owner record before the lock name exists.
 *
 * A crash between creating an empty lockfile and writing its record would leave
 * an unreadable lock that fail-closed acquisition can never distinguish from a
 * live owner. Staging the record first and publishing it with `link()` means
 * every visible lockfile already carries a complete record; a process kill
 * during the write only ever leaves an ignored `.tmp` staging file.
 *
 * The staged bytes are not fsynced: `link()` publishes them from the page cache,
 * which every process observes immediately, so an ordinary crash (SIGKILL,
 * process abort) can never expose a partial record. A machine power loss in the
 * write-back window can still leave a partial record, exactly as the previous
 * single-write lock file could; that residual risk is unchanged and remains
 * fail-closed. Paying one fsync per lock acquisition — on every governed state
 * write — to narrow that power-loss window is not a proportionate trade.
 */
async function stageLockRecord(tmpPath: string, content: string): Promise<void> {
  try {
    const handle = await fs.open(tmpPath, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf-8');
    } finally {
      await handle.close();
    }
  } catch (err) {
    throw new PersistenceError(
      'WRITE_FAILED',
      `Cannot stage lock record ${tmpPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Publish a staged record under the lock name; ties exclusively on EEXIST. */
async function publishLockRecord(tmpPath: string, lockPath: string): Promise<void> {
  try {
    await fs.link(tmpPath, lockPath);
  } catch (err) {
    if (isEexist(err)) throw err;
    throw new PersistenceError(
      'WRITE_FAILED',
      `Cannot publish lock file ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Reclaim a stale lock under the reclamation guard.
 *
 * Returns whether the caller may retry acquisition immediately. The guard is
 * always released; a missing guard is never permission to delete anything.
 */
async function reclaimStaleLock(
  lockPath: string,
  observed: string,
  probe: LivenessProbe,
  remainingMs: number,
): Promise<'retry' | 'churned'> {
  let guard: ReclaimGuard | null;
  try {
    guard = await acquireReclaimGuard(
      path.dirname(lockPath),
      path.basename(lockPath),
      remainingMs,
      probe,
    );
  } catch (err) {
    // Fail closed with the caller-facing lock vocabulary: a guard that cannot be
    // created must never look like a successful reclamation.
    throw new PersistenceError(
      'LOCK_TIMEOUT',
      `Cannot reclaim stale lock file: ${err instanceof Error ? err.message : String(err)}. ` +
        `Lock file: ${lockPath}`,
    );
  }
  if (guard === null) return 'churned';
  try {
    // Re-verify under the guard: a body that changed since the snapshot is live
    // contention, and the fail-closed rule applies to the FRESH body, never to
    // the observation that triggered this attempt.
    const confirm = await readLockContent(lockPath);
    if (confirm === undefined) return 'retry';
    const verdict = await classifyLockBody(confirm, probe);
    if (confirm !== observed || verdict.verdict !== 'stale') return 'churned';
    await unlinkStaleLock(lockPath);
    return 'retry';
  } finally {
    await guard.release();
  }
}

// -- Public API ---------------------------------------------------------------

/**
 * Handle representing an acquired session write lock.
 * Release is token-protected: it will only delete the lockfile
 * if it still contains the same token that was assigned at acquisition.
 * Replacement of that lockfile requires the reclamation guard, which refuses
 * to evict a live owner — so the token check cannot be raced by a new owner.
 */
export interface SessionWriteLock {
  release: () => Promise<void>;
  /**
   * Whether acquisition had to wait for a concurrent holder.
   *
   * `false` when the lockfile was created on the first atomic attempt
   * (uncontended). `true` when the poll loop was entered at least once
   * because another live holder held the lock (real contention).
   *
   * This is a deterministic signal derived from the acquisition path — not a
   * timing heuristic — so callers can faithfully distinguish "acquired
   * immediately" from "waited" without producing noisy contention reports.
   */
  waited: boolean;
}

/** Acquire a named lockfile using the canonical stale-lock recovery policy. */
export async function acquireNamedWriteLock(
  sessionDir: string,
  lockFile: string,
  lockLabel: string,
  timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
  probe: LivenessProbe = defaultLivenessProbe(),
): Promise<SessionWriteLock> {
  await ensureDir(sessionDir);
  const lockPath = path.join(sessionDir, lockFile);
  const token = crypto.randomUUID();
  const content = formatLockOwner({
    token,
    pid: process.pid,
    host: probe.host,
    bootRefMs: probe.bootRefMs,
    startIdentity: await probe.processStartIdentity(process.pid),
  });
  const deadline = Date.now() + timeoutMs;
  const stagingPath = path.join(sessionDir, `.${lockFile}.${token}.tmp`);
  let waited = false;

  try {
    await stageLockRecord(stagingPath, content);
    while (true) {
      try {
        await publishLockRecord(stagingPath, lockPath);
        return { release: () => releaseLock(lockPath, token), waited };
      } catch (err) {
        if (!isEexist(err)) throw err;
      }

      // Read the lock body once, then classify liveness from that snapshot.
      const observed = await readLockContent(lockPath);
      if (observed === undefined) {
        // Lockfile vanished before we could inspect it — retry acquisition
        // immediately; there is nothing to wait for or delete.
        continue;
      }
      const verdict = await classifyLockBody(observed, probe);
      if (verdict.vanished) continue;

      if (verdict.verdict === 'stale') {
        const outcome = await reclaimStaleLock(
          lockPath,
          observed,
          probe,
          Math.max(0, deadline - Date.now()),
        );
        if (outcome === 'retry') continue;
        waited = true;
        await enforceDeadlineThenPoll(lockPath, lockLabel, timeoutMs, deadline);
        continue;
      }

      waited = true;
      await enforceDeadlineThenPoll(lockPath, lockLabel, timeoutMs, deadline);
    }
  } finally {
    // The published lock keeps its own hard link to the staged inode; the
    // staging name is never part of the lock protocol.
    await fs.unlink(stagingPath).catch(() => {
      /* already gone or never published */
    });
  }
}

/**
 * Shared wait step for a contended acquisition: throw `LOCK_TIMEOUT` when the
 * deadline has passed, otherwise sleep one poll interval before the next
 * attempt. Used for a live holder, an unverifiable owner and a churning
 * snapshot alike, so the configured timeout is always enforced and none of
 * those paths can busy-loop.
 */
async function enforceDeadlineThenPoll(
  lockPath: string,
  lockLabel: string,
  timeoutMs: number,
  deadline: number,
): Promise<void> {
  if (Date.now() >= deadline) {
    let blockingPid: number | undefined;
    try {
      const raw = await fs.readFile(lockPath, 'utf-8');
      const match = raw.match(/^pid=(\d+)/m);
      if (match) blockingPid = Number(match[1]);
    } catch {
      // Best-effort only; the lock may have changed at the deadline.
    }
    throw new PersistenceError(
      'LOCK_TIMEOUT',
      `Could not acquire ${lockLabel} lock within ${timeoutMs}ms.` +
        (blockingPid === undefined
          ? `\n  Lock file: ${lockPath}`
          : `\n  Blocking PID: ${blockingPid}\n  Lock file: ${lockPath}`),
    );
  }
  await new Promise((r) => setTimeout(r, LOCK_POLL_INTERVAL_MS));
}

/**
 * Release the lock only if this process still owns it.
 *
 * Safe without a guard: the lockfile exists for the whole window, so no
 * acquirer can create a replacement, and the only party that could remove it —
 * a reclaimer — refuses to evict a live owner.
 */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const current = await fs.readFile(lockPath, 'utf-8');
    const lines = current.split('\n');
    if (!lines.includes(`token=${token}`)) return;
    await fs.unlink(lockPath);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
}

/**
 * Acquire an exclusive session write lock via lockfile.
 *
 * Uses O_EXCL create ({@code fs.writeFile flag 'wx'}) for atomic acquisition.
 * If the lock is held by a live process, polls every 100 ms up to the timeout.
 * If the lock is held by a dead process (stale lock), removes it under the
 * reclamation guard and retries.
 *
 * Prefer {@link withSessionWriteLock} for production code.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param timeoutMs - Lock acquisition timeout (default 10 seconds, min 100ms for tests).
 * @returns A lock handle with a token-protected {@code release()} method and a
 *   {@code waited} flag indicating whether acquisition contended with a live holder.
 * @throws PersistenceError with code {@code LOCK_TIMEOUT} if the lock cannot be acquired.
 */
export async function acquireSessionWriteLock(
  sessionDir: string,
  timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<SessionWriteLock> {
  return acquireNamedWriteLock(sessionDir, SESSION_LOCK_FILE, 'session write', timeoutMs);
}

/**
 * Execute a function under the session write lock.
 *
 * Acquires the lock before {@code fn}, releases it after (even on error).
 * This is the recommended API for production code.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param fn - Function to execute under the lock.
 * @param timeoutMs - Lock acquisition timeout (default 10 seconds).
 * @returns The return value of {@code fn}.
 * @throws PersistenceError with code {@code LOCK_TIMEOUT} if the lock cannot be acquired.
 */
export async function withSessionWriteLock<T>(
  sessionDir: string,
  fn: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  const lock = await acquireSessionWriteLock(sessionDir, timeoutMs);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
