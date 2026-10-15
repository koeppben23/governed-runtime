/**
 * @module integration/plugin-shared.test
 * @description Direct tests for plugin runtime helpers: tool trace correlation
 *              and session-scoped cleanup.
 *
 * Covers host call identity edge cases that the handler-level suites do not:
 * duplicate host callIDs, foreign after-hook calls without a prior before-hook,
 * and per-session cleanup isolation.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it, vi } from 'vitest';
import {
  cleanupSessionRuntime,
  consumeToolLatency,
  getToolTraceId,
  recordToolLatencyStart,
  type FlowGuardPluginRuntime,
} from './plugin-shared.js';

function makeRuntime(): FlowGuardPluginRuntime {
  return {
    ws: { invalidateChainState: vi.fn() },
    toolTraceIds: new Map<string, string>(),
    toolLatencyStarts: new Map<string, number>(),
    activeCommandScopes: new Map(),
    checkReworkContinuations: new Set(),
  } as unknown as FlowGuardPluginRuntime;
}

describe('getToolTraceId', () => {
  it('HAPPY: returns the host callID verbatim for before and after', () => {
    const runtime = makeRuntime();
    const input = { callID: 'call-1', tool: 'read', sessionID: 's1' };

    expect(getToolTraceId(runtime, input, 'before')).toBe('call-1');
    expect(getToolTraceId(runtime, input, 'after')).toBe('call-1');
    expect(runtime.toolTraceIds.size).toBe(0);
  });

  it('HAPPY: correlates before/after without a callID through the fallback registry', () => {
    const runtime = makeRuntime();
    const input = { tool: 'read', sessionID: 's1' };

    const before = getToolTraceId(runtime, input, 'before');
    expect(runtime.toolTraceIds.size).toBe(1);
    const after = getToolTraceId(runtime, input, 'after');

    expect(after).toBe(before);
    expect(runtime.toolTraceIds.size).toBe(0);
  });

  it('BAD: duplicate host callIDs stay deterministic and never touch the registry', () => {
    const runtime = makeRuntime();
    const input = { callID: 'dup-call', tool: 'read', sessionID: 's1' };

    expect(getToolTraceId(runtime, input, 'before')).toBe('dup-call');
    expect(getToolTraceId(runtime, input, 'before')).toBe('dup-call');
    expect(getToolTraceId(runtime, input, 'after')).toBe('dup-call');
    expect(runtime.toolTraceIds.size).toBe(0);
  });

  it('CORNER: a foreign after-hook call without a prior before yields a fresh id', () => {
    const runtime = makeRuntime();

    const id = getToolTraceId(runtime, { tool: 'read', sessionID: 's1' }, 'after');

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(runtime.toolTraceIds.size).toBe(0);
  });

  it('EDGE: missing identity yields a fresh id without a registry key', () => {
    const runtime = makeRuntime();

    expect(typeof getToolTraceId(runtime, {}, 'before')).toBe('string');
    expect(runtime.toolTraceIds.size).toBe(0);
  });
});

describe('cleanupSessionRuntime', () => {
  it('HAPPY: removes every ephemeral entry for the terminated session only', () => {
    const runtime = makeRuntime();
    runtime.activeCommandScopes.set('s1', 'check');
    runtime.activeCommandScopes.set('s2', 'check');
    runtime.checkReworkContinuations.add('s1');
    runtime.checkReworkContinuations.add('s2');
    runtime.toolTraceIds.set('s1:read', 'trace-1');
    runtime.toolTraceIds.set('s2:read', 'trace-2');

    cleanupSessionRuntime(runtime, 's1');

    expect(runtime.ws.invalidateChainState).toHaveBeenCalledWith('s1');
    expect(runtime.activeCommandScopes.has('s1')).toBe(false);
    expect(runtime.checkReworkContinuations.has('s1')).toBe(false);
    expect(runtime.toolTraceIds.has('s1:read')).toBe(false);
    expect(runtime.activeCommandScopes.get('s2')).toBe('check');
    expect(runtime.checkReworkContinuations.has('s2')).toBe(true);
    expect(runtime.toolTraceIds.get('s2:read')).toBe('trace-2');
  });

  it('EDGE: cleaning an unknown session is a no-op', () => {
    const runtime = makeRuntime();

    expect(() => cleanupSessionRuntime(runtime, 'missing')).not.toThrow();
    expect(runtime.ws.invalidateChainState).toHaveBeenCalledWith('missing');
  });
});

describe('diagnostic tool latency registry', () => {
  it('HAPPY: measures one call from before-hook end to after-hook entry', () => {
    const runtime = makeRuntime();
    const input = { callID: 'c1', tool: 'read', sessionID: 's1' };
    recordToolLatencyStart(runtime, input);
    const observed = consumeToolLatency(runtime, input);
    expect(observed).toHaveProperty('beforeToAfterMs');
    expect((observed as { beforeToAfterMs: number }).beforeToAfterMs).toBeGreaterThanOrEqual(0);
    expect(runtime.toolLatencyStarts.size).toBe(0);
  });

  it('BAD: concurrent calls of the same tool in one session keep their own starts', () => {
    vi.useFakeTimers();
    try {
      const runtime = makeRuntime();
      const first = { callID: 'c1', tool: 'bash', sessionID: 's1' };
      const second = { callID: 'c2', tool: 'bash', sessionID: 's1' };
      recordToolLatencyStart(runtime, first);
      vi.advanceTimersByTime(100);
      recordToolLatencyStart(runtime, second);
      vi.advanceTimersByTime(50);
      const secondObserved = consumeToolLatency(runtime, second) as { beforeToAfterMs: number };
      const firstObserved = consumeToolLatency(runtime, first) as { beforeToAfterMs: number };
      expect(secondObserved.beforeToAfterMs).toBeCloseTo(50, 0);
      expect(firstObserved.beforeToAfterMs).toBeCloseTo(150, 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('BAD: a call without a callID is never correlated and never consumes a foreign start', () => {
    const runtime = makeRuntime();
    recordToolLatencyStart(runtime, { callID: 'c1', tool: 'bash', sessionID: 's1' });
    recordToolLatencyStart(runtime, { tool: 'bash', sessionID: 's1' });
    expect(runtime.toolLatencyStarts.size).toBe(1);
    expect(consumeToolLatency(runtime, { tool: 'bash', sessionID: 's1' })).toEqual({
      durationUnavailable: 'call_id_missing',
    });
    expect(runtime.toolLatencyStarts.size).toBe(1);
  });

  it('BAD: an after-hook without an observed start is unavailable, never zero', () => {
    const runtime = makeRuntime();
    expect(consumeToolLatency(runtime, { callID: 'c9', tool: 'read', sessionID: 's1' })).toEqual({
      durationUnavailable: 'start_not_observed',
    });
    expect(consumeToolLatency(runtime, { callID: 'c9', tool: 'read' })).toEqual({
      durationUnavailable: 'session_id_missing',
    });
    expect(consumeToolLatency(runtime, undefined)).toEqual({
      durationUnavailable: 'call_id_missing',
    });
  });

  it('CORNER: a start is consumed exactly once', () => {
    const runtime = makeRuntime();
    const input = { callID: 'c1', tool: 'read', sessionID: 's1' };
    recordToolLatencyStart(runtime, input);
    consumeToolLatency(runtime, input);
    expect(consumeToolLatency(runtime, input)).toEqual({
      durationUnavailable: 'start_not_observed',
    });
  });

  it('EDGE: evicts only the oldest start when the registry is full', () => {
    const runtime = makeRuntime();
    for (let i = 0; i < 1000; i++) {
      recordToolLatencyStart(runtime, { callID: `c${i}`, tool: 'read', sessionID: 's1' });
    }
    recordToolLatencyStart(runtime, { callID: 'c-new', tool: 'read', sessionID: 's1' });
    expect(runtime.toolLatencyStarts.size).toBe(1000);
    expect(consumeToolLatency(runtime, { callID: 'c0', tool: 'read', sessionID: 's1' })).toEqual({
      durationUnavailable: 'start_not_observed',
    });
    expect(
      consumeToolLatency(runtime, { callID: 'c1', tool: 'read', sessionID: 's1' }),
    ).toHaveProperty('beforeToAfterMs');
    expect(
      consumeToolLatency(runtime, { callID: 'c-new', tool: 'read', sessionID: 's1' }),
    ).toHaveProperty('beforeToAfterMs');
  });

  it("HAPPY: session cleanup frees only that session's latency starts", () => {
    const runtime = makeRuntime();
    recordToolLatencyStart(runtime, { callID: 'c1', tool: 'read', sessionID: 's1' });
    recordToolLatencyStart(runtime, { callID: 'c1', tool: 'read', sessionID: 's10' });
    recordToolLatencyStart(runtime, { callID: 'c2', tool: 'read', sessionID: 's2' });
    cleanupSessionRuntime(runtime, 's1');
    expect([...runtime.toolLatencyStarts.keys()].sort()).toEqual(['s10\u0000c1', 's2\u0000c2']);
  });

  it('EDGE: a broken runtime registry never throws out of the start recorder', () => {
    const runtime = {
      ...makeRuntime(),
      toolLatencyStarts: {
        delete: () => {
          throw new Error('broken');
        },
      },
    } as unknown as FlowGuardPluginRuntime;
    expect(() =>
      recordToolLatencyStart(runtime, { callID: 'c1', tool: 'read', sessionID: 's1' }),
    ).not.toThrow();
  });
});
