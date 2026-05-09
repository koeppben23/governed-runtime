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
 * The logger also supports `warnOnce` — deduplicates repeated warnings within a scope.
 * Each `runWithAdapterLogger` / `setAdapterLogger` initializes a fresh cache.
 *
 * @version v5
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { FlowGuardLogger } from './logger.js';

/** Minimal logger subset needed by adapters. */
export interface AdapterLogger {
  info(service: string, message: string, extra?: Record<string, unknown>): void;
  warn(service: string, message: string, extra?: Record<string, unknown>): void;
  error(service: string, message: string, extra?: Record<string, unknown>): void;
  /** Like warn, but only emitted once per (service, message) pair within the current scope. */
  warnOnce?(service: string, message: string, extra?: Record<string, unknown>): void;
}

const _store = new AsyncLocalStorage<AdapterLogger>();

const _noop: AdapterLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Build an AdapterLogger that delegates to a base logger with an optional warnOnce cache.
 */
function _wrapWithWarnOnce(base: AdapterLogger, cache: Map<string, boolean>): AdapterLogger {
  return {
    info: base.info.bind(base),
    warn: base.warn.bind(base),
    error: base.error.bind(base),
    warnOnce(service: string, message: string, extra?: Record<string, unknown>): void {
      const key = `${service}:${message}`;
      if (cache.has(key)) return;
      cache.set(key, true);
      base.warn(service, message, extra);
    },
  };
}

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
 * All calls to `getAdapterLogger()` within `fn` will receive `log`.
 */
export function runWithAdapterLogger<T>(log: AdapterLogger, fn: () => T): T {
  return _store.run(_wrapWithWarnOnce(log, new Map()), fn);
}

/**
 * Execute an async function with the given adapter logger injected into the scope.
 */
export async function runWithAdapterLoggerAsync<T>(
  log: AdapterLogger,
  fn: () => Promise<T>,
): Promise<T> {
  return _store.run(_wrapWithWarnOnce(log, new Map()), () => fn());
}

// ─── Legacy API (test/CLI only — not for plugin use) ──────────────────────────

/**
 * @deprecated Use `runWithAdapterLogger` for plugin code.
 * Acceptable for CLI init and test scaffolding.
 */
export function setAdapterLogger(logger: AdapterLogger): void {
  _store.enterWith(_wrapWithWarnOnce(logger, new Map()));
}

/**
 * Reset to noop. Use in test cleanup (afterEach).
 */
export function resetAdapterLogger(): void {
  _store.enterWith(_noop);
}

/**
 * Wrap a FlowGuardLogger as an AdapterLogger (without warnOnce).
 * Use `runWithAdapterLogger(log, fn)` to get warnOnce support.
 */
export function toAdapterLogger(log: FlowGuardLogger): AdapterLogger {
  return {
    info: log.info.bind(log),
    warn: log.warn.bind(log),
    error: log.error.bind(log),
  };
}
