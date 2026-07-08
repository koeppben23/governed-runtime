/**
 * @module logging/log-context
 * @description Execution context for structured logging via AsyncLocalStorage.
 *
 * Separated from adapter-logger.ts — log context (traceId, sessionId) is
 * an orthogonal concern from the adapter DI scope. Both ALS stores coexist
 * independently and may be nested in either order.
 *
 * Design:
 * - `runWithLogContext(ctx, fn)` injects traceId + optional sessionId.
 * - `getLogContext()` returns the current context, or undefined.
 * - No dependency on FlowGuardLogger — pure context carrier.
 * - Used by createLogger() to auto-inject traceId/sessionId into every LogEntry.
 * - Long-term authority for diagnostic log correlation; adapter-logger's trace
 *   store is legacy compatibility only.
 *
 * @version v1
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  traceId: string;
  sessionId?: string;
}

const _store = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return _store.run(ctx, fn);
}

export async function runWithLogContextAsync<T>(ctx: LogContext, fn: () => Promise<T>): Promise<T> {
  return _store.run(ctx, fn);
}

export function getLogContext(): LogContext | undefined {
  return _store.getStore();
}
