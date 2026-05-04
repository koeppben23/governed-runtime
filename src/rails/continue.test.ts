/**
 * @module continue.test
 * @description Rail unit tests for /continue — workflow routing and auto-advance.
 *
 * P10b: tests terminal/user-gate short-circuits, phase-specific review loops,
 * gate enforcement, and iteration-bound convergence.
 *
 * @test-policy HAPPY, BAD, CORNER, SMOKE
 */

import { describe, expect, it, vi } from 'vitest';
import { executeContinue, type ContinueExecutors } from './continue.js';
import {
  makeState,
  FIXED_TIME,
  TICKET,
  PLAN_RECORD,
  ARCHITECTURE_DECISION,
} from '../__fixtures__.js';
import type { RailContext } from './types.js';
import type { PlanRecord } from '../state/evidence.js';

const ctx: RailContext = {
  now: () => FIXED_TIME,
  digest: (s: string) => `sha256:${s.length}`,
  policy: { maxSelfReviewIterations: 3, maxImplReviewIterations: 3 },
};

function makeExecutors(overrides?: Partial<ContinueExecutors>): ContinueExecutors {
  return {
    runCheck: vi.fn(async (checkId) => ({
      checkId,
      passed: true,
      detail: 'OK',
      executedAt: FIXED_TIME,
    })),
    selfReview: vi.fn().mockResolvedValue({ verdict: 'converged' as const }),
    implReview: vi.fn().mockResolvedValue({ verdict: 'converged' as const }),
    architectureReview: vi.fn().mockResolvedValue({ verdict: 'converged' as const }),
    ...overrides,
  };
}

function planWith(body: string): PlanRecord {
  return { current: { body, digest: 'd', sections: [], createdAt: FIXED_TIME }, history: [] };
}

describe('continue rail', () => {
  // ── HAPPY ──────────────────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('user gate returns waiting evalResult without auto-advance', async () => {
      const state = makeState('PLAN_REVIEW');
      const result = await executeContinue(state, ctx, makeExecutors());
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.evalResult.kind).toBe('waiting');
        expect(result.state.phase).toBe('PLAN_REVIEW');
        expect(result.transitions).toHaveLength(0);
      }
    });

    it('VALIDATION all-passed auto-advances to IMPLEMENTATION', async () => {
      const state = makeState('VALIDATION', {
        ticket: TICKET,
        plan: planWith('## Plan\nTest'),
        activeChecks: ['test_quality', 'rollback_safety'],
        reviewDecision: {
          verdict: 'approve',
          decidedBy: 'r',
          decidedAt: FIXED_TIME,
          decidedByIdentity: {
            actorId: 'r',
            actorEmail: 'r@t.com',
            actorSource: 'env' as const,
            actorAssurance: 'best_effort' as const,
          },
        },
        selfReview: {
          iteration: 1,
          maxIterations: 3,
          prevDigest: null,
          currDigest: 'd',
          revisionDelta: 'none' as const,
          verdict: 'converged' as const,
        },
      });
      const result = await executeContinue(state, ctx, makeExecutors());
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('IMPLEMENTATION');
      }
    });

    it('TICKET phase evaluates without calling phase-specific executors', async () => {
      const state = makeState('TICKET', { ticket: TICKET });
      const executors = makeExecutors();
      const result = await executeContinue(state, ctx, executors);
      expect(result.kind).toBe('ok');
      // TICKET is not VALIDATION/PLAN/IMPL_REVIEW/ARCHITECTURE — no phase-specific executor calls
      expect(executors.runCheck).not.toHaveBeenCalled();
      expect(executors.selfReview).not.toHaveBeenCalled();
    });

    it('ARCH_REVIEW user gate waits without auto-advance', async () => {
      const state = makeState('ARCH_REVIEW');
      const result = await executeContinue(state, ctx, makeExecutors());
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.evalResult.kind).toBe('waiting');
        expect(result.state.phase).toBe('ARCH_REVIEW');
      }
    });

    it('EVIDENCE_REVIEW user gate waits without auto-advance', async () => {
      const state = makeState('EVIDENCE_REVIEW');
      const result = await executeContinue(state, ctx, makeExecutors());
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.evalResult.kind).toBe('waiting');
        expect(result.state.phase).toBe('EVIDENCE_REVIEW');
      }
    });
  });

  // ── BAD ────────────────────────────────────────────────────────────────
  describe('BAD', () => {
    it('blocks at terminal phase — mutating commands blocked at COMPLETE', async () => {
      // CONTINUE is a mutating command (* in policy), but TERMINAL check blocks it.
      const state = makeState('COMPLETE');
      const result = await executeContinue(state, ctx, makeExecutors());
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('COMMAND_NOT_ALLOWED');
        expect(result.reason).toContain('/continue');
      }
    });
  });

  // ── CORNER ─────────────────────────────────────────────────────────────
  describe('CORNER', () => {
    it('self-review iteration >= maxIterations forces convergence', async () => {
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: {
          iteration: 3,
          maxIterations: 3,
          prevDigest: 'd2',
          currDigest: 'd3',
          revisionDelta: 'major' as const,
          verdict: 'changes_requested' as const,
        },
      });
      const executors = makeExecutors({
        selfReview: vi.fn().mockResolvedValue({ verdict: 'changes_requested' as const }),
      });
      const result = await executeContinue(state, ctx, executors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        // At max iteration, the loop converges without calling selfReview again
        expect(executors.selfReview).not.toHaveBeenCalled();
      }
    });

    it('ARCHITECTURE with converged review runs executor and updates selfReview', async () => {
      const state = makeState('ARCHITECTURE', {
        architecture: ARCHITECTURE_DECISION,
        selfReview: {
          iteration: 0,
          maxIterations: 3,
          prevDigest: null,
          currDigest: ARCHITECTURE_DECISION.digest,
          revisionDelta: 'major' as const,
          verdict: 'changes_requested' as const,
        },
      });
      const executors = makeExecutors({
        architectureReview: vi
          .fn()
          .mockResolvedValue({ verdict: 'converged' as const, revisedText: 'Revised ADR' }),
      });
      const result = await executeContinue(state, ctx, executors);
      expect(result.kind).toBe('ok');
      expect(executors.architectureReview).toHaveBeenCalledTimes(1);
      if (result.kind === 'ok') {
        expect(result.state.selfReview).not.toBeNull();
      }
    });

    it('REVIEW_COMPLETE terminal phase blocks continue', async () => {
      const state = makeState('REVIEW_COMPLETE');
      const result = await executeContinue(state, ctx, makeExecutors());
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('COMMAND_NOT_ALLOWED');
      }
    });
  });

  // ── SMOKE ──────────────────────────────────────────────────────────────
  describe('SMOKE', () => {
    it('does not throw with valid user-gate state + mock executors', async () => {
      const state = makeState('PLAN_REVIEW');
      await expect(executeContinue(state, ctx, makeExecutors())).resolves.toBeDefined();
    });
  });
});
