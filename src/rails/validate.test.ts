/**
 * @module validate.test
 * @description Rail unit tests for /validate — explicit validation checks.
 *
 * P10b: tests fail-closed phase gating, precondition enforcement,
 * all-pass/fail paths, and ordering guarantees.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, expect, it, vi } from 'vitest';
import { executeValidate, type ValidateExecutors } from './validate.js';
import { makeState, FIXED_TIME, TICKET } from '../__fixtures__.js';
import type { RailContext } from './types.js';
import type { PlanRecord } from '../state/evidence.js';

const ctx: RailContext = {
  now: () => FIXED_TIME,
  digest: (s: string) => `sha256:${s.length}`,
  policy: {},
};

function planWith(body: string): PlanRecord {
  return {
    current: { body, digest: 'd', sections: [], createdAt: FIXED_TIME },
    history: [],
  };
}

function makeExecutors(
  results: Array<{ checkId: string; passed: boolean; detail: string }>,
): ValidateExecutors {
  return {
    runCheck: vi.fn(async (checkId) => {
      const r = results.find((r) => r.checkId === checkId);
      if (!r) throw new Error(`Unexpected check: ${checkId}`);
      return { ...r, executedAt: FIXED_TIME };
    }),
  };
}

function validationState(overrides?: Record<string, unknown>) {
  return makeState('VALIDATION', {
    ticket: TICKET,
    plan: planWith('## Plan\nTest'),
    reviewDecision: {
      verdict: 'approve',
      decidedBy: 'r1',
      decidedAt: FIXED_TIME,
      decidedByIdentity: {
        actorId: 'r1',
        actorEmail: 'r@t.com',
        actorSource: 'env' as const,
        actorAssurance: 'best_effort' as const,
      },
    },
    selfReview: {
      iteration: 1,
      maxIterations: 3,
      prevDigest: null,
      currDigest: 'd1',
      revisionDelta: 'none' as const,
      verdict: 'converged' as const,
    },
    ...overrides,
  });
}

describe('validate rail', () => {
  // ── HAPPY ──────────────────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('ALL_PASSED advances to IMPLEMENTATION', async () => {
      const state = validationState();
      const executors = makeExecutors([
        { checkId: 'test_quality', passed: true, detail: 'OK' },
        { checkId: 'rollback_safety', passed: true, detail: 'OK' },
      ]);
      const result = await executeValidate(state, ctx, executors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('IMPLEMENTATION');
        expect(result.state.validation).toHaveLength(2);
      }
    });
  });

  // ── BAD ────────────────────────────────────────────────────────────────
  describe('BAD', () => {
    it('blocks at non-VALIDATION phase', async () => {
      const state = makeState('TICKET');
      const result = await executeValidate(state, ctx, makeExecutors([]));
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('COMMAND_NOT_ALLOWED');
      }
    });

    it('blocks with no active checks', async () => {
      const state = makeState('VALIDATION', {
        ticket: TICKET,
        plan: planWith('Plan'),
        activeChecks: [],
      });
      const result = await executeValidate(state, ctx, makeExecutors([]));
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('NO_ACTIVE_CHECKS');
      }
    });
  });

  // ── CORNER ─────────────────────────────────────────────────────────────
  describe('CORNER', () => {
    it('CHECK_FAILED returns to PLAN and clears selfReview/reviewDecision', async () => {
      const state = validationState();
      const executors = makeExecutors([
        { checkId: 'test_quality', passed: false, detail: 'Missing tests' },
        { checkId: 'rollback_safety', passed: true, detail: 'OK' },
      ]);
      const result = await executeValidate(state, ctx, executors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('PLAN');
        expect(result.state.selfReview).toBeNull();
        expect(result.state.reviewDecision).toBeNull();
      }
    });
  });

  // ── EDGE ───────────────────────────────────────────────────────────────
  describe('EDGE', () => {
    it('runs checks in activeChecks order', async () => {
      const state = validationState({
        activeChecks: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      });
      const order: string[] = [];
      const executors: ValidateExecutors = {
        runCheck: vi.fn(async (checkId) => {
          order.push(checkId);
          return { checkId, passed: true, detail: 'OK', executedAt: FIXED_TIME };
        }),
      };
      await executeValidate(state, ctx, executors);
      expect(order).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    });

    it('runCheck throwing propagates error (no silent swallow)', async () => {
      const state = validationState();
      const executors: ValidateExecutors = {
        runCheck: vi.fn().mockRejectedValue(new Error('executor crashed')),
      };
      await expect(executeValidate(state, ctx, executors)).rejects.toThrow('executor crashed');
    });
  });
});
