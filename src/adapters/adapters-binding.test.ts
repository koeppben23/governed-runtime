/**
 * @module adapters-binding.test
 * @description Tests for validateBinding and fromOpenCodeContext.
 */
import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import { validateBinding, fromOpenCodeContext, BindingError } from './binding.js';
import { makeState, FIXED_TIME } from '../__fixtures__.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';

const tmpDir = '';

// =============================================================================
// binding (pure functions)
// =============================================================================

describe('binding', () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('validateBinding passes for matching worktrees', () => {
      const state = makeState('TICKET', {
        binding: {
          sessionId: 'old-session',
          worktree: tmpDir || '/tmp/test-repo',
          resolvedAt: FIXED_TIME,
        },
      });
      const binding = { worktreeRoot: state.binding.worktree, sessionId: 'new-session' };
      expect(validateBinding(state, binding)).toBe(true);
    });

    it('fromOpenCodeContext maps field names correctly', () => {
      const raw = { sessionID: 'sess-123', worktree: '/tmp/repo', directory: '/tmp/repo/src' };
      const ctx = fromOpenCodeContext(raw);
      expect(ctx.sessionId).toBe('sess-123');
      expect(ctx.worktree).toBe('/tmp/repo');
      expect(ctx.directory).toBe('/tmp/repo/src');
    });

    it('validateBinding allows different session IDs (continuation)', () => {
      const worktree = path.resolve('/tmp/continuity-repo');
      const state = makeState('PLAN', {
        binding: { sessionId: 'session-old', worktree, resolvedAt: FIXED_TIME },
      });
      expect(validateBinding(state, { worktreeRoot: worktree, sessionId: 'session-new' })).toBe(
        true,
      );
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe('BAD', () => {
    it('validateBinding throws on worktree mismatch', () => {
      const state = makeState('TICKET', {
        binding: { sessionId: 'sess-1', worktree: '/tmp/repo-a', resolvedAt: FIXED_TIME },
      });
      const binding = { worktreeRoot: '/tmp/repo-b', sessionId: 'sess-1' };
      expect(() => validateBinding(state, binding)).toThrow(BindingError);
      try {
        validateBinding(state, binding);
      } catch (err) {
        expect((err as BindingError).code).toBe('WORKTREE_MISMATCH');
      }
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe('CORNER', () => {
    it('validateBinding normalizes paths (trailing slash)', () => {
      const basePath = path.resolve('/tmp/norm-test');
      const state = makeState('TICKET', {
        binding: { sessionId: 's1', worktree: basePath, resolvedAt: FIXED_TIME },
      });
      expect(validateBinding(state, { worktreeRoot: basePath + path.sep, sessionId: 's1' })).toBe(
        true,
      );
    });

    it('BindingError has correct name and code', () => {
      const err = new BindingError('MISSING_SESSION_ID', 'test');
      expect(err.name).toBe('BindingError');
      expect(err.code).toBe('MISSING_SESSION_ID');
      expect(err instanceof Error).toBe(true);
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe('EDGE', () => {
    it('fromOpenCodeContext preserves whitespace in values', () => {
      const raw = { sessionID: ' sess ', worktree: ' /tmp/repo ', directory: ' /tmp/repo/src ' };
      const ctx = fromOpenCodeContext(raw);
      expect(ctx.sessionId).toBe(' sess ');
      expect(ctx.worktree).toBe(' /tmp/repo ');
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it(`validateBinding < ${PERF_BUDGETS.validateBindingMs}ms (p99 over 200 iterations)`, () => {
      const worktree = path.resolve('/tmp/perf-repo');
      const state = makeState('TICKET', {
        binding: { sessionId: 's1', worktree, resolvedAt: FIXED_TIME },
      });
      const binding = { worktreeRoot: worktree, sessionId: 's1' };
      const { p99Ms } = benchmarkSync(() => validateBinding(state, binding), 200, 50);
      expect(p99Ms).toBeLessThan(PERF_BUDGETS.validateBindingMs);
    });
  });
});
