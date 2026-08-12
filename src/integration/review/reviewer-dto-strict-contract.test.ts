/**
 * @module integration/review/reviewer-dto-strict-contract
 * @description Contract: the strict reviewer DTO boundary rejects unknown keys
 *              while the host's own normalization/challenge-contract builders
 *              still round-trip through the same canonical schema.
 */
import { describe, expect, it } from 'vitest';
import { ReviewFindings } from '../../state/evidence.js';
import { buildHostTaskChallengeContract } from './host-task-policy.js';
import { normalizeFindingsChallenges } from './enforcement/challenge-binding.js';
import { makeState } from '../../fixtures.js';
import { createReviewObligation } from './assurance.js';
import { CHALLENGE_POLICY_V1 } from '../../config/policy-types.js';

const OBLIGATION_ID = '00000000-0000-4000-8000-0000000000aa';
const NOW = '2026-01-01T00:00:00.000Z';

function planObligation(): ReturnType<typeof createReviewObligation> {
  return createReviewObligation({
    obligationType: 'plan',
    iteration: 1,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'plan-subject-digest',
    changedFiles: ['src/foo.ts'],
    policySnapshot: {
      challengePolicy: CHALLENGE_POLICY_V1,
      maxReviewerOutputRepairAttempts: 1,
    },
  });
}

function baseFindingsPayload() {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent' as const,
    overallVerdict: 'changes_requested' as const,
    blockingIssues: [],
    majorRisks: [
      {
        severity: 'major' as const,
        category: 'correctness' as const,
        message: 'Unhandled failure mode.',
        relation: {
          subjectAnchors: [
            {
              kind: 'repository_location' as const,
              location: { path: 'src/foo.ts', revision: 'head' as const, line: 12 },
            },
          ],
          evidenceLocations: [{ path: 'src/bar.ts', revision: 'base' as const, line: 4 }],
        },
      },
    ],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_reviewer' },
    reviewedAt: NOW,
    attestation: {
      toolObligationId: OBLIGATION_ID,
      mandateDigest: 'mandate-digest',
      criteriaVersion: 'p40-v1',
      iteration: 0,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer' as const,
    },
  };
}

describe('reviewer DTO strict boundary', () => {
  it('rejects an unknown key inside an evidenceLocation', () => {
    const payload = baseFindingsPayload();
    (payload.majorRisks[0]!.relation.evidenceLocations[0] as Record<string, unknown>).reviewedBy = {
      sessionId: 'ses_reviewer',
    };
    expect(ReviewFindings.safeParse(payload).success).toBe(false);
  });

  it('rejects an unknown key inside a subject anchor', () => {
    const payload = baseFindingsPayload();
    (payload.majorRisks[0]!.relation.subjectAnchors[0] as Record<string, unknown>).provenance =
      'trust-me';
    expect(ReviewFindings.safeParse(payload).success).toBe(false);
  });

  it('rejects an unknown key inside a finding', () => {
    const payload = baseFindingsPayload();
    (payload.majorRisks[0] as Record<string, unknown>).location = 'legacy/path.ts:12';
    expect(ReviewFindings.safeParse(payload).success).toBe(false);
  });

  it('rejects an unknown key inside the attestation', () => {
    const payload = baseFindingsPayload();
    (payload.attestation as Record<string, unknown>).signedBy = 'someone';
    expect(ReviewFindings.safeParse(payload).success).toBe(false);
  });

  it('rejects an unknown key inside reviewedBy', () => {
    const payload = baseFindingsPayload();
    (payload.reviewedBy as Record<string, unknown>).displayName = 'Reviewer';
    expect(ReviewFindings.safeParse(payload).success).toBe(false);
  });

  it('rejects an unknown key inside a challenge evidence ref', () => {
    const payload = {
      ...baseFindingsPayload(),
      challenges: [
        {
          clientReference: 'c1',
          obligationId: OBLIGATION_ID,
          scenario: 'Falsify the claim.',
          claim: 'The claim under test.',
          locations: ['src/foo.ts'],
          kind: 'content_challenge' as const,
          evidenceRefs: [{ kind: 'content', digest: 'a'.repeat(64), cacheKey: 'x' }],
          outcome: 'supported' as const,
        },
      ],
    };
    expect(ReviewFindings.safeParse(payload).success).toBe(false);
  });

  it('rejects an unknown key inside a challengeResolutionVerdict', () => {
    const payload = {
      ...baseFindingsPayload(),
      challengeResolutionVerdicts: [
        {
          challengeId: '00000000-0000-4000-8000-0000000000cc',
          verdict: 'resolved' as const,
          confidence: 'high',
        },
      ],
    };
    expect(ReviewFindings.safeParse(payload).success).toBe(false);
  });

  it('host challenge-contract refs and normalization round-trip through the strict schema', () => {
    const state = makeState('READY', {
      plan: {
        current: {
          digest: 'plan-digest',
          body: '## Plan\n\nSection body text.\n\n## Execution\n\nMore text.',
          sections: ['## Plan', '## Execution'],
          createdAt: NOW,
          recordDigest: 'plan-record-digest',
          planVersion: 1,
          supersedesRecordDigest: null,
          originatingReviewObligationId: null,
          revisionReason: null,
          lineageStatus: 'unavailable',
        },
        history: [],
      },
    });
    const obligation = { ...planObligation(), obligationId: OBLIGATION_ID };
    const contract = buildHostTaskChallengeContract(state, obligation);
    expect(contract?.evidenceRefs?.length).toBeGreaterThan(0);

    const findings = {
      ...baseFindingsPayload(),
      challenges: [
        {
          clientReference: 'c1',
          obligationId: OBLIGATION_ID,
          scenario: 'Falsify the claim.',
          claim: 'The claim under test.',
          locations: ['src/foo.ts'],
          kind: 'design_challenge' as const,
          evidenceRefs: contract!.evidenceRefs!.map((ref) => ({
            ...(ref as Record<string, unknown>),
            challengeId: 'reviewer-minted', // must be discarded by normalization
          })),
          outcome: 'supported' as const,
        },
      ],
    };

    const normalized = normalizeFindingsChallenges(
      findings as unknown as Record<string, unknown>,
      OBLIGATION_ID,
      'ses_child',
      contract?.evidenceRefs,
    );
    if ('bindOutcome' in normalized) {
      throw new Error(`host normalization failed: ${normalized.bindOutcome}`);
    }
    const parsed = ReviewFindings.safeParse(normalized.findings);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    const challenge = parsed.data.challenges![0]!;
    expect(challenge.challengeId).not.toBe('reviewer-minted');
    expect(challenge.evidenceRefs.length).toBe(contract!.evidenceRefs!.length);
  });
});
