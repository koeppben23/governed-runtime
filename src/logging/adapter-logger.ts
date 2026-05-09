/**
 * @module logging/adapter-logger
 * @description Scoped adapter logger for adapter-layer modules via AsyncLocalStorage.
 *
 * Adapter modules (persistence, git, archive, init, etc.) perform critical I/O
 * but are called from multiple contexts (plugin, CLI, tests). Instead of a global
 * singleton, this module uses Node's AsyncLocalStorage to provide implicit
 * dependency injection — each execution scope gets its own logger, with automatic
 * cleanup when the scope ends.
 *
 * **Architecture — ALS-scoped injection:**
 * 1. The caller wraps adapter-heavy work in `runWithAdapterLogger(log, () => { ... })`.
 * 2. Adapter functions call `getAdapterLogger()` → receives the scoped logger.
 * 3. When the scope ends, the logger reverts to the previous one or noop.
 * 4. Tests get automatic isolation — no manual reset needed.
 *
 * This is real DI without changing any adapter function signatures.
 *
 * @version v4
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { FlowGuardLogger } from './logger.js';

/** Minimal logger subset needed by adapters. */
export interface AdapterLogger {
  info(service: string, message: string, extra?: Record<string, unknown>): void;
  warn(service: string, message: string, extra?: Record<string, unknown>): void;
  error(service: string, message: string, extra?: Record<string, unknown>): void;
}

const _store = new AsyncLocalStorage<AdapterLogger>();

const _noop: AdapterLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Get the adapter logger for the current execution scope.
 * Returns the scoped logger if in a `runWithAdapterLogger` context,
 * otherwise returns a silent noop.
 */
export function getAdapterLogger(): AdapterLogger {
  return _store.getStore() ?? _noop;
}

/**
 * Execute a function with the given adapter logger injected into the scope.
 * All calls to `getAdapterLogger()` within `fn` (including nested async calls)
 * will receive `log`.
 *
 * @returns The return value of `fn`.
 */
export function runWithAdapterLogger<T>(log: AdapterLogger, fn: () => T): T {
  return _store.run(log, fn);
}

/**
 * Execute an async function with the given adapter logger injected into the scope.
 * Convenience wrapper for async functions.
 */
export async function runWithAdapterLoggerAsync<T>(
  log: AdapterLogger,
  fn: () => Promise<T>,
): Promise<T> {
  return _store.run(log, () => fn());
}

// ─── Legacy API (test/CLI only — not for plugin use) ──────────────────────────

/**
 * @deprecated Use `runWithAdapterLogger` for plugin code.
 * Acceptable for CLI init and test scaffolding where ALS scopes are impractical.
 */
export function setAdapterLogger(logger: AdapterLogger): void {
  _store.enterWith(logger);
}

/**
 * @deprecated Use `runWithAdapterLogger` for workspace-scoped injection.
 */
export function setAdapterLoggerForWorkspace(_fingerprint: string, logger: AdapterLogger): void {
  _store.enterWith(logger);
}

/**
 * Reset is rarely needed — ALS automatically cleans up when scopes exit.
 * Use only in test cleanup (afterEach) to reset the top-level noop.
 */
export function resetAdapterLogger(): void {
  _store.enterWith(_noop);
}

/**
 * Wrap a FlowGuardLogger as an AdapterLogger.
 */
export function toAdapterLogger(log: FlowGuardLogger): AdapterLogger {
  return {
    info: log.info.bind(log),
    warn: log.warn.bind(log),
    error: log.error.bind(log),
  };
}
