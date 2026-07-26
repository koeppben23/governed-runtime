/**
 * @module integration/review/challenge-policy-evaluation.test
 * @description Controlled #747 fixture comparison for frozen challenge requirements.
 */

import { describe, expect, it } from 'vitest';
import { CHALLENGE_POLICY_V1 } from '../../config/policy-types.js';
import { createReviewObligation } from './assurance.js';
import { validateChallengeConsistency } from './enforcement/findings-consistency.js';

type Fixture = {
  readonly name: string;
  readonly changedFiles: readonly string[];
  readonly shouldBlock: boolean;
  readonly challenges: readonly {
    readonly kind: string;
    readonly evidenceRefs?: readonly unknown[];
    readonly outcome?: string;
  }[];
  /** Fixed fixture metadata, not a wall-clock measurement. */
  readonly reviewerLatencyMs: number;
};

type Metrics = {
  readonly recall: number;
  readonly precision: number | null;
  readonly blockingRate: number;
  readonly reReviewRate: number;
  readonly reviewerLatencyMs: number;
};

const IMPLEMENTATION_EVIDENCE = [{ kind: 'implementation' }];

const FIXTURES: readonly Fixture[] = [
  {
    name: 'standard-missing-challenge',
    changedFiles: ['src/example.ts'],
    shouldBlock: true,
    challenges: [],
    reviewerLatencyMs: 120,
  },
  {
    name: 'standard-wrong-challenge-kind',
    changedFiles: ['src/example.ts'],
    shouldBlock: true,
    challenges: [
      { kind: 'design_challenge', evidenceRefs: IMPLEMENTATION_EVIDENCE, outcome: 'pass' },
    ],
    reviewerLatencyMs: 180,
  },
  {
    name: 'standard-missing-evidence',
    changedFiles: ['src/example.ts'],
    shouldBlock: true,
    challenges: [{ kind: 'implementation_challenge', evidenceRefs: [], outcome: 'pass' }],
    reviewerLatencyMs: 240,
  },
  {
    name: 'standard-unverified-implementation',
    changedFiles: ['src/example.ts'],
    shouldBlock: true,
    challenges: [
      {
        kind: 'implementation_challenge',
        evidenceRefs: IMPLEMENTATION_EVIDENCE,
        outcome: 'not_verified',
      },
    ],
    reviewerLatencyMs: 300,
  },
  {
    name: 'standard-valid-implementation',
    changedFiles: ['src/example.ts'],
    shouldBlock: false,
    challenges: [
      { kind: 'implementation_challenge', evidenceRefs: IMPLEMENTATION_EVIDENCE, outcome: 'pass' },
    ],
    reviewerLatencyMs: 360,
  },
  {
    name: 'high-risk-valid-two-implementations',
    changedFiles: ['src/state/schema.ts'],
    shouldBlock: false,
    challenges: [
      { kind: 'implementation_challenge', evidenceRefs: IMPLEMENTATION_EVIDENCE, outcome: 'pass' },
      { kind: 'implementation_challenge', evidenceRefs: IMPLEMENTATION_EVIDENCE, outcome: 'pass' },
    ],
    reviewerLatencyMs: 420,
  },
];

function evaluateFixtures(freezeRequirements: boolean): Metrics {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let blocked = 0;
  let reReviews = 0;
  let totalLatency = 0;

  for (const fixture of FIXTURES) {
    const obligation = createReviewObligation({
      obligationType: 'implement',
      iteration: 0,
      planVersion: 1,
      now: '2026-01-01T00:00:00.000Z',
      changedFiles: fixture.changedFiles,
      policySnapshot: freezeRequirements ? { challengePolicy: CHALLENGE_POLICY_V1 } : {},
    });
    const isBlocked =
      obligation.requiredChallengeCount !== undefined && obligation.requiredChallengeKind
        ? !validateChallengeConsistency({
            requiredChallengeCount: obligation.requiredChallengeCount,
            requiredChallengeKind: obligation.requiredChallengeKind,
            challenges: fixture.challenges,
          }).ok
        : false;

    totalLatency += fixture.reviewerLatencyMs;
    if (isBlocked) {
      blocked++;
      reReviews++;
    }
    if (isBlocked && fixture.shouldBlock) truePositives++;
    if (isBlocked && !fixture.shouldBlock) falsePositives++;
    if (!isBlocked && fixture.shouldBlock) falseNegatives++;
  }

  return {
    recall: truePositives / (truePositives + falseNegatives),
    precision:
      truePositives + falsePositives === 0
        ? null
        : truePositives / (truePositives + falsePositives),
    blockingRate: blocked / FIXTURES.length,
    reReviewRate: reReviews / FIXTURES.length,
    reviewerLatencyMs: totalLatency / FIXTURES.length,
  };
}

describe('controlled challenge-policy fixture evaluation (#747)', () => {
  it('reports matched deterministic fixture metrics with and without frozen requirements', () => {
    const withoutFrozenRequirements = evaluateFixtures(false);
    const withFrozenRequirements = evaluateFixtures(true);

    expect(withoutFrozenRequirements).toEqual({
      recall: 0,
      precision: null,
      blockingRate: 0,
      reReviewRate: 0,
      reviewerLatencyMs: 270,
    });
    expect(withFrozenRequirements).toEqual({
      recall: 1,
      precision: 1,
      blockingRate: 4 / 6,
      reReviewRate: 4 / 6,
      reviewerLatencyMs: 270,
    });
  });
});
