import { describe, it, expect } from 'vitest';

import { makeState } from '../../../fixtures.js';
import { validateSubmittedReviewFindings } from './obligation.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from '../../review/assurance.js';
import type { ReviewObligation } from '../../../state/evidence-review.js';
import type { ReviewFindings } from '../../../state/evidence.js';

// Findings B3/B5: standalone /review challenges must be obligation-scoped and
// bound to the canonical content evidence. Before wiring `allowedEvidenceRefs`
// and `expectedObligationId` on this path, a content challenge could cite a
// fabricated digest or a foreign obligation id and still pass.

const WORKSPACE_FINGERPRINT = 'content-fingerprint-abc';
const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const SUBJECT_DIGEST = 'test-subject-digest';
const BASE_SHA = 'b'.repeat(40);
const HEAD_SHA = 'c'.repeat(40);

function reviewObligation(): ReviewObligation {
  return {
    obligationId: OBLIGATION_ID,
    obligationType: 'review',
    subjectDigest: SUBJECT_DIGEST,
    iteration: 0,
    planVersion: 1,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    mandateDigest: REVIEW_MANDATE_DIGEST,
    maxReviewerAttempts: 1,
    reviewProfile: 'core',
    profileSource: 'policy_default',
    reviewSubject: {
      kind: 'repository_change',
      source: { kind: 'branch', branch: 'feat/review' },
      baseRepository: { host: 'github.com', owner: 'upstream', name: 'repo' },
      headRepository: { host: 'github.com', owner: 'upstream', name: 'repo' },
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      changedPaths: ['src/foo.ts'],
      materialDigest: 'd'.repeat(64),
      subjectDigest: SUBJECT_DIGEST,
    },
    reviewMaterial: {
      content: 'frozen review material',
      materialDigest: 'a'.repeat(64),
      subjectDigest: SUBJECT_DIGEST,
    },
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
    metadata: { fingerprint: WORKSPACE_FINGERPRINT },
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
    evidenceRefs: [{ kind: 'content', digest: SUBJECT_DIGEST }],
    outcome: 'supported',
    ...overrides,
  };
}

function findingsWith(challenge: Record<string, unknown>): ReviewFindings {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [challenge],
    reviewedBy: { sessionId: 'reviewer' },
    reviewedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as ReviewFindings;
}

describe('validateSubmittedReviewFindings — content challenge binding (B3/B5)', () => {
  const state = makeState('REVIEW_COMPLETE');

  it('rejects a content challenge citing a fabricated (non-canonical) digest', () => {
    const result = validateSubmittedReviewFindings(
      state,
      findingsWith(contentChallenge({ evidenceRefs: [{ kind: 'content', digest: 'FABRICATED' }] })),
      reviewObligation(),
    );
    expect(result).not.toBeNull();
    expect(result!).toContain('SUBAGENT_CHALLENGE_EVIDENCE_MISSING');
    expect(result!).toContain('evidence_mismatch');
  });

  it('rejects a content challenge bound to the workspace fingerprint instead of the frozen subject digest', () => {
    const result = validateSubmittedReviewFindings(
      state,
      findingsWith(
        contentChallenge({
          evidenceRefs: [{ kind: 'content', digest: WORKSPACE_FINGERPRINT }],
        }),
      ),
      reviewObligation(),
    );
    expect(result).not.toBeNull();
    expect(result!).toContain('SUBAGENT_CHALLENGE_EVIDENCE_MISSING');
    expect(result!).toContain('evidence_mismatch');
  });

  it('rejects a content challenge carrying a foreign obligation id', () => {
    const result = validateSubmittedReviewFindings(
      state,
      findingsWith(contentChallenge({ obligationId: '99999999-9999-4999-8999-999999999999' })),
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
      findingsWith(contentChallenge()),
      reviewObligation(),
    );
    if (result !== null) {
      expect(result).not.toContain('SUBAGENT_CHALLENGE_');
    }
  });

  it('rejects a standalone content challenge ID already persisted by an earlier standalone review', () => {
    const prior = findingsWith(contentChallenge());
    const result = validateSubmittedReviewFindings(
      { ...makeState('REVIEW_COMPLETE'), standaloneReviewFindings: [prior] },
      findingsWith(contentChallenge()),
      reviewObligation(),
    );
    expect(result).toContain('SUBAGENT_CHALLENGE_NOT_DISTINCT');
    expect(result).toContain('historical_challenge_id_reused');
  });
});
