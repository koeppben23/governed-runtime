/**
 * @module adapters/__tests__/lock-retry.test
 * @description Tests for withSessionWriteLockRetry — exponential backoff retry
 *              wrapper around acquireSessionWriteLock (#504).
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { PersistenceError } from '../persistence.js';
import { withSessionWriteLockRetry } from '../lock-retry.js';
import type { SessionWriteLock } from '../persistence-lock.js';

// ─── Mock acquireSessionWriteLock ─────────────────────────────────────────────

vi.mock('../persistence-lock.js', () => ({
  acquireSessionWriteLock: vi.fn(),
  sessionLockPath: vi.fn(),
}));

import { acquireSessionWriteLock } from '../persistence-lock.js';

const mockAcquire = vi.mocked(acquireSessionWriteLock);

function makeLock(waited = false): SessionWriteLock {
  return { release: vi.fn().mockResolvedValue(undefined), waited };
}

function makeLockTimeoutError(message = 'lock timeout'): PersistenceError {
  return new PersistenceError('LOCK_TIMEOUT', message);
}

const TEST_SESSION_DIR = '/test/sessions/ses_abc123';

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── HAPPY ────────────────────────────────────────────────────────────────────

describe('withSessionWriteLockRetry', () => {
  it('HAPPY: succeeds on first attempt (uncontended)', async () => {
    const lock = makeLock();
    mockAcquire.mockResolvedValueOnce(lock);

    const operation = vi.fn().mockResolvedValue('result');

    const result = await withSessionWriteLockRetry(TEST_SESSION_DIR, operation);

    expect(result).toBe('result');
    expect(mockAcquire).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledWith(lock);
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it('HAPPY: succeeds on retry after LOCK_TIMEOUT', async () => {
    const lock = makeLock();
    mockAcquire
      .mockRejectedValueOnce(makeLockTimeoutError('contention #1'))
      .mockResolvedValueOnce(lock);

    const onRetry = vi.fn();
    const operation = vi.fn().mockResolvedValue('retried-result');

    const result = await withSessionWriteLockRetry(TEST_SESSION_DIR, operation, {
      delaysMs: [50],
      onRetry,
    });

    expect(result).toBe('retried-result');
    expect(mockAcquire).toHaveBeenCalledTimes(2);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, 50, expect.objectContaining({ code: 'LOCK_TIMEOUT' }));
  });

  it('HAPPY: succeeds on last retry (all previous attempts fail)', async () => {
    const lock = makeLock();
    mockAcquire
      .mockRejectedValueOnce(makeLockTimeoutError('fail #1'))
      .mockRejectedValueOnce(makeLockTimeoutError('fail #2'))
      .mockRejectedValueOnce(makeLockTimeoutError('fail #3'))
      .mockResolvedValueOnce(lock);

    const operation = vi.fn().mockResolvedValue('4th-try-result');

    const result = await withSessionWriteLockRetry(TEST_SESSION_DIR, operation, {
      delaysMs: [10, 10, 10],
    });

    expect(result).toBe('4th-try-result');
    expect(mockAcquire).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('HAPPY: lock is released even when operation throws', async () => {
    const lock = makeLock();
    mockAcquire.mockResolvedValueOnce(lock);
    const operation = vi.fn().mockRejectedValue(new Error('operation failure'));

    await expect(withSessionWriteLockRetry(TEST_SESSION_DIR, operation)).rejects.toThrow(
      'operation failure',
    );

    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(mockAcquire).toHaveBeenCalledTimes(1);
  });
});

// ─── BAD ──────────────────────────────────────────────────────────────────────

describe('withSessionWriteLockRetry BAD', () => {
  it('BAD: throws LOCK_TIMEOUT_EXHAUSTED after all retries exhausted', async () => {
    mockAcquire
      .mockRejectedValueOnce(makeLockTimeoutError('fail #1'))
      .mockRejectedValueOnce(makeLockTimeoutError('fail #2'))
      .mockRejectedValueOnce(makeLockTimeoutError('fail #3'));

    const onRetry = vi.fn();
    const operation = vi.fn();

    await expect(
      withSessionWriteLockRetry(TEST_SESSION_DIR, operation, {
        delaysMs: [10, 10],
        onRetry,
      }),
    ).rejects.toThrow('Could not acquire session write lock after 3 attempts');

    expect(mockAcquire).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(operation).not.toHaveBeenCalled();
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('BAD: defaults to 4 total attempts (1 initial + 3 retries with default delays)', async () => {
    mockAcquire
      .mockRejectedValueOnce(makeLockTimeoutError('fail #1'))
      .mockRejectedValueOnce(makeLockTimeoutError('fail #2'))
      .mockRejectedValueOnce(makeLockTimeoutError('fail #3'))
      .mockRejectedValueOnce(makeLockTimeoutError('fail #4'));

    await expect(withSessionWriteLockRetry(TEST_SESSION_DIR, vi.fn())).rejects.toThrow(
      'Could not acquire session write lock after 4 attempts',
    );

    expect(mockAcquire).toHaveBeenCalledTimes(4);
  });

  it('BAD: non-LOCK_TIMEOUT PersistenceError propagates immediately (no retry)', async () => {
    const readFailed = new PersistenceError('READ_FAILED', 'disk error');
    mockAcquire.mockRejectedValueOnce(readFailed);

    const operation = vi.fn();

    await expect(withSessionWriteLockRetry(TEST_SESSION_DIR, operation)).rejects.toThrow(
      'disk error',
    );

    expect(mockAcquire).toHaveBeenCalledTimes(1);
    expect(operation).not.toHaveBeenCalled();
  });

  it('BAD: non-PersistenceError propagates immediately (no retry)', async () => {
    mockAcquire.mockRejectedValueOnce(new Error('unexpected error'));

    await expect(withSessionWriteLockRetry(TEST_SESSION_DIR, vi.fn())).rejects.toThrow(
      'unexpected error',
    );

    expect(mockAcquire).toHaveBeenCalledTimes(1);
  });
});

// ─── CORNER ───────────────────────────────────────────────────────────────────

describe('withSessionWriteLockRetry CORNER', () => {
  it('CORNER: retry delays follow the specified order', async () => {
    mockAcquire
      .mockRejectedValueOnce(makeLockTimeoutError('fail #1'))
      .mockRejectedValueOnce(makeLockTimeoutError('fail #2'))
      .mockResolvedValueOnce(makeLock());

    const onRetry = vi.fn();
    const startTime = Date.now();

    await withSessionWriteLockRetry(TEST_SESSION_DIR, vi.fn().mockResolvedValue('ok'), {
      delaysMs: [100, 200],
      onRetry,
    });

    const elapsedMs = Date.now() - startTime;

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, 100, expect.anything());
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, 200, expect.anything());

    // Total delay should be roughly 300ms (± tolerance for timer resolution)
    expect(elapsedMs).toBeGreaterThanOrEqual(250);
    expect(elapsedMs).toBeLessThan(400);
  });

  it('CORNER: empty delaysMs array means 1 total attempt (no retries)', async () => {
    mockAcquire.mockRejectedValueOnce(makeLockTimeoutError('fail'));

    const onRetry = vi.fn();

    await expect(
      withSessionWriteLockRetry(TEST_SESSION_DIR, vi.fn(), { delaysMs: [], onRetry }),
    ).rejects.toThrow('Could not acquire session write lock after 1 attempts');

    expect(onRetry).not.toHaveBeenCalled();
    expect(mockAcquire).toHaveBeenCalledTimes(1);
  });
});

// ─── EDGE ─────────────────────────────────────────────────────────────────────

describe('withSessionWriteLockRetry EDGE', () => {
  it('EDGE: custom timeoutMs is passed to acquireSessionWriteLock', async () => {
    mockAcquire.mockResolvedValueOnce(makeLock());

    await withSessionWriteLockRetry(TEST_SESSION_DIR, vi.fn().mockResolvedValue('ok'), {
      timeoutMs: 5000,
    });

    expect(mockAcquire).toHaveBeenCalledWith(TEST_SESSION_DIR, 5000);
  });

  it('EDGE: error message includes attempt count and timeout info', async () => {
    mockAcquire
      .mockRejectedValueOnce(makeLockTimeoutError('contended'))
      .mockRejectedValueOnce(makeLockTimeoutError('still contended'));

    await expect(
      withSessionWriteLockRetry(TEST_SESSION_DIR, vi.fn(), {
        delaysMs: [10],
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(
      /Could not acquire session write lock after 2 attempts.*5000ms timeout.*10ms delays/,
    );
  });
});
