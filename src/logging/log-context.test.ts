/**
 * @module logging/log-context.test
 * @description Tests for LogContext — AsyncLocalStorage-based execution context.
 *
 * Covers:
 * - runWithLogContext: sync injection
 * - runWithLogContextAsync: async injection
 * - getLogContext: undefined outside scope
 * - Nesting: inner overrides, outer restored after return
 * - Concurrent: independent traces for parallel sessions
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import { runWithLogContext, runWithLogContextAsync, getLogContext } from './log-context.js';

describe('LogContext', () => {
  describe('HAPPY', () => {
    it('getLogContext returns undefined outside any scope', () => {
      expect(getLogContext()).toBeUndefined();
    });

    it('runWithLogContext injects context into sync scope', () => {
      const ctx = { traceId: 'trace-1', sessionId: 'session-1' };
      runWithLogContext(ctx, () => {
        const current = getLogContext();
        expect(current).toBeDefined();
        expect(current!.traceId).toBe('trace-1');
        expect(current!.sessionId).toBe('session-1');
      });
    });

    it('runWithLogContextAsync injects context into async scope', async () => {
      const ctx = { traceId: 'trace-2' };
      await runWithLogContextAsync(ctx, async () => {
        const current = getLogContext();
        expect(current).toBeDefined();
        expect(current!.traceId).toBe('trace-2');
        expect(current!.sessionId).toBeUndefined();
      });
    });

    it('context is cleared after sync scope exits', () => {
      runWithLogContext({ traceId: 'trace-3' }, () => {
        /* noop */
      });
      expect(getLogContext()).toBeUndefined();
    });

    it('context is cleared after async scope exits', async () => {
      await runWithLogContextAsync({ traceId: 'trace-4' }, async () => {
        /* noop */
      });
      expect(getLogContext()).toBeUndefined();
    });
  });

  describe('CORNER', () => {
    it('nested runWithLogContext creates independent scopes', () => {
      runWithLogContext({ traceId: 'outer', sessionId: 'outer-s' }, () => {
        expect(getLogContext()!.traceId).toBe('outer');

        runWithLogContext({ traceId: 'inner', sessionId: 'inner-s' }, () => {
          expect(getLogContext()!.traceId).toBe('inner');
          expect(getLogContext()!.sessionId).toBe('inner-s');
        });

        expect(getLogContext()!.traceId).toBe('outer');
        expect(getLogContext()!.sessionId).toBe('outer-s');
      });
    });

    it('sessionId is optional in context', () => {
      runWithLogContext({ traceId: 'trace-no-session' }, () => {
        const ctx = getLogContext();
        expect(ctx!.traceId).toBe('trace-no-session');
        expect(ctx!.sessionId).toBeUndefined();
      });
    });

    it('empty string sessionId is passed through', () => {
      runWithLogContext({ traceId: 't', sessionId: '' }, () => {
        expect(getLogContext()!.sessionId).toBe('');
      });
    });
  });

  describe('EDGE', () => {
    it('concurrent async scopes do not leak', async () => {
      const results: string[] = [];

      await Promise.all([
        runWithLogContextAsync({ traceId: 'a' }, async () => {
          await new Promise((r) => setImmediate(r));
          results.push(getLogContext()!.traceId);
        }),
        runWithLogContextAsync({ traceId: 'b' }, async () => {
          await new Promise((r) => setImmediate(r));
          results.push(getLogContext()!.traceId);
        }),
      ]);

      expect(results).toContain('a');
      expect(results).toContain('b');
    });

    it('error inside context scope does not leak context', () => {
      expect(() => {
        runWithLogContext({ traceId: 'err-trace' }, () => {
          throw new Error('bang');
        });
      }).toThrow('bang');

      expect(getLogContext()).toBeUndefined();
    });

    it('async error inside context scope does not leak context', async () => {
      await expect(
        runWithLogContextAsync({ traceId: 'async-err-trace' }, async () => {
          throw new Error('async bang');
        }),
      ).rejects.toThrow('async bang');

      expect(getLogContext()).toBeUndefined();
    });
  });
});
