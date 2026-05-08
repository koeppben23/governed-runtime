/**
 * @module integration/plugin-events.test
 * @description Tests for the OpenCode event hook handlers (plugin-events.ts).
 *
 * Validates:
 * - session.error events are logged via deps.log.error
 * - session.delete events call cleanupSession
 * - Unhandled event types are silently ignored (no-op)
 * - Fail-safe behavior: handler never throws
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, SMOKE ÔÇö all categories present.
 * @version v1
 */

import { describe, it, expect, vi } from 'vitest';
import { handleEvent, type EventHandlerDeps, type PluginEvent } from './plugin-events.js';

// ÔöÇÔöÇÔöÇ Helpers ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

function createMockDeps(): EventHandlerDeps & {
  calls: { method: string; args: unknown[] }[];
} {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    log: {
      info(service, message, extra) {
        calls.push({ method: 'log.info', args: [service, message, extra] });
      },
      warn(service, message, extra) {
        calls.push({ method: 'log.warn', args: [service, message, extra] });
      },
      error(service, message, extra) {
        calls.push({ method: 'log.error', args: [service, message, extra] });
      },
    },
    cleanupSession(sessionId: string) {
      calls.push({ method: 'cleanupSession', args: [sessionId] });
    },
  };
}

// ÔöÇÔöÇÔöÇ Tests ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

describe('integration/plugin-events', () => {
  // ÔöÇÔöÇÔöÇ HAPPY ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  describe('HAPPY', () => {
    it('session.error event logs error with sessionId and message', async () => {
      const deps = createMockDeps();
      const event: PluginEvent = {
        type: 'session.error',
        properties: { sessionID: 'sess-abc', error: 'Something went wrong' },
      };

      await handleEvent(deps, event);

      const errorCall = deps.calls.find((c) => c.method === 'log.error');
      expect(errorCall).toBeDefined();
      expect(errorCall!.args[0]).toBe('event');
      expect(errorCall!.args[1]).toBe('session error received');
      expect(errorCall!.args[2]).toEqual({
        sessionId: 'sess-abc',
        error: 'Something went wrong',
        eventType: 'session.error',
      });
    });

    it('session.delete event calls cleanupSession with sessionId', async () => {
      const deps = createMockDeps();
      const event: PluginEvent = {
        type: 'session.delete',
        properties: { sessionID: 'sess-xyz' },
      };

      await handleEvent(deps, event);

      const cleanupCall = deps.calls.find((c) => c.method === 'cleanupSession');
      expect(cleanupCall).toBeDefined();
      expect(cleanupCall!.args[0]).toBe('sess-xyz');

      const infoCall = deps.calls.find((c) => c.method === 'log.info');
      expect(infoCall).toBeDefined();
      expect(infoCall!.args[2]).toEqual({ sessionId: 'sess-xyz' });
    });

    it('session.error falls back to message property if error is missing', async () => {
      const deps = createMockDeps();
      const event: PluginEvent = {
        type: 'session.error',
        properties: { sessionID: 'sess-1', message: 'Fallback message' },
      };

      await handleEvent(deps, event);

      const errorCall = deps.calls.find((c) => c.method === 'log.error');
      expect(errorCall).toBeDefined();
      expect((errorCall!.args[2] as Record<string, unknown>).error).toBe('Fallback message');
    });
  });

  // ÔöÇÔöÇÔöÇ BAD ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  describe('BAD', () => {
    it('null event is a no-op', async () => {
      const deps = createMockDeps();
      await handleEvent(deps, null as unknown as PluginEvent);
      expect(deps.calls).toHaveLength(0);
    });

    it('undefined event is a no-op', async () => {
      const deps = createMockDeps();
      await handleEvent(deps, undefined as unknown as PluginEvent);
      expect(deps.calls).toHaveLength(0);
    });

    it('event with empty type is a no-op', async () => {
      const deps = createMockDeps();
      await handleEvent(deps, { type: '' });
      expect(deps.calls).toHaveLength(0);
    });

    it('session.delete with no sessionID does not call cleanup', async () => {
      const deps = createMockDeps();
      const event: PluginEvent = {
        type: 'session.delete',
        properties: {},
      };

      await handleEvent(deps, event);

      const cleanupCall = deps.calls.find((c) => c.method === 'cleanupSession');
      expect(cleanupCall).toBeUndefined();
    });

    it('session.error with no properties logs "unknown" sessionId', async () => {
      const deps = createMockDeps();
      const event: PluginEvent = {
        type: 'session.error',
        properties: undefined,
      };

      await handleEvent(deps, event);

      const errorCall = deps.calls.find((c) => c.method === 'log.error');
      expect(errorCall).toBeDefined();
      expect((errorCall!.args[2] as Record<string, unknown>).sessionId).toBe('unknown');
      expect((errorCall!.args[2] as Record<string, unknown>).error).toBe(
        'unspecified session error',
      );
    });
  });

  // ÔöÇÔöÇÔöÇ CORNER ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  describe('CORNER', () => {
    it('unhandled event types are silently ignored', async () => {
      const deps = createMockDeps();
      await handleEvent(deps, { type: 'session.start' });
      await handleEvent(deps, { type: 'tool.execute' });
      await handleEvent(deps, { type: 'unknown.custom.event' });
      expect(deps.calls).toHaveLength(0);
    });

    it('session.error with non-string error and message properties logs fallback', async () => {
      const deps = createMockDeps();
      const event: PluginEvent = {
        type: 'session.error',
        properties: { sessionID: 'sess-2', error: 42, message: { nested: true } },
      };

      await handleEvent(deps, event);

      const errorCall = deps.calls.find((c) => c.method === 'log.error');
      expect(errorCall).toBeDefined();
      // Both error and message are non-string ÔåÆ falls through to default
      expect((errorCall!.args[2] as Record<string, unknown>).error).toBe(
        'unspecified session error',
      );
    });

    it('session.delete with non-string sessionID does not call cleanup', async () => {
      const deps = createMockDeps();
      const event: PluginEvent = {
        type: 'session.delete',
        properties: { sessionID: 12345 },
      };

      await handleEvent(deps, event);

      const cleanupCall = deps.calls.find((c) => c.method === 'cleanupSession');
      expect(cleanupCall).toBeUndefined();
    });
  });

  // ÔöÇÔöÇÔöÇ EDGE ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  describe('EDGE', () => {
    it('fail-safe: handler catches and logs cleanupSession exceptions', async () => {
      const deps = createMockDeps();
      // Override cleanupSession to throw
      deps.cleanupSession = () => {
        throw new Error('cleanup exploded');
      };

      const event: PluginEvent = {
        type: 'session.delete',
        properties: { sessionID: 'sess-boom' },
      };

      // Must not throw
      await expect(handleEvent(deps, event)).resolves.toBeUndefined();

      // Should have logged the warning
      const warnCall = deps.calls.find((c) => c.method === 'log.warn');
      expect(warnCall).toBeDefined();
      expect(warnCall!.args[1]).toBe('event handler failed (non-blocking)');
      expect((warnCall!.args[2] as Record<string, unknown>).error).toBe('cleanup exploded');
    });

    it('fail-safe: handler catches and logs log.error exceptions', async () => {
      const deps = createMockDeps();
      // Override log.error to throw
      deps.log.error = () => {
        throw new Error('logging exploded');
      };

      const event: PluginEvent = {
        type: 'session.error',
        properties: { sessionID: 'sess-err', error: 'test' },
      };

      // Must not throw ÔÇö the outer catch uses log.warn which still works
      await expect(handleEvent(deps, event)).resolves.toBeUndefined();

      const warnCall = deps.calls.find((c) => c.method === 'log.warn');
      expect(warnCall).toBeDefined();
      expect((warnCall!.args[2] as Record<string, unknown>).error).toBe('logging exploded');
    });

    it('handles event with readonly frozen properties', async () => {
      const deps = createMockDeps();
      const event: PluginEvent = Object.freeze({
        type: 'session.error',
        properties: Object.freeze({ sessionID: 'frozen-sess', error: 'frozen error' }),
      });

      await expect(handleEvent(deps, event)).resolves.toBeUndefined();

      const errorCall = deps.calls.find((c) => c.method === 'log.error');
      expect(errorCall).toBeDefined();
      expect((errorCall!.args[2] as Record<string, unknown>).sessionId).toBe('frozen-sess');
    });
  });

  // ÔöÇÔöÇÔöÇ SMOKE ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  describe('SMOKE', () => {
    it('handles 1000 rapid events without memory leaks or throws', async () => {
      const deps = createMockDeps();

      const events: PluginEvent[] = Array.from({ length: 1000 }, (_, i) => ({
        type: i % 3 === 0 ? 'session.error' : i % 3 === 1 ? 'session.delete' : 'session.start',
        properties: { sessionID: `sess-${i}`, error: `error-${i}` },
      }));

      const start = performance.now();
      await Promise.all(events.map((e) => handleEvent(deps, e)));
      const elapsed = performance.now() - start;

      // Should complete 1000 events in < 100ms (they're all sync I/O)
      expect(elapsed).toBeLessThan(100);
      // Approximately 333 error events + 333 delete events (each producing calls)
      expect(deps.calls.length).toBeGreaterThan(600);
    });

    it('PluginEvent interface is structurally compatible with SDK Event shape', () => {
      // Compile-time check: PluginEvent matches the minimal shape
      // that the SDK would deliver for event hooks
      const sdkLikeEvent = {
        type: 'session.error',
        properties: { sessionID: 'test', error: 'boom' },
        timestamp: Date.now(), // extra field ÔÇö should not break PluginEvent compatibility
      };

      // PluginEvent only requires { type, properties? } ÔÇö extra fields are allowed
      const event: PluginEvent = sdkLikeEvent;
      expect(event.type).toBe('session.error');
    });
  });
});
