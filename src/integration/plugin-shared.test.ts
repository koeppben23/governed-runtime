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
  getToolTraceId,
  type FlowGuardPluginRuntime,
} from './plugin-shared.js';

function makeRuntime(): FlowGuardPluginRuntime {
  return {
    ws: { invalidateChainState: vi.fn() },
    toolTraceIds: new Map<string, string>(),
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
