/**
 * @module obligation-settlement.test
 * @description Settlement contract: after an attempt rejection, a pending
 *              review obligation must have exactly one legal continuation
 *              (bindable attempt, authorized output repair, or bound evidence);
 *              otherwise it is deterministically blocked instead of staying
 *              pending.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, expect, it } from 'vitest';
import { settleReviewObligationAfterAttempt } from './obligation-settlement.js';
import {
  artifactReviewSubjectScope,
  createReviewAttempt,
  createReviewObligation,
  ensureReviewAssurance,
  freezeReviewMaterial,
  updateAttemptStatus,
} from './assurance.js';
import type { ReviewAttempt, ReviewObligation } from '../../state/evidence.js';
import type { SessionState } from '../../state/schema.js';

const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T00:01:00.000Z';

function planObligation(): ReviewObligation {
  return createReviewObligation({
    obligationType: 'plan',
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'plan-digest',
    reviewMaterial: freezeReviewMaterial('# Plan\nBody', 'plan-digest'),
    reviewSubjectScope: artifactReviewSubjectScope('plan', '# Plan\nBody', 'plan-digest'),
    changedFiles: ['src/a.ts'],
    policySnapshot: {
      challengePolicy: {
        version: 'challenge-policy.v1',
        counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
      },
      maxReviewerOutputRepairAttempts: 1,
    },
  });
}

function stateWith(obligation: ReviewObligation, attempts: ReviewAttempt[] = []): SessionState {
  return {
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v5' as const,
      obligations: [obligation],
      invocations: [],
      attempts,
    },
  } as unknown as SessionState;
}

function attemptFor(
  obligation: ReviewObligation,
  ordinal: number,
  status: ReviewAttempt['status'],
  rejectionReason?: ReviewAttempt['rejectionReason'],
): ReviewAttempt {
  const base = createReviewAttempt({
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    subjectDigest: obligation.subjectDigest,
    reviewMaterial: obligation.reviewMaterial,
    ordinal,
    origin: { kind: 'initial' },
    repositoryDiscovery: { kind: 'not_applicable' },
    now: NOW,
  });
  if (status === 'created') return base;
  const assurance = updateAttemptStatus(
    ensureReviewAssurance({
      assuranceSchemaVersion: 'review-assurance.v5' as const,
      obligations: [obligation],
      invocations: [],
      attempts: [base],
    }),
    base.attemptId,
    status,
    LATER,
    rejectionReason ? { rejectionReason } : undefined,
  );
  return assurance.attempts.find((a) => a.attemptId === base.attemptId)!;
}

function findObligation(state: SessionState, obligationId: string): ReviewObligation | null {
  return (
    ensureReviewAssurance(state.reviewAssurance).obligations.find(
      (o) => o.obligationId === obligationId,
    ) ?? null
  );
}

describe('settleReviewObligationAfterAttempt', () => {
  it('keeps a pending obligation with a bindable attempt', () => {
    const obligation = planObligation();
    const attempt = attemptFor(obligation, 1, 'created');
    const state = stateWith(obligation, [attempt]);

    const settled = settleReviewObligationAfterAttempt(state, obligation.obligationId);
    expect(findObligation(settled, obligation.obligationId)?.status).toBe('pending');
  });

  it('keeps a pending obligation with a canonically repairable rejection (fresh output may repair)', () => {
    const obligation = planObligation();
    const rejected = attemptFor(obligation, 1, 'rejected', 'schema_invalid');
    const state = stateWith(obligation, [rejected]);

    const settled = settleReviewObligationAfterAttempt(state, obligation.obligationId);
    expect(findObligation(settled, obligation.obligationId)?.status).toBe('pending');
  });

  it('blocks the obligation on a non-repairable scope rejection', () => {
    const obligation = planObligation();
    const rejected = attemptFor(obligation, 1, 'rejected', 'scope_invalid');
    const state = stateWith(obligation, [rejected]);

    const settled = settleReviewObligationAfterAttempt(state, obligation.obligationId);
    const settledObligation = findObligation(settled, obligation.obligationId);
    expect(settledObligation?.status).toBe('blocked');
    expect(settledObligation?.blockedCode).toBe('REVIEW_REPAIR_UNAVAILABLE');
  });

  it('blocks the obligation when the rejection carries no structured reason', () => {
    const obligation = planObligation();
    const rejected = attemptFor(obligation, 1, 'rejected');
    const state = stateWith(obligation, [rejected]);

    const settled = settleReviewObligationAfterAttempt(state, obligation.obligationId);
    expect(findObligation(settled, obligation.obligationId)?.status).toBe('blocked');
  });

  it('leaves fulfilled obligations untouched', () => {
    const obligation = planObligation();
    const fulfilled: ReviewObligation = { ...obligation, status: 'fulfilled', fulfilledAt: NOW };
    const state = stateWith(fulfilled, []);

    const settled = settleReviewObligationAfterAttempt(state, obligation.obligationId);
    expect(findObligation(settled, obligation.obligationId)?.status).toBe('fulfilled');
  });

  it('never settles when the frozen artifact material binding is broken (zero mutation)', () => {
    const obligation = planObligation();
    // Tampered material generation: subjectDigest no longer matches the artifact.
    const tampered: ReviewObligation = {
      ...obligation,
      reviewMaterial: { ...obligation.reviewMaterial!, subjectDigest: 'other-digest' },
    };
    const rejected = attemptFor(tampered, 1, 'rejected', 'schema_invalid');
    const state = stateWith(tampered, [rejected]);

    const settled = settleReviewObligationAfterAttempt(state, tampered.obligationId);
    const settledObligation = findObligation(settled, tampered.obligationId);
    expect(settledObligation?.status).toBe('pending');
    expect(settledObligation?.blockedCode).toBeNull();
  });

  it('invariant: every pending obligation keeps a legal continuation after settlement', () => {
    const obligation = planObligation();
    const bindable = attemptFor(obligation, 2, 'created');
    const rejected = attemptFor(obligation, 1, 'rejected', 'scope_invalid');

    for (const attempts of [[rejected], [bindable], [rejected, bindable]]) {
      const state = stateWith(obligation, attempts);
      const settled = settleReviewObligationAfterAttempt(state, obligation.obligationId);
      const assurance = ensureReviewAssurance(settled.reviewAssurance);
      for (const item of assurance.obligations) {
        if (item.status !== 'pending') continue;
        const hasBindable = assurance.attempts.some(
          (a) =>
            a.obligationId === item.obligationId && a.status === 'created' && !a.childSessionId,
        );
        expect(hasBindable).toBe(true);
      }
    }
  });
});
