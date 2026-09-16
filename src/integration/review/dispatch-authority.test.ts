/**
 * @module integration/review/dispatch-authority.test
 * @description Unit tests for the canonical review dispatch authority. A
 * dispatch may only be projected with a pending current-generation obligation
 * and its exact bindable, unreleased attempt.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all categories present.
 */

import { describe, expect, it } from 'vitest';
import {
  resolveReviewDispatchAuthority,
  reviewObligationResponseFields,
} from './dispatch-authority.js';
import {
  ensureReviewAssurance,
  artifactReviewSubjectScope,
  createObligationAndAttempt,
} from './assurance.js';
import { appendReviewDispatch } from '../../state/review-dispatch.js';
import { REVIEW_CRITERIA_VERSION } from './assurance.js';
import type { ReviewAssuranceState } from '../../state/evidence.js';

const NOW = '2026-01-01T00:00:00.000Z';

function mint() {
  return createObligationAndAttempt(
    undefined,
    {
      policySnapshot: {
        challengePolicy: {
          version: 'challenge-policy.v1',
          counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
        },
        maxReviewerAttempts: 2,
      },
      obligationType: 'plan',
      reviewCycle: 1,
      repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
      iteration: 0,
      planVersion: 1,
      now: NOW,
      subjectDigest: 'subject-1',
      reviewMaterial: {
        content: 'frozen review material',
        materialDigest: 'a'.repeat(64),
        subjectDigest: 'subject-1',
      },
      reviewSubjectScope: artifactReviewSubjectScope('plan', '# Overview\nBody', 'subject-1'),
    },
    NOW,
  );
}

describe('resolveReviewDispatchAuthority', () => {
  describe('HAPPY', () => {
    it('resolves the pending obligation with its bindable attempt', () => {
      const minted = mint();
      const result = resolveReviewDispatchAuthority(
        minted.assurance,
        minted.obligation.obligationId,
      );

      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.authority.obligation.obligationId).toBe(minted.obligation.obligationId);
      expect(result.authority.attempt.attemptId).toBe(minted.attempt.attemptId);
    });

    it('projects the response fields with the exact attempt id', () => {
      const minted = mint();
      const result = resolveReviewDispatchAuthority(
        minted.assurance,
        minted.obligation.obligationId,
      );
      if (result.kind !== 'ok') throw new TypeError('expected ok authority');

      const fields = reviewObligationResponseFields(result.authority);
      expect(fields.reviewAttemptId).toBe(minted.attempt.attemptId);
      expect(fields.reviewObligation).toMatchObject({
        obligationId: minted.obligation.obligationId,
        obligationType: 'plan',
      });
    });
  });

  describe('BAD', () => {
    it('blocks when the obligation is not pending', () => {
      const minted = mint();
      const assurance: ReviewAssuranceState = {
        ...minted.assurance,
        obligations: minted.assurance.obligations.map((o) => ({
          ...o,
          status: 'fulfilled' as const,
        })),
      };
      const result = resolveReviewDispatchAuthority(assurance, minted.obligation.obligationId);
      expect(result).toMatchObject({ kind: 'blocked', code: 'REVIEW_ATTEMPT_UNAVAILABLE' });
    });

    it('blocks when no bindable attempt remains', () => {
      const minted = mint();
      const assurance: ReviewAssuranceState = {
        ...minted.assurance,
        attempts: minted.assurance.attempts.map((a) => ({
          ...a,
          status: 'bound' as const,
          childSessionId: 'ses_child_1',
        })),
      };
      const result = resolveReviewDispatchAuthority(assurance, minted.obligation.obligationId);
      expect(result).toMatchObject({ kind: 'blocked' });
      if (result.kind === 'blocked') expect(result.reason).toMatch(/no bindable reviewer attempt/);
    });

    it('blocks an attempt whose subject digest diverges from the obligation', () => {
      const minted = mint();
      const assurance: ReviewAssuranceState = {
        ...minted.assurance,
        attempts: minted.assurance.attempts.map((a) => ({ ...a, subjectDigest: 'other-subject' })),
      };
      const result = resolveReviewDispatchAuthority(assurance, minted.obligation.obligationId);
      expect(result).toMatchObject({ kind: 'blocked' });
      if (result.kind === 'blocked')
        expect(result.reason).toMatch(/not the exact bindable attempt/);
    });

    it('blocks an obligation from a stale review generation', () => {
      const minted = mint();
      const assurance: ReviewAssuranceState = {
        ...minted.assurance,
        obligations: minted.assurance.obligations.map((o) => ({
          ...o,
          criteriaVersion: 'stale-generation',
        })),
      };
      const result = resolveReviewDispatchAuthority(assurance, minted.obligation.obligationId);
      expect(result).toMatchObject({ kind: 'blocked' });
      if (result.kind === 'blocked') expect(result.reason).toMatch(/current review generation/);
    });

    it('blocks an attempt that was already released to the host', () => {
      const minted = mint();
      const released = appendReviewDispatch(minted.assurance, {
        dispatchId: '99999999-9999-4999-8999-999999999999',
        attemptId: minted.attempt.attemptId,
        obligationId: minted.obligation.obligationId,
        hostCallId: 'task-call-1',
        canonicalPromptDigest: 'b'.repeat(64),
        dispatchAuthorizedAt: NOW,
        dispatchStatus: 'authorized',
      });
      const result = resolveReviewDispatchAuthority(released, minted.obligation.obligationId);
      expect(result).toMatchObject({ kind: 'blocked' });
      if (result.kind === 'blocked') expect(result.reason).toMatch(/already released/);
    });
  });

  describe('CORNER', () => {
    it('blocks an unknown obligation id', () => {
      const minted = mint();
      const result = resolveReviewDispatchAuthority(
        minted.assurance,
        '00000000-0000-4000-8000-000000000000',
      );
      expect(result).toMatchObject({ kind: 'blocked' });
    });

    it('blocks an undefined assurance snapshot', () => {
      const result = resolveReviewDispatchAuthority(undefined, 'obligation-1');
      expect(result).toMatchObject({ kind: 'blocked' });
    });
  });

  describe('EDGE', () => {
    it('resolves only the requested obligation attempt pair', () => {
      const first = mint();
      const second = createObligationAndAttempt(
        first.assurance,
        {
          policySnapshot: {
            challengePolicy: {
              version: 'challenge-policy.v1',
              counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
            },
            maxReviewerAttempts: 2,
          },
          obligationType: 'plan',
          reviewCycle: 1,
          repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
          iteration: 1,
          planVersion: 2,
          now: NOW,
          subjectDigest: 'subject-2',
          reviewMaterial: {
            content: 'second review material',
            materialDigest: 'c'.repeat(64),
            subjectDigest: 'subject-2',
          },
          reviewSubjectScope: artifactReviewSubjectScope('plan', '# Overview\nBody', 'subject-2'),
        },
        NOW,
      );
      const assurance = ensureReviewAssurance(second.assurance);

      const resolved = resolveReviewDispatchAuthority(assurance, second.obligation.obligationId);
      expect(resolved.kind).toBe('ok');
      if (resolved.kind !== 'ok') return;
      expect(resolved.authority.attempt.attemptId).toBe(second.attempt.attemptId);
      expect(resolved.authority.attempt.attemptId).not.toBe(first.attempt.attemptId);
      expect(REVIEW_CRITERIA_VERSION).toBe(resolved.authority.obligation.criteriaVersion);
    });
  });
});
