/**
 * @module persistence-lock
 * @description Session-state write lock serialization.
 *
 * Guarantees that only one process writes session-state.json at a time.
 * Uses atomic lockfile acquisition (O_EXCL), stale-lock recovery via PID
 * liveness, and token-protected release.
 *
 * @version v1
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { ensureDir, PersistenceError, isEnoent } from './persistence-core.js';

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

/**
 * Check whether a process with the given PID is alive.
 * Extracted for testability — overridden via module mocking when needed.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false; // process not found → dead
    return true; // EPERM or unknown → fail-closed: treat as alive
  }
}

function buildLockContent(token: string): string {
  return `pid=${process.pid}\ntoken=${token}\n`;
}

async function readLockContent(lockPath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(lockPath, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return undefined; // lockfile disappeared
    return LOCK_UNREADABLE; // EACCES or other — caller must fail closed
  }
}

/** Sentinel distinguishing "unreadable" from "missing" without throwing. */
const LOCK_UNREADABLE = '\u0000unreadable';

/**
 * Decide staleness from an already-read lock body.
 *
 * - `undefined` body → the lockfile disappeared → effectively stale.
 * - unreadable/malformed body → fail-closed: treat as alive (never auto-delete).
 * - parseable PID → stale iff the process is not alive.
 *
 * The `LOCK_UNREADABLE` guard is defensive and behaviourally equivalent to the
 * malformed-body fallthrough (the sentinel contains no `pid=`), so a mutation
 * removing it survives as an equivalent mutant.
 */
function isBodyStale(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  if (raw === LOCK_UNREADABLE) return false;
  const pidMatch = raw.match(/^pid=(\d+)/m);
  if (!pidMatch) return false;
  const pid = Number(pidMatch[1]);
  return !isProcessAlive(pid);
}

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

// -- Public API ---------------------------------------------------------------

/**
 * Handle representing an acquired session write lock.
 * Release is token-protected: it will only delete the lockfile
 * if it still contains the same token that was assigned at acquisition.
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
): Promise<SessionWriteLock> {
  await ensureDir(sessionDir);
  const lockPath = path.join(sessionDir, lockFile);
  const token = crypto.randomUUID();
  const content = buildLockContent(token);
  const deadline = Date.now() + timeoutMs;
  let waited = false;

  while (true) {
    try {
      await fs.writeFile(lockPath, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      return { release: () => releaseLock(lockPath, token), waited };
    } catch (err) {
      if (!isEexist(err)) throw err;
    }

    // Read the lock body once, then decide staleness from that snapshot.
    const observed = await readLockContent(lockPath);
    if (isBodyStale(observed)) {
      // Re-verify the body is unchanged immediately before unlink. If another
      // process replaced (or removed) the stale lock in the meantime, the
      // content differs and we must NOT delete their lock — retry instead. This
      // closes the check→unlink TOCTOU window (does not fully eliminate it
      // without an OS-atomic primitive; see KNOWN_ISSUES.md). A disappeared lock
      // reads as `undefined`, which likewise differs from the observed body.
      const confirm = await readLockContent(lockPath);
      if (confirm !== observed) {
        continue; // lock changed or vanished under us — never delete a foreign lock
      }
      try {
        await fs.unlink(lockPath);
      } catch (err) {
        if (!isEnoent(err)) {
          throw new PersistenceError(
            'LOCK_TIMEOUT',
            `Cannot remove stale lock file: ${err instanceof Error ? err.message : String(err)}. ` +
              `Lock file: ${lockPath}`,
          );
        }
      }
      continue;
    }

    waited = true;
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
}

/**
 * Acquire an exclusive session write lock via lockfile.
 *
 * Uses O_EXCL create ({@code fs.writeFile flag 'wx'}) for atomic acquisition.
 * If the lock is held by a live process, polls every 100 ms up to the timeout.
 * If the lock is held by a dead process (stale lock), removes it and retries.
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
