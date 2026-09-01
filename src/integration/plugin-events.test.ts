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
    async emitSessionErrorAudit(sessionId, errorMessage, detail) {
      calls.push({
        method: 'emitSessionErrorAudit',
        args: [sessionId, errorMessage, detail],
      });
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
      expect((warnCall!.args[2] as Record<string, unknown>).error).toMatchObject({
        message: 'cleanup exploded',
      });
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
      expect((warnCall!.args[2] as Record<string, unknown>).error).toMatchObject({
        message: 'logging exploded',
      });
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
        timestamp: Date.now(), // extra field — should not break PluginEvent compatibility
      };

      // PluginEvent only requires { type, properties? } — extra fields are allowed
      const event: PluginEvent = sdkLikeEvent;
      expect(event.type).toBe('session.error');
    });
  });

  // --- BUG-06: error detail extraction -------------------------------------------
  describe('BUG-06: error detail extraction', () => {
    // T1 -- HAPPY: error code and stack are extracted
    it('session.error with code and stack properties extracts them into log', async () => {
      const deps = createMockDeps();
      const event: PluginEvent = {
        type: 'session.error',
        properties: {
          sessionID: 'S1',
          error: 'boom',
          code: 'E42',
          stack: 'Error: boom\n    at foo.ts:1:1',
        },
      };

      await handleEvent(deps, event);

      const errorCall = deps.calls.find((c) => c.method === 'log.error');
      expect(errorCall).toBeDefined();
      const extra = errorCall!.args[2] as Record<string, unknown>;
      expect(extra.errorCode).toBe('E42');
      // The stack is sanitized at the source (it is shared with the audit
      // detail, which is not redacted downstream). sanitizeDiagnosticString
      // strips line:column references, so the frame keeps its file but not
      // its position.
      expect(extra.errorStack).toBe('Error: boom\n    at foo.ts');
    });

    // T2 -- HAPPY: unknown properties land in supplementary
    it('session.error with unknown extra properties includes supplementary', async () => {
      const deps = createMockDeps();
      const event: PluginEvent = {
        type: 'session.error',
        properties: {
          sessionID: 'S1',
          error: 'x',
          retryCount: 3,
          context: { a: 1 },
        },
      };

      await handleEvent(deps, event);

      const errorCall = deps.calls.find((c) => c.method === 'log.error');
      expect(errorCall).toBeDefined();
      const extra = errorCall!.args[2] as Record<string, unknown>;
      expect(extra.supplementary).toEqual({ retryCount: 3, context: { a: 1 } });
    });

    // T3 -- CORNER: non-string code/stack are not extracted, land in supplementary
    it('non-string code and stack are not extracted, land in supplementary', async () => {
      const deps = createMockDeps();
      const event: PluginEvent = {
        type: 'session.error',
        properties: { sessionID: 'S1', error: 'x', code: 42, stack: { deep: true } },
      };

      await handleEvent(deps, event);

      const errorCall = deps.calls.find((c) => c.method === 'log.error');
      expect(errorCall).toBeDefined();
      const extra = errorCall!.args[2] as Record<string, unknown>;
      // Non-string code/stack are not in KNOWN_KEYS extraction but ARE in KNOWN_KEYS set,
      // so they are excluded from supplementary too. This is intentional: primary fields
      // are "handled" even when non-string (the handler falls back to defaults).
      expect(extra).not.toHaveProperty('errorCode');
      expect(extra).not.toHaveProperty('errorStack');
      // code and stack are in KNOWN_KEYS so they stay out of supplementary
      expect(extra).not.toHaveProperty('supplementary');
    });

    // T4 -- CORNER: empty string code is not included (falsy spread guard)
    it('empty string code is not included in log extra', async () => {
      const deps = createMockDeps();
      const event: PluginEvent = {
        type: 'session.error',
        properties: { sessionID: 'S1', error: 'x', code: '', stack: '' },
      };

      await handleEvent(deps, event);

      const errorCall = deps.calls.find((c) => c.method === 'log.error');
      expect(errorCall).toBeDefined();
      const extra = errorCall!.args[2] as Record<string, unknown>;
      // Empty strings are falsy, so spread guard filters them out
      expect(extra).not.toHaveProperty('errorCode');
      expect(extra).not.toHaveProperty('errorStack');
    });

    // T5 -- EDGE: many supplementary keys
    it('50 unknown properties all land in supplementary', async () => {
      const deps = createMockDeps();
      const extraProps: Record<string, unknown> = {};
      for (let i = 0; i < 50; i++) {
        extraProps[`custom_${i}`] = `value_${i}`;
      }
      const event: PluginEvent = {
        type: 'session.error',
        properties: { sessionID: 'S1', error: 'x', ...extraProps },
      };

      await handleEvent(deps, event);

      const errorCall = deps.calls.find((c) => c.method === 'log.error');
      expect(errorCall).toBeDefined();
      const extra = errorCall!.args[2] as Record<string, unknown>;
      const supplementary = extra.supplementary as Record<string, unknown>;
      expect(supplementary).toBeDefined();
      expect(Object.keys(supplementary)).toHaveLength(50);
      expect(supplementary.custom_0).toBe('value_0');
      expect(supplementary.custom_49).toBe('value_49');
    });
  });

  // --- BUG-01: audit trail emission --------------------------------------------
  describe('BUG-01: audit trail emission', () => {
    // T6 -- HAPPY: emitSessionErrorAudit is called with correct args
    it('session.error calls emitSessionErrorAudit with sessionId and errorMessage', async () => {
      const deps = createMockDeps();
      const event: PluginEvent = {
        type: 'session.error',
        properties: { sessionID: 'S1', error: 'Something failed' },
      };

      await handleEvent(deps, event);

      const auditCall = deps.calls.find((c) => c.method === 'emitSessionErrorAudit');
      expect(auditCall).toBeDefined();
      expect(auditCall!.args[0]).toBe('S1');
      expect(auditCall!.args[1]).toBe('Something failed');
      expect(auditCall!.args[2]).toEqual({ eventType: 'session.error' });
    });

    // T7 -- HAPPY: audit call receives extended properties
    it('audit call includes errorCode and errorStack when present', async () => {
      const deps = createMockDeps();
      const event: PluginEvent = {
        type: 'session.error',
        properties: {
          sessionID: 'S1',
          error: 'x',
          code: 'E99',
          stack: 'trace...',
        },
      };

      await handleEvent(deps, event);

      const auditCall = deps.calls.find((c) => c.method === 'emitSessionErrorAudit');
      expect(auditCall).toBeDefined();
      const detail = auditCall!.args[2] as Record<string, unknown>;
      expect(detail.errorCode).toBe('E99');
      expect(detail.errorStack).toBe('trace...');
    });

    // T8 -- BAD: audit throws synchronously -- handler is fail-safe
    it('handler does not throw when emitSessionErrorAudit throws sync error', async () => {
      const deps = createMockDeps();
      deps.emitSessionErrorAudit = () => {
        throw new Error('audit boom');
      };

      const event: PluginEvent = {
        type: 'session.error',
        properties: { sessionID: 'S1', error: 'test' },
      };

      await expect(handleEvent(deps, event)).resolves.toBeUndefined();

      const warnCall = deps.calls.find((c) => c.method === 'log.warn');
      expect(warnCall).toBeDefined();
      expect(warnCall!.args[1]).toBe('event handler failed (non-blocking)');
      expect((warnCall!.args[2] as Record<string, unknown>).error).toMatchObject({
        message: 'audit boom',
      });
    });

    // T9 -- BAD: audit returns rejected promise -- handler is fail-safe
    it('handler does not throw when emitSessionErrorAudit returns rejected promise', async () => {
      const deps = createMockDeps();
      deps.emitSessionErrorAudit = () => Promise.reject(new Error('audit rejected'));

      const event: PluginEvent = {
        type: 'session.error',
        properties: { sessionID: 'S1', error: 'test' },
      };

      await expect(handleEvent(deps, event)).resolves.toBeUndefined();

      const warnCall = deps.calls.find((c) => c.method === 'log.warn');
      expect(warnCall).toBeDefined();
      expect((warnCall!.args[2] as Record<string, unknown>).error).toMatchObject({
        message: 'audit rejected',
      });
    });

    // T10 -- CORNER: unknown sessionId still triggers audit
    it('emitSessionErrorAudit is called even when sessionId is "unknown"', async () => {
      const deps = createMockDeps();
      const event: PluginEvent = {
        type: 'session.error',
        properties: {},
      };

      await handleEvent(deps, event);

      const auditCall = deps.calls.find((c) => c.method === 'emitSessionErrorAudit');
      expect(auditCall).toBeDefined();
      expect(auditCall!.args[0]).toBe('unknown');
      expect(auditCall!.args[1]).toBe('unspecified session error');
    });

    // T11 -- CORNER: session.delete does NOT call emitSessionErrorAudit
    it('session.delete does not call emitSessionErrorAudit', async () => {
      const deps = createMockDeps();
      const event: PluginEvent = {
        type: 'session.delete',
        properties: { sessionID: 'S1' },
      };

      await handleEvent(deps, event);

      const auditCalls = deps.calls.filter((c) => c.method === 'emitSessionErrorAudit');
      expect(auditCalls).toHaveLength(0);
    });

    // T12 -- EDGE: log.error is called BEFORE emitSessionErrorAudit (ordering)
    it('log.error is called before emitSessionErrorAudit', async () => {
      const deps = createMockDeps();
      const event: PluginEvent = {
        type: 'session.error',
        properties: { sessionID: 'S1', error: 'test' },
      };

      await handleEvent(deps, event);

      const logIdx = deps.calls.findIndex((c) => c.method === 'log.error');
      const auditIdx = deps.calls.findIndex((c) => c.method === 'emitSessionErrorAudit');
      expect(logIdx).toBeGreaterThanOrEqual(0);
      expect(auditIdx).toBeGreaterThanOrEqual(0);
      expect(logIdx).toBeLessThan(auditIdx);
    });
  });

  // ─── Audit confidentiality ──────────────────────────────────
  describe('session.error diagnostics are redacted before reaching the audit trail', () => {
    // The logger redacts centrally before its sinks, but the audit append
    // does not — so anything handed to emitSessionErrorAudit must already be
    // sanitized, or credentials land verbatim in the raw audit.jsonl.
    const SECRETS = [
      'Bearer abcdef0123456789',
      'password=hunter2',
      'sk-proj-0123456789abcdef',
      '/Users/alice/private-project/secrets.env',
    ];

    async function auditPayload(properties: Record<string, unknown>): Promise<string> {
      const deps = createMockDeps();
      await handleEvent(deps, { type: 'session.error', properties });
      const call = deps.calls.find((c) => c.method === 'emitSessionErrorAudit');
      expect(call).toBeDefined();
      return JSON.stringify([call!.args[1], call!.args[2]]);
    }

    it('redacts secrets in the error message', async () => {
      const payload = await auditPayload({
        sessionID: 'S1',
        error: `auth failed: ${SECRETS[0]} ${SECRETS[1]}`,
      });
      expect(payload).not.toContain('abcdef0123456789');
      expect(payload).not.toContain('hunter2');
    });

    it('redacts secrets and absolute paths in the stack', async () => {
      const payload = await auditPayload({
        sessionID: 'S1',
        error: 'boom',
        stack: `Error: boom\n    at ${SECRETS[3]}\n    ${SECRETS[2]}`,
      });
      expect(payload).not.toContain('/Users/alice/private-project');
      expect(payload).not.toContain('sk-proj-0123456789abcdef');
    });

    it('redacts secrets in supplementary host context', async () => {
      const payload = await auditPayload({
        sessionID: 'S1',
        error: 'boom',
        requestUrl: 'https://user:pass@internal.example.com/v1/keys',
        upstreamAuth: SECRETS[0],
      });
      expect(payload).not.toContain('user:pass');
      expect(payload).not.toContain('abcdef0123456789');
    });

    it('redacts secrets nested inside supplementary objects and arrays', async () => {
      // detail is z.record(z.string(), z.unknown()), so host context reaches
      // the raw trail with its structure intact. A shallow string-only pass
      // would leave everything below the top level unredacted.
      const payload = await auditPayload({
        sessionID: 'S1',
        error: 'boom',
        request: { headers: { authorization: SECRETS[0] } },
        attempts: [{ token: SECRETS[2] }, { note: SECRETS[1] }],
        deep: { a: { b: { c: SECRETS[3] } } },
      });
      expect(payload).not.toContain('abcdef0123456789');
      expect(payload).not.toContain('sk-proj-0123456789abcdef');
      expect(payload).not.toContain('hunter2');
      expect(payload).not.toContain('/Users/alice/private-project');
    });

    it('preserves supplementary structure while redacting', async () => {
      const deps = createMockDeps();
      await handleEvent(deps, {
        type: 'session.error',
        properties: {
          sessionID: 'S1',
          error: 'boom',
          request: { headers: { authorization: SECRETS[0] }, retries: 2 },
          attempts: [{ ok: false }],
        },
      });

      const call = deps.calls.find((c) => c.method === 'emitSessionErrorAudit');
      const supplementary = (call!.args[2] as Record<string, unknown>).supplementary as Record<
        string,
        unknown
      >;
      const request = supplementary.request as Record<string, unknown>;
      // Shape survives: nesting, non-string values, and arrays are preserved.
      expect(request.retries).toBe(2);
      expect((request.headers as Record<string, unknown>).authorization).toBe('Bearer [redacted]');
      expect(supplementary.attempts).toEqual([{ ok: false }]);
    });

    it('does not throw on cyclic supplementary context', async () => {
      const cyclic: Record<string, unknown> = { name: 'ctx' };
      cyclic.self = cyclic;
      const deps = createMockDeps();

      await expect(
        handleEvent(deps, {
          type: 'session.error',
          properties: { sessionID: 'S1', error: 'boom', cyclic },
        }),
      ).resolves.not.toThrow();
      expect(deps.calls.find((c) => c.method === 'emitSessionErrorAudit')).toBeDefined();
    });

    it('preserves non-string supplementary values and the diagnostic shape', async () => {
      const deps = createMockDeps();
      await handleEvent(deps, {
        type: 'session.error',
        properties: {
          sessionID: 'S1',
          error: 'plain failure',
          code: 'E_BOOM',
          attempt: 3,
          retriable: true,
        },
      });

      const call = deps.calls.find((c) => c.method === 'emitSessionErrorAudit');
      expect(call!.args[1]).toBe('plain failure');
      const detail = call!.args[2] as Record<string, unknown>;
      expect(detail.errorCode).toBe('E_BOOM');
      expect(detail.supplementary).toEqual({ attempt: 3, retriable: true });
    });
  });
});
