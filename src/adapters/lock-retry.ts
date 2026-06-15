/**
 * @module lock-retry
 * @description Retry wrapper for session write lock acquisition.
 *
 * Wraps {@link acquireSessionWriteLock} with exponential backoff on transient
 * {@code LOCK_TIMEOUT} so callers that have already computed a result (e.g.
 * check evidence) can persist it without losing the result when multiple
 * processes contend for the session write lock.
 *
 * This module is PURE infrastructure — no domain context, no logging of
 * session/check identifiers. Callers inject domain context via callbacks.
 *
 * @version v1
 */

import { PersistenceError } from './persistence.js';
import { acquireSessionWriteLock, type SessionWriteLock } from './persistence-lock.js';

export { PersistenceError };

const DEFAULT_DELAYS_MS = [100, 200, 400];
const DEFAULT_TIMEOUT_MS = 10_000;

export interface SessionWriteLockRetryCallbacks {
  onRetry?: (attempt: number, delayMs: number, error: PersistenceError) => void;
}

/**
 * Execute an operation under the session write lock, retrying on transient
 * {@code LOCK_TIMEOUT} with exponential backoff.
 *
 * Attempts: 1 initial + {@code delaysMs.length} retries.
 * Default: 4 total attempts (delays [100ms, 200ms, 400ms]).
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param operation - Function to execute under the lock. Receives the lock
 *   handle so the caller can release early if needed. The lock is also released
 *   automatically in a finally-block after {@code operation} completes.
 * @param options - Optional configuration.
 * @param options.timeoutMs - Lock acquisition timeout per attempt (default 10s).
 * @param options.delaysMs - Delays before each retry (default [100, 200, 400]).
 * @param options.onRetry - Called before each retry with attempt number,
 *   delay, and the LOCK_TIMEOUT error that triggered the retry.
 * @returns The return value of {@code operation}.
 * @throws PersistenceError with code {@code LOCK_TIMEOUT_EXHAUSTED} after all
 *   retries are exhausted.
 */
export async function withSessionWriteLockRetry<T>(
  sessionDir: string,
  operation: (lock: SessionWriteLock) => Promise<T>,
  options?: {
    timeoutMs?: number;
    delaysMs?: number[];
    onRetry?: (attempt: number, delayMs: number, error: PersistenceError) => void;
  },
): Promise<T> {
  const delaysMs = options?.delaysMs ?? DEFAULT_DELAYS_MS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = delaysMs.length + 1;

  let lastError: PersistenceError | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const lock = await acquireSessionWriteLock(sessionDir, timeoutMs);
      try {
        return await operation(lock);
      } finally {
        await lock.release();
      }
    } catch (err) {
      if (!(err instanceof PersistenceError) || err.code !== 'LOCK_TIMEOUT') {
        throw err;
      }
      lastError = err;
      if (attempt >= delaysMs.length) break;
      const delayMs = delaysMs[attempt]!;
      options?.onRetry?.(attempt + 1, delayMs, err);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw new PersistenceError(
    'LOCK_TIMEOUT_EXHAUSTED',
    `Could not acquire session write lock after ${maxAttempts} attempts ` +
      `(${timeoutMs}ms timeout per attempt, ${delaysMs.join('/')}ms delays). ` +
      `Last error: ${lastError?.message ?? 'unknown'}`,
  );
}
