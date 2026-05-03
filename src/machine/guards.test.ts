import { describe, it, expect } from 'vitest';
import {
  hasError,
  hasPlanReady,
  selfReviewMet,
  selfReviewPending,
  allValidationsPassed,
  checkFailed,
  implComplete,
  implReviewMet,
  implReviewPending,
  reviewDone,
  isConverged,
  GUARDS,
} from '../machine/guards.js';
import type { Phase } from '../state/schema.js';
import {
  makeState,
  FIXED_TIME,
  TICKET,
  PLAN_RECORD,
  SELF_REVIEW_CONVERGED,
  SELF_REVIEW_PENDING as SELF_REVIEW_PENDING_FIX,
  VALIDATION_PASSED,
  VALIDATION_FAILED,
  IMPL_EVIDENCE,
  IMPL_REVIEW_CONVERGED,
  IMPL_REVIEW_PENDING_RESULT,
  ERROR_INFO,
} from '../__fixtures__.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';

describe('guards', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('hasError fires when error is present', () => {
      expect(hasError(makeState('TICKET', { error: ERROR_INFO }))).toBe(true);
    });

    it('hasPlanReady fires when ticket and plan are present', () => {
      expect(hasPlanReady(makeState('TICKET', { ticket: TICKET, plan: PLAN_RECORD }))).toBe(true);
    });

    it('selfReviewMet fires when converged (approve + none)', () => {
      expect(selfReviewMet(makeState('PLAN', { selfReview: SELF_REVIEW_CONVERGED }))).toBe(true);
    });

    it('selfReviewPending fires when not converged', () => {
      expect(selfReviewPending(makeState('PLAN', { selfReview: SELF_REVIEW_PENDING_FIX }))).toBe(
        true,
      );
    });

    it('allValidationsPassed fires when all checks pass', () => {
      expect(allValidationsPassed(makeState('VALIDATION', { validation: VALIDATION_PASSED }))).toBe(
        true,
      );
    });

    it('checkFailed fires when some checks fail', () => {
      expect(checkFailed(makeState('VALIDATION', { validation: VALIDATION_FAILED }))).toBe(true);
    });

    it('implComplete fires when implementation is present', () => {
      expect(implComplete(makeState('IMPLEMENTATION', { implementation: IMPL_EVIDENCE }))).toBe(
        true,
      );
    });

    it('implReviewMet fires when impl review converged', () => {
      expect(implReviewMet(makeState('IMPL_REVIEW', { implReview: IMPL_REVIEW_CONVERGED }))).toBe(
        true,
      );
    });

    it('implReviewPending fires when impl review not converged', () => {
      expect(
        implReviewPending(makeState('IMPL_REVIEW', { implReview: IMPL_REVIEW_PENDING_RESULT })),
      ).toBe(true);
    });

    it('reviewDone fires when phase is REVIEW and report path is set', () => {
      expect(reviewDone(makeState('REVIEW', { reviewReportPath: '/tmp/report.json' }))).toBe(true);
    });

    it('reviewDone does not fire when REVIEW phase has no report path (P8b)', () => {
      expect(reviewDone(makeState('REVIEW', { reviewReportPath: null }))).toBe(false);
      expect(reviewDone(makeState('REVIEW'))).toBe(false);
    });

    it('isConverged returns true on iteration limit', () => {
      expect(
        isConverged({
          iteration: 3,
          maxIterations: 3,
          revisionDelta: 'major',
          verdict: 'changes_requested',
        }),
      ).toBe(true);
    });

    it('isConverged returns true on digest-stop (none + approve)', () => {
      expect(
        isConverged({ iteration: 1, maxIterations: 3, revisionDelta: 'none', verdict: 'approve' }),
      ).toBe(true);
    });

    it('isConverged returns false when still iterating', () => {
      expect(
        isConverged({
          iteration: 1,
          maxIterations: 3,
          revisionDelta: 'minor',
          verdict: 'changes_requested',
        }),
      ).toBe(false);
    });

    it('isConverged returns false on none + changes_requested (no approval)', () => {
      expect(
        isConverged({
          iteration: 1,
          maxIterations: 3,
          revisionDelta: 'none',
          verdict: 'changes_requested',
        }),
      ).toBe(false);
    });

    it('isConverged returns false on approve + major (still changing)', () => {
      expect(
        isConverged({ iteration: 1, maxIterations: 3, revisionDelta: 'major', verdict: 'approve' }),
      ).toBe(false);
    });

    // ─── P1.3 slice 4a: unable_to_review must never converge ────────────
    // The early-return in isConverged() is the runtime gate that prevents
    // a tool-failure verdict from being silently upgraded to "converged"
    // by either the digest-stop disjunct or the maxIterations disjunct.
    // Each test below pins one combination that previously WOULD have
    // returned true (under the broader pre-slice-1 enum) but now MUST
    // return false because the third verdict short-circuits the check.

    it('isConverged returns false on unable_to_review (HAPPY: mid-iteration tool failure)', () => {
      // Reviewer reports tool-failure on iteration 1 of 3. This is the
      // typical case — must NOT converge; orchestrator routes to BLOCKED.
      expect(
        isConverged({
          iteration: 1,
          maxIterations: 3,
          revisionDelta: 'minor',
          verdict: 'unable_to_review',
        }),
      ).toBe(false);
    });

    it('isConverged returns false on unable_to_review at iteration limit (CORNER: maxIterations disjunct)', () => {
      // Critical regression guard: BEFORE the slice-4a early-return, the
      // iteration >= maxIterations disjunct would have force-converged
      // this case, silently upgrading a tool-failure to a converged loop.
      // The early-return MUST short-circuit this disjunct.
      expect(
        isConverged({
          iteration: 3,
          maxIterations: 3,
          revisionDelta: 'major',
          verdict: 'unable_to_review',
        }),
      ).toBe(false);
    });

    it('isConverged returns false on unable_to_review past iteration limit (CORNER: defensive overshoot)', () => {
      // Defensive: even if iteration somehow exceeds maxIterations
      // (e.g. via a race or forced state edit), unable_to_review still
      // blocks convergence. The early-return is order-independent of
      // numeric comparisons.
      expect(
        isConverged({
          iteration: 5,
          maxIterations: 3,
          revisionDelta: 'major',
          verdict: 'unable_to_review',
        }),
      ).toBe(false);
    });

    it('isConverged returns false on unable_to_review with revisionDelta=none (CORNER: digest-stop disjunct)', () => {
      // The (revisionDelta === "none" AND verdict === "approve") disjunct
      // already excludes this verdict via the verdict equality check.
      // This test pins the behavior so that future refactors of the
      // digest-stop predicate cannot accidentally drop the verdict guard.
      expect(
        isConverged({
          iteration: 1,
          maxIterations: 3,
          revisionDelta: 'none',
          verdict: 'unable_to_review',
        }),
      ).toBe(false);
    });

    it('isConverged returns false on unable_to_review at iteration zero (EDGE: first-call tool failure)', () => {
      // Edge: reviewer fails on the very first invocation. Must still
      // route to BLOCKED, not converge. Confirms the early-return fires
      // even when no normal convergence condition could possibly be true.
      expect(
        isConverged({
          iteration: 0,
          maxIterations: 3,
          revisionDelta: 'major',
          verdict: 'unable_to_review',
        }),
      ).toBe(false);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('hasError does not fire when error is null', () => {
      expect(hasError(makeState('TICKET'))).toBe(false);
    });

    it('hasPlanReady does not fire without ticket', () => {
      expect(hasPlanReady(makeState('TICKET', { plan: PLAN_RECORD }))).toBe(false);
    });

    it('hasPlanReady does not fire without plan', () => {
      expect(hasPlanReady(makeState('TICKET', { ticket: TICKET }))).toBe(false);
    });

    it('selfReviewMet does not fire when selfReview is null', () => {
      expect(selfReviewMet(makeState('PLAN'))).toBe(false);
    });

    it('selfReviewPending does not fire when selfReview is null', () => {
      expect(selfReviewPending(makeState('PLAN'))).toBe(false);
    });

    it('allValidationsPassed does not fire with empty activeChecks', () => {
      expect(allValidationsPassed(makeState('VALIDATION', { activeChecks: [] }))).toBe(false);
    });

    it('checkFailed does not fire with empty validation results', () => {
      expect(checkFailed(makeState('VALIDATION'))).toBe(false);
    });

    it('implComplete does not fire without implementation', () => {
      expect(implComplete(makeState('IMPLEMENTATION'))).toBe(false);
    });

    it('implReviewMet does not fire when implReview is null', () => {
      expect(implReviewMet(makeState('IMPL_REVIEW'))).toBe(false);
    });

    it('reviewDone does not fire when phase is not REVIEW', () => {
      expect(reviewDone(makeState('TICKET'))).toBe(false);
      expect(reviewDone(makeState('READY'))).toBe(false);
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('selfReviewMet fires when iteration equals maxIterations', () => {
      const atMax = makeState('PLAN', {
        selfReview: {
          iteration: 3,
          maxIterations: 3,
          prevDigest: 'd1',
          currDigest: 'd2',
          revisionDelta: 'minor',
          verdict: 'changes_requested',
        },
      });
      expect(selfReviewMet(atMax)).toBe(true);
    });

    it('selfReviewMet does not fire at iteration < maxIterations with pending', () => {
      const notAtMax = makeState('PLAN', {
        selfReview: {
          iteration: 2,
          maxIterations: 3,
          prevDigest: 'd1',
          currDigest: 'd2',
          revisionDelta: 'minor',
          verdict: 'changes_requested',
        },
      });
      expect(selfReviewMet(notAtMax)).toBe(false);
    });

    it('implReviewMet fires at exactly maxIterations even with pending verdict', () => {
      const atMax = makeState('IMPL_REVIEW', {
        implReview: {
          iteration: 3,
          maxIterations: 3,
          prevDigest: 'd1',
          currDigest: 'd2',
          revisionDelta: 'minor',
          verdict: 'changes_requested',
          executedAt: FIXED_TIME,
        },
      });
      expect(implReviewMet(atMax)).toBe(true);
    });

    it('allValidationsPassed requires EVERY active check to pass', () => {
      const onePass = makeState('VALIDATION', {
        validation: [
          {
            checkId: 'test_quality',
            passed: true,
            detail: 'ok',
            executedAt: FIXED_TIME,
          },
        ],
      });
      // activeChecks has 2 but only 1 passed
      expect(allValidationsPassed(onePass)).toBe(false);
    });

    it('selfReviewMet works identically for ARCHITECTURE phase', () => {
      const archState = makeState('ARCHITECTURE', {
        selfReview: SELF_REVIEW_CONVERGED,
      });
      expect(selfReviewMet(archState)).toBe(true);
    });

    it('selfReviewPending works identically for ARCHITECTURE phase', () => {
      const archState = makeState('ARCHITECTURE', {
        selfReview: SELF_REVIEW_PENDING_FIX,
      });
      expect(selfReviewPending(archState)).toBe(true);
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('GUARDS table covers all guard-based phases', () => {
      const guardPhases: Phase[] = [
        'TICKET',
        'PLAN',
        'VALIDATION',
        'IMPLEMENTATION',
        'IMPL_REVIEW',
        'ARCHITECTURE',
        'REVIEW',
      ];
      for (const phase of guardPhases) {
        expect(GUARDS.has(phase)).toBe(true);
      }
    });

    it('GUARDS table does not include READY, user gates, or terminals', () => {
      expect(GUARDS.has('READY')).toBe(false);
      expect(GUARDS.has('PLAN_REVIEW')).toBe(false);
      expect(GUARDS.has('EVIDENCE_REVIEW')).toBe(false);
      expect(GUARDS.has('ARCH_REVIEW')).toBe(false);
      expect(GUARDS.has('COMPLETE')).toBe(false);
      expect(GUARDS.has('ARCH_COMPLETE')).toBe(false);
      expect(GUARDS.has('REVIEW_COMPLETE')).toBe(false);
    });

    it("ERROR guard is always first in each phase's guard list", () => {
      for (const [_phase, entries] of GUARDS) {
        expect(entries[0]?.event).toBe('ERROR');
      }
    });

    it('allValidationsPassed with duplicate passing checkIds still passes', () => {
      const withDup = makeState('VALIDATION', {
        activeChecks: ['test_quality', 'rollback_safety'],
        validation: [
          {
            checkId: 'test_quality',
            passed: true,
            detail: 'ok',
            executedAt: FIXED_TIME,
          },
          {
            checkId: 'test_quality',
            passed: true,
            detail: 'ok2',
            executedAt: FIXED_TIME,
          },
          {
            checkId: 'rollback_safety',
            passed: true,
            detail: 'ok',
            executedAt: FIXED_TIME,
          },
        ],
      });
      expect(allValidationsPassed(withDup)).toBe(true);
    });

    it('allValidationsPassed ignores extra validation results not in activeChecks', () => {
      const withExtra = makeState('VALIDATION', {
        activeChecks: ['test_quality'],
        validation: [
          {
            checkId: 'test_quality',
            passed: true,
            detail: 'ok',
            executedAt: FIXED_TIME,
          },
          {
            checkId: 'rollback_safety',
            passed: false,
            detail: 'fail',
            executedAt: FIXED_TIME,
          },
        ],
      });
      expect(allValidationsPassed(withExtra)).toBe(true);
    });

    it('ARCHITECTURE guards are identical to PLAN guards (same convergence logic)', () => {
      const planGuards = GUARDS.get('PLAN')!;
      const archGuards = GUARDS.get('ARCHITECTURE')!;
      expect(archGuards.length).toBe(planGuards.length);
      expect(archGuards.map((g) => g.event)).toEqual(planGuards.map((g) => g.event));
    });
  });

  // ─── MUTATION KILL: implReviewPending ───────────────────────
  describe('MUTATION_KILL', () => {
    it('implReviewPending: true when implReview non-null and not converged', () => {
      // implReview present but verdict != 'converged' → pending
      const state = makeState('IMPLEMENTATION', {
        implReview: IMPL_REVIEW_PENDING_RESULT,
      });
      expect(implReviewPending(state)).toBe(true);
    });

    it('implReviewPending: false when implReview is null (first operand)', () => {
      const state = makeState('IMPLEMENTATION', { implReview: null });
      expect(implReviewPending(state)).toBe(false);
    });

    it('implReviewPending: false when implReview converged (!implReviewMet)', () => {
      const state = makeState('IMPLEMENTATION', {
        implReview: IMPL_REVIEW_CONVERGED,
      });
      expect(implReviewPending(state)).toBe(false);
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('guard predicate evaluation < 0.1ms (p99)', () => {
      const state = makeState('VALIDATION', { validation: VALIDATION_PASSED });
      const result = benchmarkSync(() => {
        allValidationsPassed(state);
      });
      expect(result.p99Ms).toBeLessThan(PERF_BUDGETS.guardPredicateMs);
    });
  });
});
