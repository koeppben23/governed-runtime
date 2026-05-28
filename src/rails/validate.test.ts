/**
 * @module validate.test
 * @description Rail unit tests for /validate — execution-evidence validation.
 *
 * Tests fail-closed phase gating, vacuous truth for empty activeChecks,
 * all-pass/fail paths, and ordering guarantees.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, expect, it, vi } from 'vitest';
import { executeValidate, type ValidateExecutors } from './validate.js';
import { makeState, FIXED_TIME, TICKET } from '../__fixtures__.js';
import type { RailContext } from './types.js';
import type { PlanRecord, ValidationResult } from '../state/evidence.js';

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

/** Create a full ValidationResult matching the v2 execution-evidence schema. */
function makeValidationResult(checkId: string, passed: boolean, detail: string): ValidationResult {
  return {
    checkId,
    passed,
    detail,
    executedAt: FIXED_TIME,
    kind: 'test',
    command: 'npm test',
    exitCode: passed ? 0 : 1,
    executionMs: 1000,
    outputDigest: 'a'.repeat(64),
    timedOut: false,
  };
}

function makeExecutors(
  results: Array<{ checkId: string; passed: boolean; detail: string }>,
): ValidateExecutors {
  return {
    runCheck: vi.fn(async (checkId) => {
      const r = results.find((r) => r.checkId === checkId);
      if (!r) throw new Error(`Unexpected check: ${checkId}`);
      return makeValidationResult(r.checkId, r.passed, r.detail);
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
        { checkId: 'test', passed: true, detail: 'OK' },
        { checkId: 'lint', passed: true, detail: 'OK' },
      ]);
      const result = await executeValidate(state, ctx, executors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('IMPLEMENTATION');
        expect(result.state.validation).toHaveLength(2);
      }
    });

    it('vacuous truth — empty activeChecks auto-advances (no checks needed)', async () => {
      const state = validationState({ activeChecks: [] });
      const executors = makeExecutors([]);
      const result = await executeValidate(state, ctx, executors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        // With vacuous truth, VALIDATION passes immediately
        expect(result.state.phase).toBe('IMPLEMENTATION');
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

    it('blocks without plan (precondition)', async () => {
      const state = makeState('VALIDATION', {
        ticket: TICKET,
        plan: null,
        activeChecks: ['test'],
      });
      const result = await executeValidate(state, ctx, makeExecutors([]));
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('PLAN_REQUIRED');
      }
    });
  });

  // ── CORNER ─────────────────────────────────────────────────────────────
  describe('CORNER', () => {
    it('CHECK_FAILED returns to PLAN and clears selfReview/reviewDecision', async () => {
      const state = validationState();
      const executors = makeExecutors([
        { checkId: 'test', passed: false, detail: 'Missing tests' },
        { checkId: 'lint', passed: true, detail: 'OK' },
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
          return makeValidationResult(checkId, true, 'OK');
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
