/**
 * @module integration/tools/review-tool/review-attempt-lifecycle.test
 * @description Contract: review attempt lifecycle authority boundary.
 *
 * Verifies that:
 * - The canonical subject digest is stable across retries for the same resolved
 *   branch revision.
 * - Append-only evidence deduplication works when the task digest is identical.
 * - A difference in resolved SHAs correctly produces a different digest
 *   (new revision = new subject).
 */

import { describe, it, expect } from 'vitest';
import { appendPreparedReviewEvidence, prepareStandaloneReviewEvidence } from './preparation.js';
import type { StandaloneReviewPreparedEvidence } from '../../../state/standalone-review.js';
import type { ReviewReferenceInput } from '../../../rails/review.js';
import { populateRefInput } from './continuation.js';
import { makeState } from '../../../fixtures.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from '../../review/assurance.js';

function evidence(args: {
  readonly branch?: string;
  readonly base?: string;
  readonly refInput?: ReviewReferenceInput;
}): StandaloneReviewPreparedEvidence {
  return prepareStandaloneReviewEvidence(
    {
      branch: args.branch,
      base: args.base,
    },
    '2026-08-09T00:00:00.000Z',
    args.refInput,
    REVIEW_TASK_ID,
    OBLIGATION_ID,
  );
}

const OBLIGATION_ID = '00000000-0000-4000-8000-00000000000a';
const REVIEW_TASK_ID = '00000000-0000-4000-8000-00000000000b';

describe('subject digest stability', () => {
  const branch = 'feature/add-due-date';
  const base = 'main';
  const revSha = '8c7892607926fd505fb592708e0f96ba736832dc';
  const baseSha = '0fb93de017de5e283a1f7cd66774f03a2563aa94';

  it('differs when resolvedBranchSha is present vs absent', () => {
    const a = evidence({
      branch,
      base,
      refInput: { resolvedBranchSha: revSha, resolvedBaseSha: baseSha, baseBranch: base },
    });
    const b = evidence({
      branch,
      base,
      refInput: { baseBranch: base },
    });

    // Current behaviour: digest differs because resolved SHAs change the
    // canonical subject identity (a branch name is mutable).
    expect(a.requestedDigests.taskDigest).not.toBe(b.requestedDigests.taskDigest);
  });

  it('matches when the same resolved SHAs are supplied', () => {
    const a = evidence({
      branch,
      base,
      refInput: { resolvedBranchSha: revSha, resolvedBaseSha: baseSha, baseBranch: base },
    });
    const b = evidence({
      branch,
      base,
      refInput: { resolvedBranchSha: revSha, resolvedBaseSha: baseSha, baseBranch: base },
    });

    expect(a.requestedDigests.taskDigest).toBe(b.requestedDigests.taskDigest);
  });

  it('differs for genuinely different revisions', () => {
    const a = evidence({
      branch,
      base,
      refInput: {
        resolvedBranchSha: 'a'.repeat(40),
        resolvedBaseSha: baseSha,
        baseBranch: base,
      },
    });
    const b = evidence({
      branch,
      base,
      refInput: {
        resolvedBranchSha: 'b'.repeat(40),
        resolvedBaseSha: baseSha,
        baseBranch: base,
      },
    });

    expect(a.requestedDigests.taskDigest).not.toBe(b.requestedDigests.taskDigest);
  });

  it('rehydrates resolved SHAs from the verdict obligation when no source is available', () => {
    const obligationId = '33333333-1111-4111-8111-111111111111';
    const state = makeState('REVIEW', {
      reviewAssurance: {
        assuranceSchemaVersion: 'review-assurance.v6' as const,
        obligations: [
          {
            obligationId,
            obligationType: 'review',
            requiredChallengeCount: 0,
            requiredChallengeKind: 'content_challenge',
            challengePolicyVersion: 'challenge-policy.v1',
            iteration: 0,
            planVersion: 1,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            mandateDigest: REVIEW_MANDATE_DIGEST,
            maxReviewerOutputRepairAttempts: 1,
            createdAt: '2026-08-09T00:00:00.000Z',
            pluginHandshakeAt: null,
            status: 'pending',
            invocationId: null,
            blockedCode: null,
            fulfilledAt: null,
            consumedAt: null,
            subjectDigest: 'review-subject',
            reviewSubjectScope: {
              kind: 'repository_change',
              paths: ['src/foo.ts'],
              revisions: ['base', 'head'],
            },
            metadata: { resolvedBranchSha: revSha, resolvedBaseSha: baseSha },
          },
        ],
        invocations: [],
        attempts: [],
        dispatches: [],
      },
    });

    expect(
      populateRefInput({ branch, base, reviewObligationId: obligationId }, state, undefined),
    ).toMatchObject({
      resolvedBranchSha: revSha,
      resolvedBaseSha: baseSha,
    });
  });
});

describe('appendPreparedReviewEvidence dedup', () => {
  it('does not append a second entry when taskDigest matches', () => {
    const first = evidence({
      branch: 'feat/x',
      base: 'main',
      refInput: {
        resolvedBranchSha: 'c'.repeat(40),
        resolvedBaseSha: 'd'.repeat(40),
        baseBranch: 'main',
      },
    });
    const second = evidence({
      branch: 'feat/x',
      base: 'main',
      refInput: {
        resolvedBranchSha: 'c'.repeat(40),
        resolvedBaseSha: 'd'.repeat(40),
        baseBranch: 'main',
      },
    });

    const afterOne = appendPreparedReviewEvidence([], first);
    expect(afterOne).toHaveLength(1);

    const afterTwo = appendPreparedReviewEvidence(afterOne, second);
    expect(afterTwo).toHaveLength(1);
  });

  it('appends when taskDigest differs', () => {
    const first = evidence({
      branch: 'feat/x',
      base: 'main',
      refInput: {
        resolvedBranchSha: 'e'.repeat(40),
        resolvedBaseSha: 'f'.repeat(40),
        baseBranch: 'main',
      },
    });
    const second = evidence({
      branch: 'feat/x',
      base: 'main',
      refInput: {
        resolvedBranchSha: 'g'.repeat(40),
        resolvedBaseSha: 'f'.repeat(40),
        baseBranch: 'main',
      },
    });

    const afterOne = appendPreparedReviewEvidence([], first);
    const afterTwo = appendPreparedReviewEvidence(afterOne, second);
    // New lifecycle: the stale incarnation stays for audit and is structurally
    // superseded by an explicit marker instead of being silently dropped.
    expect(afterTwo).toHaveLength(3);
    expect(afterTwo[1]).toMatchObject({
      kind: 'superseded',
      supersededPreparedEvidenceId: first.evidenceId,
      replacementPreparedEvidenceId: second.evidenceId,
      reason: 'subject_frozen',
      reviewTaskId: first.reviewTaskId,
    });
    expect(afterTwo[2]).toBe(second);
  });
});
