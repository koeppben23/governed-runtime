import { describe, it, expect } from 'vitest';
import {
  applyTransition,
  autoAdvance,
  runConvergenceLoop,
  runSingleIteration,
  createPolicyEvalFn,
  DEFAULT_MAX_REVIEW_ITERATIONS,
} from '../rails/types';
import type { RailContext, ConvergenceResult, IterationResult } from '../rails/types';
import { evaluate } from '../machine/evaluate';
import {
  makeState,
  makeProgressedState,
  TICKET,
  PLAN_RECORD,
  SELF_REVIEW_CONVERGED,
  VALIDATION_PASSED,
  IMPL_EVIDENCE,
  IMPL_REVIEW_CONVERGED,
} from '../__fixtures__';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy';
import { createTestContext } from '../testing';

const ctx = createTestContext();

describe('rails/types', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('applyTransition returns new state with updated phase', () => {
      const state = makeState('TICKET');
      const next = applyTransition(
        state,
        'TICKET',
        'PLAN',
        'PLAN_READY',
        '2026-01-01T00:00:00.000Z',
      );
      expect(next.phase).toBe('PLAN');
      expect(next.transition).toEqual({
        from: 'TICKET',
        to: 'PLAN',
        event: 'PLAN_READY',
        at: '2026-01-01T00:00:00.000Z',
      });
      expect(next.error).toBeNull();
    });

    it('applyTransition clears error', () => {
      const state = makeState('TICKET', {
        error: {
          code: 'ERR',
          message: 'err',
          recoveryHint: 'h',
          occurredAt: '2026-01-01T00:00:00.000Z',
        },
      });
      const next = applyTransition(
        state,
        'TICKET',
        'PLAN',
        'PLAN_READY',
        '2026-01-01T00:00:00.000Z',
      );
      expect(next.error).toBeNull();
    });

    it('autoAdvance transitions through guard-based phases', () => {
      // TICKET with ticket+plan → should advance to PLAN via PLAN_READY
      const state = makeState('TICKET', { ticket: TICKET, plan: PLAN_RECORD });
      const evalFn = (s: typeof state) => evaluate(s);
      const result = autoAdvance(state, evalFn, ctx);
      expect(result.state.phase).toBe('PLAN');
      expect(result.transitions.length).toBeGreaterThanOrEqual(1);
      expect(result.transitions[0]?.event).toBe('PLAN_READY');
    });

    it('autoAdvance stops at user gates (waiting)', () => {
      // State at PLAN with converged self-review → should advance to PLAN_REVIEW and stop
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_CONVERGED,
      });
      const evalFn = (s: typeof state) => evaluate(s);
      const result = autoAdvance(state, evalFn, ctx);
      expect(result.state.phase).toBe('PLAN_REVIEW');
      expect(result.evalResult.kind).toBe('waiting');
    });

    it('autoAdvance stops at terminal', () => {
      const state = makeProgressedState('COMPLETE');
      const evalFn = (s: typeof state) => evaluate(s);
      const result = autoAdvance(state, evalFn, ctx);
      expect(result.state.phase).toBe('COMPLETE');
      expect(result.evalResult.kind).toBe('terminal');
      expect(result.transitions.length).toBe(0);
    });

    it('DEFAULT_MAX_REVIEW_ITERATIONS is 3', () => {
      expect(DEFAULT_MAX_REVIEW_ITERATIONS).toBe(3);
    });

    it('createPolicyEvalFn returns a function that evaluates with policy', () => {
      const policyCtx: RailContext = {
        ...ctx,
        policy: {
          mode: 'solo',
          requireHumanGates: false,
          maxSelfReviewIterations: 1,
          maxImplReviewIterations: 1,
          allowSelfApproval: true,
          audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: false },
          actorClassification: {},
        },
      };
      const evalFn = createPolicyEvalFn(policyCtx);
      const state = makeProgressedState('PLAN_REVIEW');
      const result = evalFn(state);
      // Solo mode auto-approves at user gates
      expect(result.kind).toBe('transition');
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('autoAdvance with no transitions returns empty transitions array', () => {
      const state = makeState('TICKET'); // No evidence → pending
      const evalFn = (s: typeof state) => evaluate(s);
      const result = autoAdvance(state, evalFn, ctx);
      expect(result.transitions.length).toBe(0);
      expect(result.evalResult.kind).toBe('pending');
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('autoAdvance stops on self-loop (same target phase)', () => {
      // PLAN with pending self-review → SELF_REVIEW_PENDING → PLAN (self-loop → stop)
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: {
          iteration: 1,
          maxIterations: 3,
          prevDigest: null,
          currDigest: 'd',
          revisionDelta: 'minor',
          verdict: 'changes_requested',
        },
      });
      const evalFn = (s: typeof state) => evaluate(s);
      const result = autoAdvance(state, evalFn, ctx);
      // Should stop because SELF_REVIEW_PENDING → PLAN is a self-loop
      expect(result.state.phase).toBe('PLAN');
      expect(result.transitions.length).toBe(0);
    });

    it('runConvergenceLoop converges on first iteration when approved+none', async () => {
      const initial = { digest: 'd1', value: 'original' };
      const result = await runConvergenceLoop(initial, 3, async () => {
        return { verdict: 'approve' as const };
      });
      expect(result.iteration).toBe(1);
      expect(result.revisionDelta).toBe('none');
      expect(result.verdict).toBe('approve');
      expect(result.artifact).toBe(initial);
    });

    it('runConvergenceLoop stops at maxIterations', async () => {
      let count = 0;
      const initial = { digest: 'd1' };
      const result = await runConvergenceLoop(initial, 2, async (_current, _iter) => {
        count++;
        return {
          verdict: 'changes_requested' as const,
          updated: { digest: `d${count + 1}` },
        };
      });
      expect(result.iteration).toBe(2);
      expect(count).toBe(2);
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('runSingleIteration at maxIterations returns immediately', async () => {
      const current = { digest: 'd1' };
      const result = await runSingleIteration(current, 3, 3, async () => {
        throw new Error('should not be called');
      });
      expect(result.iteration).toBe(3);
      expect(result.verdict).toBe('approve');
      expect(result.revisionDelta).toBe('none');
    });

    it('runSingleIteration runs exactly one iteration', async () => {
      let called = 0;
      const current = { digest: 'd1' };
      const result = await runSingleIteration(current, 0, 3, async () => {
        called++;
        return { verdict: 'approve' as const };
      });
      expect(called).toBe(1);
      expect(result.iteration).toBe(1);
    });

    it('runConvergenceLoop tracks prevDigest correctly', async () => {
      const initial = { digest: 'd0' };
      const result = await runConvergenceLoop(initial, 3, async (current, iter) => {
        if (iter < 3) {
          return {
            verdict: 'changes_requested' as const,
            updated: { digest: `d${iter}` },
          };
        }
        return { verdict: 'approve' as const };
      });
      // Last iteration should have prevDigest from previous iteration
      expect(result.prevDigest).toBeDefined();
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('autoAdvance loop < 5ms (p99)', () => {
      const state = makeState('TICKET', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_CONVERGED,
      });
      const evalFn = (s: typeof state) => evaluate(s);
      const result = benchmarkSync(
        () => {
          autoAdvance(state, evalFn, ctx);
        },
        200,
        50,
      );
      expect(result.p99Ms).toBeLessThan(PERF_BUDGETS.autoAdvanceMs);
    });
  });
});
