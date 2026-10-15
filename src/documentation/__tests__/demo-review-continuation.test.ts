/**
 * @module documentation/demo-review-continuation.test
 * @description Plan-gate continuation must be state-driven from the REAL review
 * assurance evidence: a bound verdict is a persisted invocation for the current
 * obligation, never a findings/iteration counter. Transport recovery, bound
 * verdict submission and authorized revisions are different outcomes; unreadable
 * state never advances a flow.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import {
  PLAN_GATE,
  boundPlanVerdict,
  classifyPlanGate,
  planGateNotConvergedReason,
  planGateProgressKey,
} from '../../../demos/lib/review-continuation.mjs';

interface Invocation {
  invocationId: string;
  obligationId: string;
  attemptId: string;
  fulfilledAt: string | null;
}

interface Options {
  phase?: string;
  reviewCompletion?: string;
  iteration?: number;
  planVersion?: number;
  findings?: number;
  obligation?: {
    id: string;
    status: 'pending' | 'fulfilled';
    invocationId?: string | null;
    consumedAt?: string | null;
  } | null;
  invocations?: Invocation[];
  attempts?: Array<{ obligationId: string; attemptId: string; status: string }>;
}

function planState(options: Options = {}) {
  const obligation = options.obligation ?? null;
  return {
    phase: options.phase ?? 'PLAN',
    plan: {
      reviewCompletion: options.reviewCompletion ?? 'pending',
      current: { planVersion: options.planVersion ?? 1 },
      reviewFindings: Array.from({ length: options.findings ?? 0 }, (_, index) => ({
        index,
        verdict: 'changes_requested',
      })),
    },
    selfReview: { iteration: options.iteration ?? 0, maxIterations: 3 },
    reviewAssurance: {
      obligations:
        obligation === null
          ? []
          : [
              {
                obligationId: obligation.id,
                obligationType: 'plan',
                status: obligation.status,
                invocationId: obligation.invocationId ?? null,
                consumedAt: obligation.consumedAt ?? null,
                iteration: options.iteration ?? 0,
              },
            ],
      invocations: options.invocations ?? [],
      attempts: options.attempts ?? [],
    },
  };
}

const boundInvocation: Invocation = {
  invocationId: 'inv-7',
  obligationId: 'ob-7',
  attemptId: 'att-7',
  fulfilledAt: '2026-10-13T08:00:00.000Z',
};

describe('demo review continuation classification', () => {
  describe('HAPPY — persisted acceptance', () => {
    it('classifies a persisted reviewer_accepted plan as accepted', () => {
      expect(
        classifyPlanGate(
          planState({ phase: 'PLAN_REVIEW', reviewCompletion: 'reviewer_accepted' }),
        ),
      ).toBe(PLAN_GATE.ACCEPTED);
    });
  });

  describe('BAD — exhaustion and unreadable state', () => {
    it('classifies review_exhausted as a governed terminal outcome', () => {
      expect(
        classifyPlanGate(planState({ phase: 'PLAN_REVIEW', reviewCompletion: 'review_exhausted' })),
      ).toBe(PLAN_GATE.REVIEW_EXHAUSTED);
    });

    it('fails closed when the plan or self-review state is unreadable', () => {
      expect(classifyPlanGate({})).toBe(PLAN_GATE.UNREADABLE);
      expect(classifyPlanGate({ phase: 'PLAN', plan: null, selfReview: null })).toBe(
        PLAN_GATE.UNREADABLE,
      );
    });

    it('fails closed on a pending unknown phase', () => {
      expect(classifyPlanGate(planState({ phase: 'EXPORT_READY' }))).toBe(PLAN_GATE.UNREADABLE);
    });

    it('fails closed when a fulfilled obligation has no bound invocation', () => {
      expect(
        classifyPlanGate(
          planState({
            obligation: { id: 'ob-7', status: 'fulfilled', invocationId: 'inv-7' },
            invocations: [],
          }),
        ),
      ).toBe(PLAN_GATE.UNREADABLE);
    });
  });

  describe('CORNER — bound verdict versus transport recovery', () => {
    it('requires bound-verdict submission when the current obligation has a persisted invocation', () => {
      const state = planState({
        obligation: { id: 'ob-7', status: 'fulfilled', invocationId: 'inv-7' },
        invocations: [boundInvocation],
        findings: 0,
        iteration: 0,
      });
      expect(boundPlanVerdict(state, state.reviewAssurance.obligations[0])).toEqual(
        boundInvocation,
      );
      expect(classifyPlanGate(state)).toBe(PLAN_GATE.SUBMIT_BOUND_VERDICT);
    });

    it('requires transport recovery when the current obligation has no invocation', () => {
      expect(
        classifyPlanGate(
          planState({
            obligation: { id: 'ob-7', status: 'pending', invocationId: null },
            findings: 0,
            iteration: 0,
          }),
        ),
      ).toBe(PLAN_GATE.TRANSPORT_RETRY);
    });

    it('ignores stale findings from previous review cycles', () => {
      expect(
        classifyPlanGate(
          planState({
            obligation: { id: 'ob-9', status: 'pending', invocationId: null },
            findings: 5,
            iteration: 2,
          }),
        ),
      ).toBe(PLAN_GATE.TRANSPORT_RETRY);
    });
  });

  describe('EDGE — consumed changes_requested authorizes a revision', () => {
    it('classifies a consumed obligation without open review as a revision step', () => {
      expect(
        classifyPlanGate(
          planState({ obligation: null, findings: 1, iteration: 1, planVersion: 2 }),
        ),
      ).toBe(PLAN_GATE.REVISE_PLAN);
    });

    it('progress key tracks obligation lifecycle and attempt identity', () => {
      const pending = planState({
        obligation: { id: 'ob-7', status: 'pending', invocationId: null },
        attempts: [{ obligationId: 'ob-7', attemptId: 'att-1', status: 'spent' }],
      });
      const fulfilled = planState({
        obligation: { id: 'ob-7', status: 'fulfilled', invocationId: 'inv-7' },
        invocations: [boundInvocation],
        attempts: [{ obligationId: 'ob-7', attemptId: 'att-1', status: 'spent' }],
      });
      const newerAttempt = planState({
        obligation: { id: 'ob-7', status: 'fulfilled', invocationId: 'inv-8' },
        invocations: [
          boundInvocation,
          { ...boundInvocation, invocationId: 'inv-8', attemptId: 'att-8' },
        ],
        attempts: [{ obligationId: 'ob-7', attemptId: 'att-1', status: 'spent' }],
      });
      const cosmetic = {
        ...pending,
        plan: { ...pending.plan, current: { planVersion: 1, note: 'x' } },
      };
      expect(planGateProgressKey(fulfilled)).not.toBe(planGateProgressKey(pending));
      expect(planGateProgressKey(newerAttempt)).not.toBe(planGateProgressKey(fulfilled));
      expect(planGateProgressKey(cosmetic)).toBe(planGateProgressKey(pending));
    });

    it('a re-armed attempt alone counts as progress (no false STALLED)', () => {
      const before = planState({
        obligation: { id: 'ob-7', status: 'pending', invocationId: null },
        attempts: [{ obligationId: 'ob-7', attemptId: 'att-1', status: 'spent' }],
      });
      const afterRearm = planState({
        obligation: { id: 'ob-7', status: 'pending', invocationId: null },
        attempts: [
          { obligationId: 'ob-7', attemptId: 'att-1', status: 'spent' },
          { obligationId: 'ob-7', attemptId: 'att-2', status: 'created' },
        ],
      });
      expect(planGateProgressKey(afterRearm)).not.toBe(planGateProgressKey(before));
    });
  });

  describe('BAD — a plan that was never submitted is a distinct outcome', () => {
    it('classifies a valid pre-plan TICKET session as not_submitted', () => {
      expect(
        classifyPlanGate({
          phase: 'TICKET',
          plan: null,
          selfReview: null,
          reviewAssurance: { obligations: [] },
        }),
      ).toBe(PLAN_GATE.NOT_SUBMITTED);
    });

    it('keeps corrupted pre-plan shapes unreadable instead of not_submitted', () => {
      expect(
        classifyPlanGate({
          phase: 'TICKET',
          plan: null,
          selfReview: null,
          reviewAssurance: {
            obligations: [
              {
                obligationId: 'ob-7',
                obligationType: 'plan',
                status: 'consumed',
                consumedAt: '2026-10-15T00:00:00.000Z',
              },
            ],
          },
        }),
      ).toBe(PLAN_GATE.UNREADABLE);
      expect(classifyPlanGate({ phase: 'TICKET', plan: {}, selfReview: null })).toBe(
        PLAN_GATE.UNREADABLE,
      );
      expect(classifyPlanGate({ phase: 'PLAN', plan: null, selfReview: null })).toBe(
        PLAN_GATE.UNREADABLE,
      );
    });

    it('never conflates exhaustion, missing submission, and unreadable state', () => {
      const exhausted = planGateNotConvergedReason(PLAN_GATE.REVIEW_EXHAUSTED);
      const notSubmitted = planGateNotConvergedReason(PLAN_GATE.NOT_SUBMITTED);
      const unreadable = planGateNotConvergedReason(PLAN_GATE.UNREADABLE);

      expect(exhausted).toContain('exhausted its budget without acceptance');
      expect(notSubmitted).toContain('never submitted');
      expect(unreadable).toContain('(unreadable)');
      expect(new Set([exhausted, notSubmitted, unreadable]).size).toBe(3);
    });
  });
});
