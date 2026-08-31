import { describe, it, expect } from 'vitest';

import { makeState } from '../../../fixtures.js';
import { validateSubmittedReviewFindings } from './obligation.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from '../../review/assurance.js';
import type { ReviewObligation } from '../../../state/evidence-review.js';
import type { ReviewToolArgs } from './types.js';

// Findings B3/B5: standalone /review challenges must be obligation-scoped and
// bound to the canonical content evidence. Before wiring `allowedEvidenceRefs`
// and `expectedObligationId` on this path, a content challenge could cite a
// fabricated digest or a foreign obligation id and still pass.

const FINGERPRINT = 'content-fingerprint-abc';
const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';

function reviewObligation(): ReviewObligation {
  return {
    obligationId: OBLIGATION_ID,
    obligationType: 'review',
    subjectDigest: 'test-subject-digest',
    iteration: 0,
    planVersion: 1,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    mandateDigest: REVIEW_MANDATE_DIGEST,
    maxReviewerOutputRepairAttempts: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    pluginHandshakeAt: null,
    status: 'pending',
    invocationId: null,
    blockedCode: null,
    fulfilledAt: null,
    consumedAt: null,
    reviewSubjectScope: {
      kind: 'repository_change',
      paths: ['src/foo.ts'],
      revisions: ['base', 'head'],
    },
    requiredChallengeCount: 1,
    requiredChallengeKind: 'content_challenge' as const,
    challengePolicyVersion: 'challenge-policy.v1' as const,
    metadata: { fingerprint: FINGERPRINT },
  };
}

function contentChallenge(overrides: Record<string, unknown> = {}) {
  return {
    challengeId: '33333333-3333-4333-8333-333333333333',
    obligationId: OBLIGATION_ID,
    scenario: 'The endpoint is vulnerable to injection.',
    claim: 'User input reaches the SQL sink without parameterization.',
    locations: ['src/search.ts:20'],
    kind: 'content_challenge',
    evidenceRefs: [{ kind: 'content', digest: FINGERPRINT }],
    outcome: 'supported',
    ...overrides,
  };
}

function argsWith(challenge: Record<string, unknown>): ReviewToolArgs {
  return {
    reviewVerdict: 'accept',
    reviewFindings: {
      reviewMode: 'subagent',
      overallVerdict: 'accept',
      blockingIssues: [],
      challenges: [challenge],
    },
  } as unknown as ReviewToolArgs;
}

describe('validateSubmittedReviewFindings — content challenge binding (B3/B5)', () => {
  const state = makeState('REVIEW_COMPLETE');

  it('rejects a content challenge citing a fabricated (non-canonical) digest', () => {
    const result = validateSubmittedReviewFindings(
      state,
      argsWith(contentChallenge({ evidenceRefs: [{ kind: 'content', digest: 'FABRICATED' }] })),
      reviewObligation(),
    );
    expect(result).not.toBeNull();
    expect(result!).toContain('SUBAGENT_CHALLENGE_EVIDENCE_MISSING');
    expect(result!).toContain('evidence_mismatch');
  });

  it('rejects a content challenge carrying a foreign obligation id', () => {
    const result = validateSubmittedReviewFindings(
      state,
      argsWith(contentChallenge({ obligationId: '99999999-9999-4999-8999-999999999999' })),
      reviewObligation(),
    );
    expect(result).not.toBeNull();
    expect(result!).toContain('SUBAGENT_CHALLENGE_EVIDENCE_MISSING');
    expect(result!).toContain('obligation_mismatch');
  });

  it('does not block on the challenge check when the canonical content ref is cited', () => {
    // Downstream attestation may still block, but NOT with a challenge code —
    // proving the obligation-scoped, evidence-bound challenge was accepted.
    const result = validateSubmittedReviewFindings(
      state,
      argsWith(contentChallenge()),
      reviewObligation(),
    );
    if (result !== null) {
      expect(result).not.toContain('SUBAGENT_CHALLENGE_');
    }
  });

  it('rejects a standalone content challenge ID already persisted by an earlier standalone review', () => {
    const prior = argsWith(contentChallenge()).reviewFindings!;
    const result = validateSubmittedReviewFindings(
      { ...makeState('REVIEW_COMPLETE'), standaloneReviewFindings: [prior] },
      argsWith(contentChallenge()),
      reviewObligation(),
    );
    expect(result).toContain('SUBAGENT_CHALLENGE_NOT_DISTINCT');
    expect(result).toContain('historical_challenge_id_reused');
  });
});
