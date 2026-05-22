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
import { ensureDir, PersistenceError, isEnoent } from './persistence.js';

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

async function isLockStale(lockPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return true; // lockfile disappeared — effectively stale
    return false; // EACCES or other — fail-closed: treat as alive
  }
  const pidMatch = raw.match(/^pid=(\d+)/m);
  if (!pidMatch) return false; // malformed lock — do not auto-delete
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
 * @returns A lock handle with a token-protected {@code release()} method.
 * @throws PersistenceError with code {@code LOCK_TIMEOUT} if the lock cannot be acquired.
 */
export async function acquireSessionWriteLock(
  sessionDir: string,
  timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<SessionWriteLock> {
  await ensureDir(sessionDir);
  const lockPath = sessionLockPath(sessionDir);
  const token = crypto.randomUUID();
  const content = buildLockContent(token);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await fs.writeFile(lockPath, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      return { release: () => releaseLock(lockPath, token) };
    } catch (err) {
      if (!isEexist(err)) throw err;
    }

    // Lock exists — check if stale
    const stale = await isLockStale(lockPath);
    if (stale) {
      try {
        await fs.unlink(lockPath);
      } catch (err) {
        if (!isEnoent(err)) {
          // unlink failed with EACCES/etc. — fail-closed
          throw new PersistenceError(
            'LOCK_TIMEOUT',
            `Cannot remove stale lock file: ${err instanceof Error ? err.message : String(err)}. ` +
              `Lock file: ${lockPath}`,
          );
        }
      }
      continue;
    }

    if (Date.now() >= deadline) {
      let blockingPid: number | undefined;
      try {
        const raw = await fs.readFile(lockPath, 'utf-8');
        const m = raw.match(/^pid=(\d+)/m);
        if (m) blockingPid = Number(m[1]);
      } catch {
        // Best-effort — lock file may have been removed
      }
      throw new PersistenceError(
        'LOCK_TIMEOUT',
        `Could not acquire session write lock within ${timeoutMs}ms.` +
          (blockingPid !== undefined
            ? `\n  Blocking PID: ${blockingPid}\n  Lock file: ${lockPath}\n` +
              `  If process ${blockingPid} is not running, delete the lock file manually.`
            : `\n  Lock file: ${lockPath}`),
      );
    }

    await new Promise((r) => setTimeout(r, LOCK_POLL_INTERVAL_MS));
  }
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
