import { describe, expect, it } from 'vitest';
import { makeState, PLAN_RECORD } from '../fixtures.js';
import type { ReviewAssuranceState } from '../state/evidence-review.js';
import { assuranceChain, type AssuranceEntry } from './review-decision-test-helpers.js';
import {
  resolvePlanReviewEvidence,
  resolveLatestPlanReviewEvidence,
  type PlanReviewSubjectAuthority,
} from './review-evidence-resolution.js';

const SUBJECT = PLAN_RECORD.current.digest;
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const O1 = '11111111-1111-4111-8111-111111111111';
const O2 = '22222222-2222-4222-8222-222222222222';

function assurance(entries: AssuranceEntry[]): ReviewAssuranceState {
  return assuranceChain(entries);
}

function authority(
  overrides: Partial<PlanReviewSubjectAuthority> = {},
): PlanReviewSubjectAuthority {
  return {
    subjectDigest: SUBJECT,
    planVersion: 2,
    claimDeclarationsDigest: DIGEST_B,
    ...overrides,
  };
}

/** An old review iteration (v1) and the current revision's review (v2) of IDENTICAL content. */
function crossVersionState(): ReviewAssuranceState {
  return assurance([
    {
      obligationId: O1,
      obligationType: 'plan',
      subjectDigest: SUBJECT,
      status: 'consumed',
      iteration: 2,
      planVersion: 1,
      capturedVerdict: 'accept',
      invocationId: `${O1}-inv`,
      findingsHash: 'a'.repeat(64),
      claimDeclarationsDigest: DIGEST_A,
    },
    {
      obligationId: O2,
      obligationType: 'plan',
      subjectDigest: SUBJECT,
      status: 'consumed',
      iteration: 0,
      planVersion: 2,
      capturedVerdict: 'accept',
      invocationId: `${O2}-inv`,
      findingsHash: 'b'.repeat(64),
      claimDeclarationsDigest: DIGEST_B,
    },
  ]);
}

describe('resolvePlanReviewEvidence (version-tuple authority)', () => {
  it('prefers the current-version review over an older-version review of identical content', () => {
    const state = makeState('PLAN_REVIEW', {
      plan: {
        ...PLAN_RECORD,
        current: { ...PLAN_RECORD.current, planVersion: 2 },
        reviewCompletion: 'reviewer_accepted',
      },
      reviewAssurance: crossVersionState(),
    });

    expect(resolvePlanReviewEvidence(state, authority())?.obligationId).toBe(O2);
  });

  it('ignores old-version reviews even when the claim set is identical across versions', () => {
    // A == B: iteration-sorting alone would hand the v1 review the win. The
    // version tuple must exclude it regardless.
    const state = makeState('PLAN_REVIEW', {
      plan: {
        ...PLAN_RECORD,
        current: { ...PLAN_RECORD.current, planVersion: 2 },
        reviewCompletion: 'reviewer_accepted',
      },
      reviewAssurance: assurance([
        {
          obligationId: O1,
          obligationType: 'plan',
          subjectDigest: SUBJECT,
          status: 'consumed',
          iteration: 2,
          planVersion: 1,
          capturedVerdict: 'accept',
          invocationId: `${O1}-inv`,
          findingsHash: 'a'.repeat(64),
          claimDeclarationsDigest: DIGEST_A,
        },
        {
          obligationId: O2,
          obligationType: 'plan',
          subjectDigest: SUBJECT,
          status: 'consumed',
          iteration: 0,
          planVersion: 2,
          capturedVerdict: 'accept',
          invocationId: `${O2}-inv`,
          findingsHash: 'b'.repeat(64),
          claimDeclarationsDigest: DIGEST_A,
        },
      ]),
    });

    expect(
      resolvePlanReviewEvidence(state, authority({ claimDeclarationsDigest: DIGEST_A }))
        ?.obligationId,
    ).toBe(O2);
  });

  it('requires the claim digest of the current plan, not just subject and version', () => {
    const state = makeState('PLAN_REVIEW', {
      plan: {
        ...PLAN_RECORD,
        current: { ...PLAN_RECORD.current, planVersion: 2 },
        reviewCompletion: 'reviewer_accepted',
      },
      reviewAssurance: crossVersionState(),
    });

    expect(
      resolvePlanReviewEvidence(state, authority({ claimDeclarationsDigest: DIGEST_A })),
    ).toBeNull();
  });

  it('returns nothing when no review of the current version exists', () => {
    const state = makeState('PLAN_REVIEW', {
      plan: {
        ...PLAN_RECORD,
        current: { ...PLAN_RECORD.current, planVersion: 3 },
        reviewCompletion: 'reviewer_accepted',
      },
      reviewAssurance: crossVersionState(),
    });

    expect(
      resolvePlanReviewEvidence(
        state,
        authority({ planVersion: 3, claimDeclarationsDigest: DIGEST_A }),
      ),
    ).toBeNull();
  });
});

describe('resolveLatestPlanReviewEvidence (exhausted path)', () => {
  it('never lets an older-version review iteration win over the current version', () => {
    const state = makeState('PLAN_REVIEW', {
      plan: {
        ...PLAN_RECORD,
        current: { ...PLAN_RECORD.current, planVersion: 2 },
        reviewCompletion: 'review_exhausted',
      },
      reviewAssurance: crossVersionState(),
    });

    expect(resolveLatestPlanReviewEvidence(state, authority())?.obligationId).toBe(O2);
  });

  it('keeps subject divergence visible for the current version (gate diagnosis)', () => {
    const state = makeState('PLAN_REVIEW', {
      plan: {
        ...PLAN_RECORD,
        reviewCompletion: 'review_exhausted',
      },
      reviewAssurance: assurance([
        {
          obligationId: O1,
          obligationType: 'plan',
          subjectDigest: 'other-subject-digest',
          status: 'consumed',
          iteration: 0,
          planVersion: 1,
          capturedVerdict: 'changes_requested',
          invocationId: `${O1}-inv`,
          findingsHash: 'a'.repeat(64),
          claimDeclarationsDigest: DIGEST_A,
        },
      ]),
    });

    const resolved = resolveLatestPlanReviewEvidence(
      state,
      authority({ planVersion: 1, claimDeclarationsDigest: DIGEST_A }),
    );
    expect(resolved?.subjectDigest).toBe('other-subject-digest');
  });
});
