/**
 * @module integration/review-cycle-identity.test
 * @description Explicit human review-cycle identity for the governed review
 *              loops: initialization, increment authority, obligation binding,
 *              and the peer-review `reviewCycle === null` invariant.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, expect, it } from 'vitest';
import {
  makeState,
  makeProgressedState,
  PLAN_RECORD,
  DECISION_IDENTITY_REVIEWER,
} from '../fixtures.js';
import { executeReviewDecision } from '../rails/review-decision.js';
import { createTestContext } from '../testing.js';
import { hashText } from '../shared/hashing.js';
import type { SessionState } from '../state/schema.js';
import type { ReviewObligation as ReviewObligationType, ReviewVerdict } from '../state/evidence.js';
import { ReviewObligation, ReviewCycles } from '../state/evidence.js';
import {
  artifactReviewSubjectScope,
  createReviewObligation,
  freezeReviewMaterial,
} from './review/assurance.js';

const ctx = createTestContext();

const decide = (state: SessionState, verdict: ReviewVerdict) =>
  executeReviewDecision(
    state,
    { verdict, rationale: 'review-cycle test', decisionIdentity: DECISION_IDENTITY_REVIEWER },
    ctx,
  );

const PLAN_BODY = PLAN_RECORD.current.body;

/** Canonical plan obligation at `iteration` 1 in the given human cycle. */
function planObligation(reviewCycle: number): ReviewObligationType {
  return createReviewObligation({
    obligationType: 'plan',
    iteration: 1,
    reviewCycle,
    planVersion: 1,
    now: '2026-01-01T00:00:00.000Z',
    subjectDigest: PLAN_RECORD.current.digest,
    reviewMaterial: freezeReviewMaterial(PLAN_BODY, PLAN_RECORD.current.digest),
    reviewSubjectScope: artifactReviewSubjectScope('plan', PLAN_BODY, PLAN_RECORD.current.digest),
    repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
  });
}

/** Canonical peer review obligation: exactly one pass, no human cycle. */
function peerReviewObligation(): ReviewObligationType {
  const subjectDigest = hashText('peer content');
  return createReviewObligation({
    obligationType: 'review',
    iteration: 1,
    reviewCycle: null,
    planVersion: 1,
    now: '2026-01-01T00:00:00.000Z',
    subjectDigest,
    reviewSubject: {
      kind: 'content',
      source: { kind: 'inline', mediaType: 'text' },
      materialDigest: freezeReviewMaterial('peer content', subjectDigest).materialDigest,
      subjectDigest,
      lineCount: 1,
    },
    reviewMaterial: freezeReviewMaterial('peer content', subjectDigest),
    reviewSubjectScope: { kind: 'content', subjectDigest, lineCount: 1 },
  });
}

function reviewedState(result: ReturnType<typeof decide>): SessionState {
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') throw new TypeError('expected an ok rail result');
  return result.state;
}

describe('review-cycle identity', () => {
  describe('HAPPY — initialization and human increment authority', () => {
    it('initializes all three loop counters at cycle 1', () => {
      expect(makeState('READY').reviewCycles).toEqual({
        plan: 1,
        architecture: 1,
        implementation: 1,
      });
      expect(ReviewCycles.parse({ plan: 1, architecture: 1, implementation: 1 })).toEqual({
        plan: 1,
        architecture: 1,
        implementation: 1,
      });
    });

    it('a changes_requested at PLAN_REVIEW increments plan exactly once', () => {
      const state = reviewedState(decide(makeState('PLAN_REVIEW'), 'changes_requested'));
      expect(state.phase).toBe('PLAN');
      expect(state.reviewCycles).toEqual({ plan: 2, architecture: 1, implementation: 1 });
      // The loop restart clears the loop state; the cycle counter carries the identity.
      expect(state.selfReview).toBeNull();

      // A second decision is inadmissible at PLAN and cannot double-increment.
      const again = decide(state, 'changes_requested');
      expect(again.kind).toBe('blocked');
      expect(state.reviewCycles.plan).toBe(2);
    });

    it('a changes_requested at ARCH_REVIEW increments only architecture', () => {
      const state = reviewedState(decide(makeProgressedState('ARCH_REVIEW'), 'changes_requested'));
      expect(state.phase).toBe('ARCHITECTURE');
      expect(state.reviewCycles).toEqual({ plan: 1, architecture: 2, implementation: 1 });
      expect(state.selfReview).toBeNull();
      expect(state.architecture?.reviewCompletion).toBe('pending');
    });

    it('a changes_requested at EVIDENCE_REVIEW increments only implementation', () => {
      const state = reviewedState(
        decide(makeProgressedState('EVIDENCE_REVIEW'), 'changes_requested'),
      );
      expect(state.phase).toBe('IMPLEMENTATION');
      expect(state.reviewCycles).toEqual({ plan: 1, architecture: 1, implementation: 2 });
      expect(state.implReview).toBeNull();
      expect(state.implementation).toBeNull();
    });

    it('plan iteration 1 in cycle 1 and iteration 1 in cycle 2 are distinguishable', () => {
      const cycle1 = planObligation(makeState('PLAN_REVIEW').reviewCycles.plan);
      const bumped = reviewedState(decide(makeState('PLAN_REVIEW'), 'changes_requested'));
      const cycle2 = planObligation(bumped.reviewCycles.plan);

      // Same loop position, different human cycle: only reviewCycle differs.
      expect(cycle1.iteration).toBe(1);
      expect(cycle2.iteration).toBe(1);
      expect(cycle1.reviewCycle).toBe(1);
      expect(cycle2.reviewCycle).toBe(2);
      expect(ReviewObligation.parse(cycle1).reviewCycle).toBe(1);
      expect(ReviewObligation.parse(cycle2).reviewCycle).toBe(2);
    });
  });

  describe('BAD — verdicts that never change the counters', () => {
    it('reject preserves all three counters', () => {
      const state = reviewedState(decide(makeState('PLAN_REVIEW'), 'reject'));
      expect(state.phase).toBe('REJECTED');
      expect(state.reviewCycles).toEqual({ plan: 1, architecture: 1, implementation: 1 });
    });

    it('approve preserves all three counters', () => {
      const state = reviewedState(decide(makeProgressedState('ARCH_REVIEW'), 'approve'));
      expect(state.phase).toBe('ARCH_COMPLETE');
      expect(state.reviewCycles).toEqual({ plan: 1, architecture: 1, implementation: 1 });
    });
  });

  describe('BAD — obligation review-cycle invariant', () => {
    it('accepts a peer review obligation with reviewCycle === null', () => {
      expect(ReviewObligation.safeParse(peerReviewObligation()).success).toBe(true);
    });

    it('rejects a peer review obligation carrying a positive reviewCycle', () => {
      const rejected = ReviewObligation.safeParse({
        ...peerReviewObligation(),
        reviewCycle: 1,
      });
      expect(rejected.success).toBe(false);
      if (rejected.success) throw new TypeError('expected schema rejection');
      expect(JSON.stringify(rejected.error.issues)).toContain('reviewCycle === null');
    });

    it('accepts a plan obligation with a positive reviewCycle', () => {
      expect(ReviewObligation.safeParse(planObligation(1)).success).toBe(true);
    });

    it('rejects a plan obligation with reviewCycle === null', () => {
      const rejected = ReviewObligation.safeParse({ ...planObligation(1), reviewCycle: null });
      expect(rejected.success).toBe(false);
      if (rejected.success) throw new TypeError('expected schema rejection');
      expect(JSON.stringify(rejected.error.issues)).toContain('require a positive reviewCycle');
    });
  });

  describe('EDGE — counter domain is strictly positive', () => {
    it('ReviewCycles rejects zero, negative, and unknown keys', () => {
      expect(ReviewCycles.safeParse({ plan: 0, architecture: 1, implementation: 1 }).success).toBe(
        false,
      );
      expect(ReviewCycles.safeParse({ plan: 1, architecture: -1, implementation: 1 }).success).toBe(
        false,
      );
      expect(
        ReviewCycles.safeParse({ plan: 1, architecture: 1, implementation: 1, extra: 1 }).success,
      ).toBe(false);
    });
  });
});
