/**
 * @module logging/logger
 * @description Structured logging for FlowGuard.
 *
 * Design:
 * - FlowGuardLogger interface: debug, info, warn, error — each takes (service, message, extra?)
 * - createLogger(level, sink?): Level-filtered logger that delegates to an optional structured sink
 * - createNoopLogger(): Silent logger for tests and contexts without a client
 *
 * Architecture:
 * - The Plugin is the ONLY OpenCode logger writer (via client.app.log)
 * - Tools do NOT log — they return results; the plugin logs around them
 * - Rails are pure — no logger, no side effects
 *
 * The logger is injected into the plugin closure at init time.
 * Level filtering happens here; the sink receives structured log entries
 * so it can delegate to OpenCode's client.app.log() with the correct
 * level, service, message, and extra fields.
 *
 * OpenCode SDK contract (from docs):
 *   client.app.log({ body: { service, level, message, extra? } })
 *   Levels: "debug" | "info" | "warn" | "error"
 *
 * @version v2
 */

import type { LogLevel } from '../config/flowguard-config';

// ─── Level Ordering ──────────────────────────────────────────────────────────

/** Numeric severity for level comparison. Higher = more severe. */
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

// ─── Logger Interface ────────────────────────────────────────────────────────

/**
 * Structured logger for FlowGuard plugin internals.
 *
 * Every log call takes:
 * - service: caller identity (e.g. "plugin", "policy", "config")
 * - message: what happened
 * - extra?: optional structured data
 *
 * No child(), no withContext() — intentionally flat for v1.
 */
export interface FlowGuardLogger {
  debug(service: string, message: string, extra?: Record<string, unknown>): void;
  info(service: string, message: string, extra?: Record<string, unknown>): void;
  warn(service: string, message: string, extra?: Record<string, unknown>): void;
  error(service: string, message: string, extra?: Record<string, unknown>): void;
}

// ─── Structured Log Entry ────────────────────────────────────────────────────

/**
 * A structured log entry passed to the sink.
 *
 * Maps 1:1 to the OpenCode SDK's client.app.log() body shape:
 *   { service, level, message, extra? }
 *
 * The sink receives all fields so it can delegate to the SDK
 * with the correct level — not a pre-formatted string that
 * loses level information.
 */
export interface LogEntry {
  /** Log level: "debug" | "info" | "warn" | "error" (never "silent"). */
  level: 'debug' | 'info' | 'warn' | 'error';
  /** Caller identity (e.g. "plugin", "policy", "audit"). */
  service: string;
  /** Human-readable message. */
  message: string;
  /** Optional structured metadata. */
  extra?: Record<string, unknown>;
}

// ─── Client Sink ─────────────────────────────────────────────────────────────

/**
 * Structured output sink.
 *
 * In production, this wraps client.app.log() and forwards
 * the LogEntry fields directly to the OpenCode SDK.
 *
 * Abstracted so the logger itself has no OpenCode dependency.
 */
export type LogSink = (entry: LogEntry) => void;

// ─── Factories ───────────────────────────────────────────────────────────────

/**
 * Create a level-filtered logger.
 *
 * Messages below `minLevel` are suppressed. Messages at or above are
 * forwarded to the sink as structured LogEntry objects. If no sink is
 * provided, the logger is effectively a noop (but still does level
 * filtering — useful for testing).
 *
 * @param minLevel - Minimum severity to emit.
 * @param sink - Optional structured output function (e.g. wrapping client.app.log).
 */
export function createLogger(minLevel: LogLevel, sink?: LogSink): FlowGuardLogger {
  function emit(
    level: 'debug' | 'info' | 'warn' | 'error',
    service: string,
    message: string,
    extra?: Record<string, unknown>,
  ): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    if (!sink) return;

    sink({ level, service, message, extra });
  }

  return {
    debug: (service, message, extra) => emit('debug', service, message, extra),
    info: (service, message, extra) => emit('info', service, message, extra),
    warn: (service, message, extra) => emit('warn', service, message, extra),
    error: (service, message, extra) => emit('error', service, message, extra),
  };
}

/**
 * Create a silent logger. All methods are noops.
 *
 * Use in:
 * - Tests that don't need log output
 * - Contexts where no client is available
 * - Fallback when config loading itself fails
 */
export function createNoopLogger(): FlowGuardLogger {
  const noop = () => {};
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
}
