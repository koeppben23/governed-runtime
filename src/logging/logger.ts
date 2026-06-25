/**
 * @module logging/logger
 * @description Structured logging for FlowGuard.
 *
 * Design:
 * - FlowGuardLogger interface: debug, info, warn, error — each takes (service, message, extra?)
 * - createLogger(level, sinks?, config?): Level-filtered logger with optional rate limiting
 * - createNoopLogger(): Silent logger for tests and contexts without a client
 *
 * Architecture:
 * - Plugin hooks remain the invocation logging authority (tool.execute.before/after).
 * - Tool/boundary layers may emit diagnostic logs for domain decisions that hooks
 *   cannot observe: blocked reasons, lock retry/exhaustion, check persistence,
 *   human decision origin, review pipeline outcomes, transition tracking, and
 *   archive/policy boundary events.
 * - Rails are pure — no logger, no side effects.
 * - MCP server uses the same FlowGuardLogger interface with a stderr console sink
 *   because it runs outside the plugin ALS scope.
 *
 * The logger is injected into the plugin closure at init time.
 * Level filtering happens here; the sinks receive structured log entries
 * so it can delegate to OpenCode's client.app.log() with the correct
 * level, service, message, and extra fields.
 *
 * OpenCode SDK contract (from docs):
 *   client.app.log({ body: { service, level, message, extra? } })
 *   Levels: "debug" | "info" | "warn" | "error"
 *
 * FlowGuard operational logs are diagnostic only. They are not audit evidence
 * and are not part of the governance SSOT. Audit/Archive remain separate.
 *
 * @version v4
 */

import type { LogLevel } from '../config/logging-config.js';
import { randomUUID } from 'node:crypto';
import { getLogContext } from './log-context.js';

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

/**
 * Logger that exposes health metrics (G10).
 */
export interface HealthAwareLogger extends FlowGuardLogger {
  getHealth(): LoggerHealth;
}

/**
 * Logger that supports runtime level changes (G5).
 *
 * Extends HealthAwareLogger with setLevel().
 */
export interface DynamicLogger extends HealthAwareLogger {
  setLevel(newLevel: LogLevel): void;
}

// ─── Structured Log Entry ────────────────────────────────────────────────────

/**
 * A structured log entry passed to the sink.
 *
 * Maps 1:1 to the OpenCode SDK's client.app.log() body shape:
 *   { service, level, message, extra? }
 *
 * traceId and sessionId are auto-injected by createLogger() from the
 * log-context (runWithLogContext). Adapter logs within the same context
 * inherit the same identifiers for end-to-end correlation.
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
  /** Auto-injected correlation trace id. Always present when emitted
   *  by createLogger; may be absent in test-constructed entries. */
  traceId?: string;
  /** Session id from log-context, if available. */
  sessionId?: string;
}

// ─── LogSink Interface ────────────────────────────────────────────────────────

/**
 * Structured output sink.
 *
 * All sinks are async to support file I/O and network calls.
 * Errors must be handled internally — the logger never throws.
 *
 * Sinks may return a Promise; createLogger counts async rejections
 * in sinkFailuresTotal (G10).
 */
export type LogSink = (entry: LogEntry) => void | Promise<void>;

// ─── Logger Health ────────────────────────────────────────────────────────────

/** Logger health counters (G10). */
export interface LoggerHealth {
  /** Current minimum log level. 'silent' for noop loggers. */
  level: LogLevel | 'silent';
  /** Total sink errors (sync throw + async rejection) since creation. */
  sinkFailuresTotal: number;
  /** Total rate-limited entries dropped since creation. */
  rateLimitDroppedTotal: number;
}

// ─── Logger Config ────────────────────────────────────────────────────────────

/** Logger tuning configuration (G6). */
export interface LoggerConfig {
  rateLimit?: {
    /** Enable rate limiting. Default: false (opt-in). */
    enabled: boolean;
    /** Max entries per second per (service, level) key. */
    maxPerSecond: number;
    /** Levels exempt from rate limiting. */
    exemptLevels: LogLevel[];
    /** Interval in ms between rate-limit summary reports on stderr. */
    summaryIntervalMs: number;
    /** @internal clock override for deterministic tests. */
    _clock?: () => number;
  };
}

// ─── Token Bucket ────────────────────────────────────────────────────────────

interface Bucket {
  tokens: number;
  lastRefill: number;
  dropped: number;
}

class TokenBucket {
  private readonly _buckets = new Map<string, Bucket>();
  private readonly _capacity: number;
  private readonly _refillRate: number;
  private readonly _exemptLevels: Set<LogLevel>;
  private readonly _clock: () => number;
  private readonly _summaryIntervalMs: number;
  private _timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    maxPerSecond: number,
    exemptLevels: LogLevel[],
    clock: () => number,
    summaryIntervalMs: number,
  ) {
    this._capacity = maxPerSecond;
    this._refillRate = maxPerSecond / 1000;
    this._exemptLevels = new Set(exemptLevels);
    this._clock = clock;
    this._summaryIntervalMs = summaryIntervalMs;
  }

  allow(level: 'debug' | 'info' | 'warn' | 'error', service: string): boolean {
    if (this._exemptLevels.has(level)) return true;

    const key = `${service}:${level}`;
    const now = this._clock();
    let bucket = this._buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this._capacity, lastRefill: now, dropped: 0 };
      this._buckets.set(key, bucket);
    }

    this._refill(bucket, now);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    bucket.dropped++;
    this._ensureTimer();
    return false;
  }

  destroy(): void {
    this._stopTimer();
  }

  private _refill(bucket: Bucket, now: number): void {
    const elapsed = now - bucket.lastRefill;
    if (elapsed <= 0) return;
    bucket.tokens = Math.min(this._capacity, bucket.tokens + elapsed * this._refillRate);
    bucket.lastRefill = now;
  }

  private _ensureTimer(): void {
    if (this._timer) return;
    this._timer = setInterval(() => {
      let anyDrop = false;
      for (const [key, bucket] of this._buckets) {
        if (bucket.dropped > 0) {
          anyDrop = true;
          process.stderr.write(
            `[FlowGuard] rate limit: ${key} dropped ${bucket.dropped} ` +
              `in last ${Math.round(this._summaryIntervalMs / 1000)}s\n`,
          );
          bucket.dropped = 0;
        }
      }
      if (!anyDrop) {
        this._stopTimer();
      }
    }, this._summaryIntervalMs);
    this._timer?.unref?.();
  }

  private _stopTimer(): void {
    const timer = this._timer;
    this._timer = null;
    if (timer) clearInterval(timer);
  }
}

// ─── Factories ────────────────────────────────────────────────────────────────

/**
 * Create a level-filtered logger with optional rate limiting and health tracking.
 *
 * @param minLevel - Minimum severity to emit.
 * @param sinks - Optional array of structured output functions.
 * @param config - Optional logger tuning configuration.
 */
export function createLogger(
  minLevel: LogLevel,
  sinks?: LogSink | LogSink[],
  config?: LoggerConfig,
): DynamicLogger {
  const sinkArray = Array.isArray(sinks) ? sinks : sinks ? [sinks] : [];

  let currentMinLevel: LogLevel = minLevel;
  let sinkFailuresTotal = 0;
  let rateLimitDroppedTotal = 0;

  const rateLimit = config?.rateLimit;
  const tokenBucket =
    rateLimit?.enabled === true
      ? new TokenBucket(
          rateLimit.maxPerSecond,
          rateLimit.exemptLevels,
          rateLimit._clock ?? (() => Date.now()),
          rateLimit.summaryIntervalMs,
        )
      : null;

  function emit(
    level: 'debug' | 'info' | 'warn' | 'error',
    service: string,
    message: string,
    extra?: Record<string, unknown>,
  ): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[currentMinLevel]) return;
    if (sinkArray.length === 0) return;

    if (tokenBucket && !tokenBucket.allow(level, service)) {
      rateLimitDroppedTotal++;
      return;
    }

    const ctx = getLogContext();
    const entry: LogEntry = {
      level,
      service,
      message,
      extra,
      traceId: ctx?.traceId ?? randomUUID(),
      sessionId: ctx?.sessionId,
    };

    for (const sink of sinkArray) {
      try {
        const result = sink(entry);
        void Promise.resolve(result).catch(() => {
          sinkFailuresTotal++;
        });
      } catch {
        sinkFailuresTotal++;
      }
    }
  }

  return {
    debug: (service, message, extra) => emit('debug', service, message, extra),
    info: (service, message, extra) => emit('info', service, message, extra),
    warn: (service, message, extra) => emit('warn', service, message, extra),
    error: (service, message, extra) => emit('error', service, message, extra),
    getHealth(): LoggerHealth {
      return {
        level: currentMinLevel,
        sinkFailuresTotal,
        rateLimitDroppedTotal,
      };
    },
    setLevel(newLevel: LogLevel): void {
      currentMinLevel = newLevel;
    },
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
export function createNoopLogger(): DynamicLogger {
  const noop = () => {};
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    getHealth: () => ({
      level: 'silent' as const,
      sinkFailuresTotal: 0,
      rateLimitDroppedTotal: 0,
    }),
    setLevel: noop,
  };
}
