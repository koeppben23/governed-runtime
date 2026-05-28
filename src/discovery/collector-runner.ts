/**
 * @module discovery/collector-runner
 * @description Collector execution with timeout, timing, and structured diagnostics.
 *
 * Single responsibility: run a collector promise within a timeout budget,
 * capture wall-clock duration, and produce a CollectorDiagnostic.
 */

import type { CollectorDiagnostic, CollectorStatus } from './types.js';

/** Result of running a single collector through the diagnostic runner. */
export interface CollectorRunResult<T> {
  readonly data: T;
  readonly diagnostic: CollectorDiagnostic;
}

/**
 * Run a collector promise with timeout and produce structured diagnostics.
 *
 * - On fulfillment: records collector's own status + timing.
 * - On rejection (timeout or error): records 'failed' status, error info, timedOut flag.
 * - Always records wall-clock durationMs.
 */
export async function runCollectorWithDiagnostics<T>(
  name: string,
  promise: Promise<{ status: CollectorStatus; data: T }>,
  timeoutMs: number,
  defaultData: T,
): Promise<CollectorRunResult<T>> {
  const start = performance.now();

  try {
    const result = await withTimeout(promise, timeoutMs);
    const durationMs = Math.round(performance.now() - start);
    return {
      data: result.data,
      diagnostic: {
        name,
        status: result.status,
        durationMs,
        timedOut: false,
        ...(result.status === 'partial' ? { degradedReason: 'collector_reported_partial' } : {}),
      },
    };
  } catch (err: unknown) {
    const durationMs = Math.round(performance.now() - start);
    const isTimeout = err instanceof Error && err.message.includes('timed out');
    const errorCode = isTimeout
      ? 'COLLECTOR_TIMEOUT'
      : err instanceof Error
        ? err.name || 'Error'
        : 'UnknownError';
    return {
      data: defaultData,
      diagnostic: {
        name,
        status: 'failed',
        durationMs,
        errorCode,
        timedOut: isTimeout,
        degradedReason: isTimeout
          ? `Timed out after ${timeoutMs}ms`
          : `Collector error: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/**
 * Wrap a promise with a timeout.
 * Rejects with a timeout error if the promise doesn't resolve in time.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Collector timed out after ${ms}ms`)), ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}
