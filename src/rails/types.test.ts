import { describe, it, expect } from 'vitest';
import {
  applyTransition,
  autoAdvance,
  runConvergenceLoop,
  runSingleIteration,
  createPolicyEvalFn,
  DEFAULT_MAX_REVIEW_ITERATIONS,
} from '../rails/types.js';
import type { RailContext, ConvergenceResult, IterationResult } from '../rails/types.js';
import { evaluate } from '../machine/evaluate.js';
import {
  makeState,
  makeProgressedState,
  TICKET,
  PLAN_RECORD,
  SELF_REVIEW_CONVERGED,
  VALIDATION_PASSED,
  IMPL_EVIDENCE,
  IMPL_REVIEW_CONVERGED,
} from '../__fixtures__.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';
import { createTestContext } from '../testing.js';

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

  // ─── P1.3 slice 4b: BLOCKED routing on unable_to_review ──────────────
  describe('P1.3 slice 4b — unable_to_review routes to BlockedResult', () => {
    it('runConvergenceLoop returns kind=blocked when iterate emits unable_to_review (HAPPY: first iteration)', async () => {
      const initial = { digest: 'd0' };
      const result = await runConvergenceLoop(initial, 3, async () => {
        return { verdict: 'unable_to_review' as const };
      });
      expect(result.kind).toBe('blocked');
      // narrow for further assertions
      if (result.kind !== 'blocked') throw new Error('expected blocked');
      expect(result.code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
      expect(result.iteration).toBe(1);
      expect(result.maxIterations).toBe(3);
      expect(result.verdict).toBe('unable_to_review');
      // BlockedResult must NOT carry an artifact (compile-time guard via never).
      expect((result as unknown as { artifact?: unknown }).artifact).toBeUndefined();
    });

    it('runConvergenceLoop returns kind=blocked at last iteration when iterate emits unable_to_review (CORNER: maxIterations boundary)', async () => {
      // Reviewer changed_requested twice, then declared unreviewable on
      // iteration 3 of 3. Pre-slice-4a, isConverged would have returned
      // true on the maxIterations disjunct; pre-slice-4b, the loop would
      // have returned a ConvergedResult. Now it must return BlockedResult.
      const initial = { digest: 'd0' };
      const result = await runConvergenceLoop(initial, 3, async (_current, iter) => {
        if (iter < 3) {
          return {
            verdict: 'changes_requested' as const,
            updated: { digest: `d${iter}` },
          };
        }
        return { verdict: 'unable_to_review' as const };
      });
      expect(result.kind).toBe('blocked');
      if (result.kind !== 'blocked') throw new Error('expected blocked');
      expect(result.iteration).toBe(3);
      expect(result.maxIterations).toBe(3);
    });

    it('runConvergenceLoop short-circuits — does not invoke iterate after unable_to_review (CORNER: no leakage)', async () => {
      // Once unable_to_review is emitted, the loop must stop. No further
      // iterate calls. This pins the short-circuit so that future refactors
      // cannot accidentally drop the early-return inside the while loop.
      let calls = 0;
      const initial = { digest: 'd0' };
      const result = await runConvergenceLoop(initial, 5, async () => {
        calls++;
        return { verdict: 'unable_to_review' as const };
      });
      expect(calls).toBe(1);
      expect(result.kind).toBe('blocked');
    });

    it('runSingleIteration returns kind=blocked when iterate emits unable_to_review', async () => {
      const current = { digest: 'd0' };
      const result = await runSingleIteration(current, 0, 3, async () => {
        return { verdict: 'unable_to_review' as const };
      });
      expect(result.kind).toBe('blocked');
      if (result.kind !== 'blocked') throw new Error('expected blocked');
      expect(result.code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
      expect(result.iteration).toBe(1);
      expect(result.maxIterations).toBe(3);
      expect(result.verdict).toBe('unable_to_review');
    });

    it('runSingleIteration at maxIterations still returns kind=converged (EDGE: pre-loop guard takes precedence)', async () => {
      // The startIteration >= maxIterations early-return in
      // runSingleIteration fires BEFORE iterate is called. Even if the
      // reviewer would have emitted unable_to_review, the loop never
      // reaches that point; the result is converged with verdict=approve.
      // This pins the precedence order so a future refactor cannot
      // accidentally swap it.
      const current = { digest: 'd0' };
      const result = await runSingleIteration(current, 3, 3, async () => {
        throw new Error('iterate must not be called');
      });
      expect(result.kind).toBe('converged');
      if (result.kind !== 'converged') throw new Error('expected converged');
      expect(result.verdict).toBe('approve');
      expect(result.artifact).toBe(current);
    });

    it('runConvergenceLoop returns kind=converged on normal approve+none (HAPPY: existing path unchanged)', async () => {
      // Regression guard: the new BLOCKED path must NOT fire on normal
      // convergence. Approve+none must still produce ConvergedResult.
      const initial = { digest: 'd0' };
      const result = await runConvergenceLoop(initial, 3, async () => {
        return { verdict: 'approve' as const };
      });
      expect(result.kind).toBe('converged');
      if (result.kind !== 'converged') throw new Error('expected converged');
      expect(result.artifact).toBe(initial);
      expect(result.verdict).toBe('approve');
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
