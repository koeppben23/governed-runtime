/**
 * @file reviewer-contract.test.ts
 * @description Drift guard: the reviewer-facing projection values in
 * reviewer-contract.ts match the canonical model-output authority
 * `ReviewerFindingsInput` (src/state/evidence-review-input.ts).
 *
 * Model-side shapes are asserted against `ReviewerFindingsInput`, which is the
 * strict boundary the reviewer's structured output must satisfy. Host-enriched
 * shapes (`reviewedBy`, `reviewedAt`, host-minted `challengeId`, full
 * attestation) are asserted separately against the canonical `ReviewFindings`
 * record, which exists only after the host stamps provenance.
 */
import { describe, expect, it } from 'vitest';
import { ReviewFindings, ReviewerFindingsInput } from '../../state/evidence.js';
import {
  SEVERITY_VALUES,
  CATEGORY_VALUES,
  ANCHOR_KINDS,
  CHALLENGE_KINDS,
  OVERALL_VERDICT_VALUES,
} from './reviewer-contract.js';

const OBLIGATION_ID = '00000000-0000-4000-8000-000000000000';
const CHALLENGE_ID = '11111111-0000-4000-8000-000000000000';

// ─── Model-side payload builders (ReviewerFindingsInput) ─────────────────────

interface ModelPayloadOpts {
  severity?: string;
  category?: string;
  overallVerdict?: string;
  challenges?: unknown[];
}

function modelPayload(opts: ModelPayloadOpts = {}) {
  return {
    iteration: 1,
    planVersion: 1,
    reviewMode: 'subagent' as const,
    overallVerdict: opts.overallVerdict ?? ('changes_requested' as const),
    blockingIssues: [
      {
        severity: opts.severity ?? 'major',
        category: opts.category ?? 'completeness',
        message: 'Test',
        relation: {
          subjectAnchors: [
            { kind: 'repository_location', location: { path: 'src/f.ts', revision: 'head' } },
          ],
          evidenceLocations: [],
        },
      },
    ],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: opts.challenges ?? [],
    attestation: { toolObligationId: OBLIGATION_ID },
  };
}

function modelChallenge(kind: (typeof CHALLENGE_KINDS)[number]): Record<string, unknown> {
  const base = {
    obligationId: OBLIGATION_ID,
    clientReference: 'c1',
    scenario: 'Falsify the claim.',
    claim: 'The claim under test.',
    locations: ['src/f.ts'],
  };
  if (kind === 'design_challenge') {
    return {
      ...base,
      kind,
      evidenceRefs: [
        {
          kind: 'plan_adr_section',
          artifactKind: 'plan',
          artifactDigest: 'abc',
          sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Test' }],
          excerptDigest: 'abc',
        },
      ],
      outcome: 'supported',
    };
  }
  if (kind === 'implementation_challenge') {
    return {
      ...base,
      kind,
      evidenceRefs: [{ kind: 'implementation', implementationDigest: 'abc' }],
      outcome: 'not_verified',
    };
  }
  return {
    ...base,
    kind,
    evidenceRefs: [{ kind: 'content', digest: 'abc' }],
    outcome: 'supported',
  };
}

function modelAnchor(kind: (typeof ANCHOR_KINDS)[number]): Record<string, unknown> {
  if (kind === 'repository_location') {
    return { kind, location: { path: 'src/f.ts', revision: 'head' } };
  }
  if (kind === 'artifact_section') {
    return {
      kind,
      artifactKind: 'plan',
      artifactDigest: 'abc',
      sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Test' }],
    };
  }
  if (kind === 'content') return { kind, subjectDigest: 'abc' };
  return { kind, implementationDigest: 'abc' };
}

function withAnchor(anchor: Record<string, unknown>) {
  const payload = modelPayload();
  return {
    ...payload,
    blockingIssues: [
      {
        ...payload.blockingIssues[0]!,
        relation: { subjectAnchors: [anchor], evidenceLocations: [] },
      },
    ],
  };
}

// ─── Model-side contract (canonical ReviewerFindingsInput) ───────────────────

describe('reviewer-contract ↔ ReviewerFindingsInput (model-side authority)', () => {
  it('severities match canonical Finding.severity', () => {
    for (const severity of SEVERITY_VALUES) {
      const result = ReviewerFindingsInput.safeParse(modelPayload({ severity }));
      expect(result.success, `${severity} must be valid`).toBe(true);
    }

    expect([...SEVERITY_VALUES].sort()).toEqual(['critical', 'major', 'minor']);
  });

  it('categories match canonical Finding.category', () => {
    for (const category of CATEGORY_VALUES) {
      const result = ReviewerFindingsInput.safeParse(modelPayload({ category }));
      expect(result.success, `${category} must be valid`).toBe(true);
    }

    expect([...CATEGORY_VALUES].sort()).toEqual([
      'completeness',
      'correctness',
      'feasibility',
      'quality',
      'risk',
    ]);
  });

  it('anchor kinds match canonical ReviewSubjectAnchor', () => {
    for (const kind of ANCHOR_KINDS) {
      const result = ReviewerFindingsInput.safeParse(withAnchor(modelAnchor(kind)));
      expect(result.success, `${kind} must be a valid model anchor`).toBe(true);
    }

    // The projection list must match the canonical union exactly (order-stable).
    expect([...ANCHOR_KINDS].sort()).toEqual([
      'artifact_section',
      'content',
      'implementation',
      'repository_location',
    ]);
  });

  it('challenge kinds match canonical ReviewerChallengeInput', () => {
    for (const kind of CHALLENGE_KINDS) {
      const result = ReviewerFindingsInput.safeParse(
        modelPayload({ challenges: [modelChallenge(kind)] }),
      );
      expect(result.success, `${kind} must be a valid model challenge`).toBe(true);
    }

    expect([...CHALLENGE_KINDS].sort()).toEqual([
      'content_challenge',
      'design_challenge',
      'implementation_challenge',
    ]);
  });

  it('model-side challenges never carry a challengeId — the host mints it', () => {
    const withIdentity = {
      ...modelChallenge('design_challenge'),
      challengeId: CHALLENGE_ID,
    };
    const rejected = ReviewerFindingsInput.safeParse(modelPayload({ challenges: [withIdentity] }));
    expect(rejected.success).toBe(false);

    const parsed = ReviewerFindingsInput.safeParse(
      modelPayload({ challenges: [modelChallenge('design_challenge')] }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.challenges[0]).not.toHaveProperty('challengeId');
    expect(parsed.data.challenges[0]).toHaveProperty('clientReference', 'c1');
  });

  it('overall verdicts match canonical LoopVerdict', () => {
    for (const verdict of OVERALL_VERDICT_VALUES) {
      const result = ReviewerFindingsInput.safeParse(modelPayload({ overallVerdict: verdict }));
      expect(result.success, `${verdict} must be valid`).toBe(true);
    }

    expect([...OVERALL_VERDICT_VALUES].sort()).toEqual([
      'accept',
      'changes_requested',
      'unable_to_review',
    ]);
  });

  it('invalid severity "info" is rejected', () => {
    const result = ReviewerFindingsInput.safeParse(modelPayload({ severity: 'info' }));
    expect(result.success).toBe(false);
  });
});

// ─── Host-enriched record (canonical ReviewFindings) ─────────────────────────

function hostEnrichedPayload() {
  return {
    ...modelPayload(),
    blockingIssues: modelPayload().blockingIssues,
    reviewedBy: { sessionId: 'sess_abc123', actorAssurance: 'idp_verified' },
    reviewedAt: '2026-01-01T00:00:00Z',
    attestation: {
      mandateDigest: 'sha256:test',
      criteriaVersion: 'v1',
      toolObligationId: OBLIGATION_ID,
      iteration: 1,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
    },
  };
}

describe('host-enriched ReviewFindings record (post-boundary shape)', () => {
  it('host-stamped findings pass ReviewFindings', () => {
    expect(ReviewFindings.safeParse(hostEnrichedPayload()).success).toBe(true);
  });

  it('model-side output is not a canonical record until the host stamps provenance', () => {
    // reviewedBy/reviewedAt and the full attestation are host-owned; the raw
    // model payload is rejected by the canonical record schema.
    expect(ReviewFindings.safeParse(modelPayload()).success).toBe(false);

    const withHostChallenge = hostEnrichedPayload();
    withHostChallenge.challenges = [
      { ...modelChallenge('content_challenge'), challengeId: CHALLENGE_ID },
    ];
    expect(ReviewFindings.safeParse(withHostChallenge).success).toBe(true);
  });
});
