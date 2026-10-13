/**
 * @module documentation/demo-review-continuation.test
 * @description Plan-gate continuation must be state-driven: transport recovery,
 * bound-verdict submission, and authorized revisions are different outcomes, and
 * unreadable state never advances a flow.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import {
  PLAN_GATE,
  classifyPlanGate,
  planGateProgressKey,
} from '../../../demos/lib/review-continuation.mjs';

interface Options {
  phase?: string;
  reviewCompletion?: string;
  iteration?: number;
  planVersion?: number;
  findings?: number;
  obligation?: { id: string; status: 'pending' | 'fulfilled'; consumedAt: null | string } | null;
}

function planState(options: Options = {}) {
  return {
    phase: options.phase ?? 'PLAN',
    plan: {
      reviewCompletion: options.reviewCompletion ?? 'pending',
      current: { planVersion: options.planVersion ?? 1 },
      reviewFindings: Array.from({ length: options.findings ?? 0 }, (_, index) => ({
        index,
      })),
    },
    selfReview: { iteration: options.iteration ?? 0, maxIterations: 3 },
    reviewAssurance: {
      obligations:
        options.obligation === null
          ? []
          : [
              {
                obligationType: 'plan',
                obligationId: options.obligation?.id ?? 'ob-1',
                status: options.obligation?.status ?? 'pending',
                consumedAt: options.obligation?.consumedAt ?? null,
              },
            ],
    },
  };
}

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
  });

  describe('CORNER — open obligation with captured but unconsumed verdict', () => {
    it('requires bound-verdict submission when findings exceed consumed iterations', () => {
      expect(
        classifyPlanGate(
          planState({
            obligation: { id: 'ob-7', status: 'fulfilled', consumedAt: null },
            findings: 1,
            iteration: 0,
          }),
        ),
      ).toBe(PLAN_GATE.SUBMIT_BOUND_VERDICT);
    });

    it('requires transport recovery while the capture is still missing', () => {
      expect(
        classifyPlanGate(
          planState({
            obligation: { id: 'ob-7', status: 'pending', consumedAt: null },
            findings: 0,
            iteration: 0,
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

    it('progress key changes only on review-relevant state', () => {
      const before = planState({ obligation: null, findings: 1, iteration: 1 });
      const progressed = planState({ obligation: null, findings: 2, iteration: 1 });
      const cosmetic = {
        ...before,
        plan: { ...before.plan, current: { planVersion: 1, note: 'x' } },
      };
      expect(planGateProgressKey(progressed)).not.toBe(planGateProgressKey(before));
      expect(planGateProgressKey(cosmetic)).toBe(planGateProgressKey(before));
    });
  });
});
