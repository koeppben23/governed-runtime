/**
 * @module logging/logger.test
 * @description Tests for FlowGuard structured logger.
 *
 * Covers:
 * - createLogger: level filtering, sink delegation, structured entry shape
 * - createNoopLogger: all methods are noops
 * - Edge cases: no sink, silent level, extra passthrough
 * - SDK conformance: entries match OpenCode client.app.log() body shape
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createLogger,
  createNoopLogger,
  type FlowGuardLogger,
  type HealthAwareLogger,
  type LogEntry,
  type LoggerConfig,
} from './logger.js';
import { runWithLogContext } from './log-context.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

/** Capture all structured entries sent to a sink. */
function captureSink(): { entries: LogEntry[]; sink: (entry: LogEntry) => void } {
  const entries: LogEntry[] = [];
  return { entries, sink: (entry: LogEntry) => entries.push(entry) };
}

// =============================================================================
// createLogger
// =============================================================================

describe('createLogger', () => {
  // ── HAPPY ──────────────────────────────────────────────────────────────

  it('emits messages at or above the minimum level', () => {
    const { entries, sink } = captureSink();
    const log = createLogger('info', sink);

    log.info('test', 'hello');
    log.warn('test', 'warning');
    log.error('test', 'error');

    expect(entries).toHaveLength(3);
  });

  it('passes correct service and message to sink', () => {
    const { entries, sink } = captureSink();
    const log = createLogger('debug', sink);

    log.info('plugin', 'started');

    expect(entries[0]!.service).toBe('plugin');
    expect(entries[0]!.message).toBe('started');
  });

  it('passes correct level to sink (not hardcoded)', () => {
    const { entries, sink } = captureSink();
    const log = createLogger('debug', sink);

    log.debug('s', 'd');
    log.info('s', 'i');
    log.warn('s', 'w');
    log.error('s', 'e');

    expect(entries[0]!.level).toBe('debug');
    expect(entries[1]!.level).toBe('info');
    expect(entries[2]!.level).toBe('warn');
    expect(entries[3]!.level).toBe('error');
  });

  it('includes structured extra data when provided', () => {
    const { entries, sink } = captureSink();
    const log = createLogger('debug', sink);

    log.info('audit', 'event', { tool: 'hydrate', count: 3 });

    expect(entries[0]!.extra).toEqual({ tool: 'hydrate', count: 3 });
  });

  it('omits extra when not provided', () => {
    const { entries, sink } = captureSink();
    const log = createLogger('debug', sink);

    log.info('audit', 'event');

    expect(entries[0]!.extra).toBeUndefined();
  });

  // ── BAD ────────────────────────────────────────────────────────────────

  it('suppresses messages below the minimum level', () => {
    const { entries, sink } = captureSink();
    const log = createLogger('warn', sink);

    log.debug('test', 'debug msg');
    log.info('test', 'info msg');
    log.warn('test', 'warn msg');
    log.error('test', 'error msg');

    expect(entries).toHaveLength(2);
    expect(entries[0]!.message).toBe('warn msg');
    expect(entries[1]!.message).toBe('error msg');
  });

  it('suppresses all messages at silent level', () => {
    const { entries, sink } = captureSink();
    const log = createLogger('silent', sink);

    log.debug('test', 'debug');
    log.info('test', 'info');
    log.warn('test', 'warn');
    log.error('test', 'error');

    expect(entries).toHaveLength(0);
  });

  // ── CORNER ─────────────────────────────────────────────────────────────

  it('does not throw when sink is undefined', () => {
    const log = createLogger('debug');
    expect(() => log.info('test', 'hello')).not.toThrow();
    expect(() => log.error('test', 'oops')).not.toThrow();
  });

  it('debug level emits all messages', () => {
    const { entries, sink } = captureSink();
    const log = createLogger('debug', sink);

    log.debug('a', '1');
    log.info('a', '2');
    log.warn('a', '3');
    log.error('a', '4');

    expect(entries).toHaveLength(4);
  });

  it('error level only emits error', () => {
    const { entries, sink } = captureSink();
    const log = createLogger('error', sink);

    log.debug('a', '1');
    log.info('a', '2');
    log.warn('a', '3');
    log.error('a', '4');

    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe('error');
    expect(entries[0]!.message).toBe('4');
  });

  // ── EDGE ───────────────────────────────────────────────────────────────

  it('handles empty service and message', () => {
    const { entries, sink } = captureSink();
    const log = createLogger('debug', sink);

    log.info('', '');

    expect(entries[0]!.service).toBe('');
    expect(entries[0]!.message).toBe('');
  });

  it('passes extra with nested objects unchanged', () => {
    const { entries, sink } = captureSink();
    const log = createLogger('debug', sink);

    log.info('test', 'nested', { a: { b: { c: 1 } } });

    expect(entries[0]!.extra).toEqual({ a: { b: { c: 1 } } });
  });

  it('passes extra with empty object', () => {
    const { entries, sink } = captureSink();
    const log = createLogger('debug', sink);

    log.info('test', 'empty extra', {});

    expect(entries[0]!.extra).toEqual({});
  });

  // ── SDK CONFORMANCE ────────────────────────────────────────────────────

  it('LogEntry shape matches OpenCode client.app.log() body contract', () => {
    const { entries, sink } = captureSink();
    const log = createLogger('debug', sink);

    log.warn('audit', 'policy resolved', { mode: 'regulated' });

    const entry = entries[0]!;
    // OpenCode SDK: { service: string, level: string, message: string, extra?: Record }
    expect(typeof entry.service).toBe('string');
    expect(typeof entry.level).toBe('string');
    expect(typeof entry.message).toBe('string');
    expect(['debug', 'info', 'warn', 'error']).toContain(entry.level);
    expect(entry.extra).toBeDefined();
  });

  // ── G1: CORRELATION IDS ───────────────────────────────────────────────

  it('injects traceId into every emitted entry', () => {
    const { entries, sink } = captureSink();
    const log = createLogger('debug', sink);

    log.info('test', 'hello');
    log.error('test', 'error');

    for (const entry of entries) {
      expect(typeof entry.traceId).toBe('string');
      expect(entry.traceId!.length).toBeGreaterThan(0);
    }
  });

  it('traceIds are unique per log call when no context is set', () => {
    const { entries, sink } = captureSink();
    const log = createLogger('debug', sink);

    log.info('a', '1');
    log.info('a', '2');
    log.info('a', '3');

    const ids = entries.map((e) => e.traceId);
    const unique = new Set(ids);
    expect(unique.size).toBe(3);
  });

  it('injects sessionId when log-context is set', () => {
    const { entries, sink } = captureSink();
    const log = createLogger('debug', sink);

    runWithLogContext({ traceId: 'parent-trace', sessionId: 'session-abc' }, () => {
      log.warn('test', 'scoped');
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]!.traceId).toBe('parent-trace');
    expect(entries[0]!.sessionId).toBe('session-abc');
  });

  it('sessionId is undefined when context has no sessionId', () => {
    const { entries, sink } = captureSink();
    const log = createLogger('debug', sink);

    runWithLogContext({ traceId: 'no-session' }, () => {
      log.info('test', 'no session');
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]!.traceId).toBe('no-session');
    expect(entries[0]!.sessionId).toBeUndefined();
  });
});

// =============================================================================
// createNoopLogger
// =============================================================================

describe('createLogger with multiple sinks', () => {
  it('writes to all sinks when array provided', () => {
    const entries: LogEntry[] = [];
    const sink = (e: LogEntry) => entries.push(e);
    const sink1 = sink;
    const sink2 = sink;

    const log = createLogger('info', [sink1, sink2]);

    log.info('test', 'hello');

    expect(entries).toHaveLength(2);
  });

  it('handles sync sink errors gracefully', () => {
    const entries: LogEntry[] = [];
    const goodSink = (e: LogEntry) => entries.push(e);
    const badSink = () => {
      throw new Error('sink error');
    };

    const log = createLogger('info', [badSink, goodSink]);

    expect(() => log.info('test', 'error recovery')).not.toThrow();
    expect(entries).toHaveLength(1);
  });

  it('post-error recovery: logging works after sink crash', () => {
    const firstEntries: LogEntry[] = [];
    const secondEntries: LogEntry[] = [];
    let throwNext = true;
    const flakySink = (e: LogEntry) => {
      if (throwNext) {
        throwNext = false;
        throw new Error('temporary failure');
      }
      firstEntries.push(e);
    };
    const stableSink = (e: LogEntry) => secondEntries.push(e);

    const log = createLogger('info', [flakySink, stableSink]);

    // First call: flakySink throws (swallowed), stableSink records
    expect(() => log.info('s', 'first')).not.toThrow();
    expect(firstEntries).toHaveLength(0); // flakySink threw
    expect(secondEntries).toHaveLength(1);
    expect(secondEntries[0]!.message).toBe('first');

    // Second call: flakySink recovered, both sinks record
    const msg = log.info('s', 'second');
    expect(firstEntries).toHaveLength(1);
    expect(firstEntries[0]!.message).toBe('second');
    expect(secondEntries).toHaveLength(2);
    expect(secondEntries[1]!.message).toBe('second');
    void msg; // suppress unused
  });

  it('sink failure does not propagate to caller', () => {
    const throwingSink = () => {
      throw new Error('fatal sink');
    };
    const log = createLogger('info', throwingSink);
    // Logger contract: sink failures are contained, callers never see them
    expect(() => log.info('s', 'm')).not.toThrow();
    expect(() => log.warn('s', 'm')).not.toThrow();
    expect(() => log.error('s', 'm')).not.toThrow();
  });

  it('works with single sink passed as non-array', () => {
    const entries: LogEntry[] = [];
    const sink = (e: LogEntry) => entries.push(e);
    const log = createLogger('info', sink);

    log.info('test', 'single sink');

    expect(entries).toHaveLength(1);
  });
});

describe('createNoopLogger', () => {
  // ── HAPPY ──────────────────────────────────────────────────────────────

  it('returns an object with all four log methods', () => {
    const log = createNoopLogger();
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  it('all methods are noops (do not throw)', () => {
    const log = createNoopLogger();
    expect(() => log.debug('s', 'm')).not.toThrow();
    expect(() => log.info('s', 'm')).not.toThrow();
    expect(() => log.warn('s', 'm')).not.toThrow();
    expect(() => log.error('s', 'm', { key: 'val' })).not.toThrow();
  });

  // ── CORNER ─────────────────────────────────────────────────────────────

  it('satisfies the FlowGuardLogger interface', () => {
    const log: FlowGuardLogger = createNoopLogger();
    // Type check is the assertion — if this compiles, the interface is satisfied
    expect(log).toBeDefined();
  });
});

// =============================================================================
// Performance
// =============================================================================

describe('Performance', () => {
  // ── PERF ───────────────────────────────────────────────────────────────

  it('filtered-out log calls are fast (10000 iterations)', () => {
    const log = createLogger('error'); // no sink, filters below error
    const result = benchmarkSync(() => {
      log.debug('test', 'should be filtered');
    }, 10000);
    // Filtered log calls should be nearly free — under 0.1ms p99
    expect(result.p99Ms).toBeLessThan(0.1);
  });

  it('noop logger calls are fast (10000 iterations)', () => {
    const log = createNoopLogger();
    const result = benchmarkSync(() => {
      log.info('test', 'noop');
    }, 10000);
    expect(result.p99Ms).toBeLessThan(0.1);
  });
});

// =============================================================================
// G6: Rate Limiting
// =============================================================================

describe('createLogger — rate limiting', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rate limit is off by default (config not passed)', () => {
    const { entries, sink } = captureSink();
    const log = createLogger('debug', sink);

    // 200 rapid calls — all should pass since rate limiting is disabled
    for (let i = 0; i < 200; i++) {
      log.info('test', 'msg');
    }
    expect(entries).toHaveLength(200);

    const health = (log as HealthAwareLogger).getHealth();
    expect(health.rateLimitDroppedTotal).toBe(0);
  });

  it('wiring: rateLimit config from FlowGuardConfig shape activates rate limiting', () => {
    // This is the exact shape that createPluginLogger passes to createLogger
    const log = createLogger('info', [() => {}], {
      rateLimit: {
        enabled: true,
        maxPerSecond: 3,
        exemptLevels: ['error'],
        summaryIntervalMs: 60000,
      },
    });

    // 3 at level should pass
    for (let i = 0; i < 3; i++) log.info('svc', `m${i}`);
    // 4th should be rate-limited
    log.info('svc', 'excess');

    const health = (log as HealthAwareLogger).getHealth();
    expect(health.rateLimitDroppedTotal).toBeGreaterThanOrEqual(1);
  });

  it('allows up to maxPerSecond entries per key', () => {
    const { entries, sink } = captureSink();
    const cfg: LoggerConfig = {
      rateLimit: {
        enabled: true,
        maxPerSecond: 50,
        exemptLevels: [],
        summaryIntervalMs: 60000,
        _clock: () => Date.now(),
      },
    };
    const log = createLogger('debug', sink, cfg);

    for (let i = 0; i < 50; i++) {
      log.info('svc', 'msg');
    }
    expect(entries).toHaveLength(50);
  });

  it('drops entries exceeding maxPerSecond', () => {
    const { entries, sink } = captureSink();
    const cfg: LoggerConfig = {
      rateLimit: {
        enabled: true,
        maxPerSecond: 10,
        exemptLevels: [],
        summaryIntervalMs: 60000,
        _clock: () => Date.now(),
      },
    };
    const log = createLogger('debug', sink, cfg);

    for (let i = 0; i < 20; i++) {
      log.info('svc', 'msg');
    }
    expect(entries.length).toBeLessThanOrEqual(10);
    const health = (log as HealthAwareLogger).getHealth();
    expect(health.rateLimitDroppedTotal).toBeGreaterThan(0);
  });

  it('exempt levels are never dropped', () => {
    const { entries, sink } = captureSink();
    const cfg: LoggerConfig = {
      rateLimit: {
        enabled: true,
        maxPerSecond: 5,
        exemptLevels: ['error'],
        summaryIntervalMs: 60000,
        _clock: () => Date.now(),
      },
    };
    const log = createLogger('debug', sink, cfg);

    for (let i = 0; i < 20; i++) {
      log.error('svc', `e${i}`);
    }
    expect(entries).toHaveLength(20);
  });

  it('per-key isolation: audit:warn does not affect hook:warn', () => {
    const { entries, sink } = captureSink();
    const cfg: LoggerConfig = {
      rateLimit: {
        enabled: true,
        maxPerSecond: 5,
        exemptLevels: [],
        summaryIntervalMs: 60000,
        _clock: () => Date.now(),
      },
    };
    const log = createLogger('debug', sink, cfg);

    for (let i = 0; i < 5; i++) log.warn('audit', 'a');
    for (let i = 0; i < 5; i++) log.warn('hook', 'h');

    expect(entries).toHaveLength(10);
  });

  it('per-level isolation: audit:warn does not affect audit:info', () => {
    const { entries, sink } = captureSink();
    const cfg: LoggerConfig = {
      rateLimit: {
        enabled: true,
        maxPerSecond: 5,
        exemptLevels: [],
        summaryIntervalMs: 60000,
        _clock: () => Date.now(),
      },
    };
    const log = createLogger('debug', sink, cfg);

    for (let i = 0; i < 5; i++) log.warn('audit', 'w');
    for (let i = 0; i < 5; i++) log.info('audit', 'i');

    expect(entries).toHaveLength(10);
  });

  it('refills tokens over time', () => {
    const { entries, sink } = captureSink();
    let fakeNow = 0;
    const cfg: LoggerConfig = {
      rateLimit: {
        enabled: true,
        maxPerSecond: 100,
        exemptLevels: [],
        summaryIntervalMs: 60000,
        _clock: () => fakeNow,
      },
    };
    const log = createLogger('debug', sink, cfg);

    // Burst 100 — all pass
    for (let i = 0; i < 100; i++) log.info('svc', `b${i}`);
    expect(entries).toHaveLength(100);

    // 101st should be dropped
    log.info('svc', 'drop');
    expect(entries).toHaveLength(100);

    // Advance 500ms — ~50 tokens refilled
    fakeNow += 500;

    // Should allow ~50 more
    const before = entries.length;
    for (let i = 0; i < 50; i++) log.info('svc', `r${i}`);
    expect(entries.length - before).toBeGreaterThanOrEqual(49);
  });

  it('lazy timer: starts on first drop, writes summary, stops on idle', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    // Capture timer callbacks
    let timerCallback: (() => void) | null = null;
    let timerCleared = false;
    let unrefCalled = false;

    const origSetInterval = global.setInterval;
    const origClearInterval = global.clearInterval;

    global.setInterval = ((fn: () => void, ms: number) => {
      timerCallback = fn;
      return {
        unref: () => {
          unrefCalled = true;
        },
      } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;

    global.clearInterval = (() => {
      timerCleared = true;
      timerCallback = null;
    }) as typeof clearInterval;

    const cfg: LoggerConfig = {
      rateLimit: {
        enabled: true,
        maxPerSecond: 5,
        exemptLevels: [],
        summaryIntervalMs: 1000,
        _clock: () => Date.now(),
      },
    };

    try {
      const log = createLogger('debug', [() => {}], cfg);

      // No drops yet — timer should not be started
      expect(timerCallback).toBeNull();

      // Trigger drops
      for (let i = 0; i < 10; i++) log.info('svc', `m${i}`);
      // Drop happened — timer should now be started
      expect(timerCallback).not.toBeNull();
      expect(unrefCalled).toBe(true);

      // Fire the timer callback — should write summary to stderr
      const callCountBefore = stderr.mock.calls.length;
      timerCallback!();
      expect(stderr.mock.calls.length).toBeGreaterThan(callCountBefore);

      const summaryLine = stderr.mock.calls[stderr.mock.calls.length - 1]![0] as string;
      expect(summaryLine).toContain('[FlowGuard] rate limit:');
      expect(summaryLine).toContain('svc:info');
      expect(summaryLine).toContain('dropped');

      // Next interval with no new drops — timer should stop
      timerCallback!();
      expect(timerCleared).toBe(true);
    } finally {
      global.setInterval = origSetInterval;
      global.clearInterval = origClearInterval;
      stderr.mockRestore();
    }
  });
});

// =============================================================================
// G10: Health
// =============================================================================

describe('createLogger — health', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getHealth returns initial state', () => {
    const { sink } = captureSink();
    const log = createLogger('info', sink);
    const health = (log as HealthAwareLogger).getHealth();
    expect(health.level).toBe('info');
    expect(health.sinkFailuresTotal).toBe(0);
    expect(health.rateLimitDroppedTotal).toBe(0);
  });

  it('getHealth returns correct values after operations', () => {
    const { sink } = captureSink();
    const cfg: LoggerConfig = {
      rateLimit: {
        enabled: true,
        maxPerSecond: 5,
        exemptLevels: [],
        summaryIntervalMs: 60000,
        _clock: () => Date.now(),
      },
    };
    const log = createLogger('debug', sink, cfg);

    // Cause rate limit drops
    for (let i = 0; i < 20; i++) log.info('svc', 'm');
    const health = (log as HealthAwareLogger).getHealth();
    expect(health.level).toBe('debug');
    expect(health.rateLimitDroppedTotal).toBeGreaterThan(0);
  });

  it('noop logger getHealth returns zeroes and silent', () => {
    const log = createNoopLogger();
    const health = (log as HealthAwareLogger).getHealth();
    expect(health.level).toBe('silent');
    expect(health.sinkFailuresTotal).toBe(0);
    expect(health.rateLimitDroppedTotal).toBe(0);
  });
});

// =============================================================================
// G10: Sink failure counting
// =============================================================================

describe('createLogger — sink failure counting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts sync sink errors', () => {
    const { sink } = captureSink();
    const throwingSink = () => {
      throw new Error('sync failure');
    };
    const log = createLogger('info', [throwingSink, sink]);

    log.info('s', 'm1');
    log.info('s', 'm2');

    const health = (log as HealthAwareLogger).getHealth();
    expect(health.sinkFailuresTotal).toBe(2);
  });

  it('counts async sink rejections', async () => {
    const { sink } = captureSink();
    const asyncFailingSink = async () => {
      throw new Error('async failure');
    };
    const log = createLogger('info', [asyncFailingSink, sink]);

    // Trigger async sink — rejection is counted asynchronously
    log.info('s', 'm1');
    log.info('s', 'm2');

    // Wait for microtasks
    await new Promise((r) => setImmediate(r));

    const health = (log as HealthAwareLogger).getHealth();
    expect(health.sinkFailuresTotal).toBe(2);
  });
});
