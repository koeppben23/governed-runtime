/** @module proofgraph-approval.test */

import { describe, expect, it } from 'vitest';
import {
  ArchitectureClaimDeclarations,
  FlowClaimDeclarations,
  PlanClaimDeclarations,
  ProofGraphApprovalCertificate,
  mintProofGraphClaimId,
  PlanClaimDeclarationInput,
  ArchitectureClaimDeclarationInput,
  normalizePlanClaimDeclaration,
  type PlanClaimDeclaration,
  type NormalizedPlanClaim,
} from './proofgraph-approval.js';
import { SessionState } from './schema.js';
import { makeState } from '../fixtures.js';
import { computeRecordDigest } from './evidence-plan.js';

const NOW = '2026-01-01T00:00:00.000Z';
const CERTIFICATE = {
  flow: 'plan' as const,
  authorityDigest: 'plan-digest',
  claimDeclarationsDigest: 'claims-digest',
  decisionAttestationDigest: 'decision-digest',
  approvedAt: NOW,
  approvedBy: 'user@example.test',
  certificateId: '00000000-0000-4000-8000-000000000001',
  planVersion: 1,
  planRecordDigest: 'record-digest',
  reviewObligationId: null,
  reviewEvidenceDigest: null,
};
const PLAN_CLAIM = {
  claimId: '00000000-0000-4000-8000-000000000002',
  statement: 'The change preserves the intended behavior.',
  critical: true,
  authoritySectionId: 'behavior',
  expectedCheckId: 'test',
};

const ARCHITECTURE_CLAIM = {
  claimId: '00000000-0000-4000-8000-000000000003',
  statement: 'The decision preserves the intended behavior.',
  critical: true,
  authoritySectionId: 'decision',
  requiredReviewEvidence: ['architecture-review'],
};

describe('ProofGraph approval schemas', () => {
  it('parses a digest-bound approval certificate', () => {
    expect(ProofGraphApprovalCertificate.parse(CERTIFICATE)).toEqual(CERTIFICATE);
  });

  it('rejects a certificate missing a required digest binding', () => {
    const { authorityDigest: _authorityDigest, ...missingAuthority } = CERTIFICATE;
    expect(() => ProofGraphApprovalCertificate.parse(missingAuthority)).toThrow();
  });

  it('parses plan and architecture pre-evidence declarations', () => {
    expect(PlanClaimDeclarations.parse({ flow: 'plan', claims: [PLAN_CLAIM] })).toEqual({
      flow: 'plan',
      claims: [PLAN_CLAIM],
    });
    expect(
      ArchitectureClaimDeclarations.parse({ flow: 'architecture', claims: [ARCHITECTURE_CLAIM] }),
    ).toEqual({ flow: 'architecture', claims: [ARCHITECTURE_CLAIM] });
  });

  it('rejects a declaration with a mismatched flow', () => {
    expect(() =>
      PlanClaimDeclarations.parse({ flow: 'architecture', claims: [PLAN_CLAIM] }),
    ).toThrow();
  });

  it('rejects plan declarations that contain evaluator evidence instead of an expected check', () => {
    expect(() =>
      PlanClaimDeclarations.parse({
        flow: 'plan',
        claims: [{ ...PLAN_CLAIM, expectedCheckId: undefined, evidenceRefs: [] }],
      }),
    ).toThrow();
  });

  it('requires architecture declarations to name their required review evidence', () => {
    expect(() =>
      ArchitectureClaimDeclarations.parse({
        flow: 'architecture',
        claims: [{ ...ARCHITECTURE_CLAIM, requiredReviewEvidence: undefined }],
      }),
    ).toThrow();
  });

  it('rejects implementation-specific semantics on architecture declarations', () => {
    expect(() =>
      ArchitectureClaimDeclarations.parse({
        flow: 'architecture',
        claims: [{ ...ARCHITECTURE_CLAIM, expectedCheckId: 'test' }],
      }),
    ).toThrow();
  });

  it('rejects a certificate attached to the wrong flow persistence slot', () => {
    expect(() =>
      SessionState.parse(
        makeState('PLAN_REVIEW', {
          plan: {
            current: {
              body: 'Plan',
              digest: 'plan-digest',
              sections: [],
              createdAt: NOW,
              recordDigest: computeRecordDigest({
                contentDigest: 'plan-digest',
                planVersion: 1,
                supersedesRecordDigest: null,
                originatingReviewObligationId: null,
                revisionReason: null,
              }),
              planVersion: 1,
              supersedesRecordDigest: null,
              originatingReviewObligationId: null,
              revisionReason: null,
              lineageStatus: 'verified' as const,
            },
            history: [],
            approvalCertificate: {
              ...CERTIFICATE,
              flow: 'architecture',
            } as unknown as typeof CERTIFICATE,
          },
        }),
      ),
    ).toThrow();
  });

  it('discriminates the plan and architecture declaration forms', () => {
    expect(FlowClaimDeclarations.parse({ flow: 'architecture', claims: [] }).flow).toBe(
      'architecture',
    );
  });

  it('persists plan declarations and certificates', () => {
    const state = SessionState.parse(
      makeState('PLAN_REVIEW', {
        plan: {
          current: {
            body: 'Plan',
            digest: 'plan-digest',
            sections: [],
            createdAt: NOW,
            recordDigest: computeRecordDigest({
              contentDigest: 'plan-digest',
              planVersion: 1,
              supersedesRecordDigest: null,
              originatingReviewObligationId: null,
              revisionReason: null,
            }),
            planVersion: 1,
            supersedesRecordDigest: null,
            originatingReviewObligationId: null,
            revisionReason: null,
            lineageStatus: 'verified' as const,
          },
          history: [],
          claimDeclarations: { flow: 'plan', claims: [PLAN_CLAIM] },
          approvalCertificate: CERTIFICATE,
        },
      }),
    );

    expect(state.plan?.approvalCertificate?.certificateId).toBe(CERTIFICATE.certificateId);
  });
});

describe('mintProofGraphClaimId', () => {
  it('produces a deterministic UUID for identical inputs', () => {
    const a = mintProofGraphClaimId({ flow: 'plan', statement: 'test', authoritySectionId: 's1' });
    const b = mintProofGraphClaimId({ flow: 'plan', statement: 'test', authoritySectionId: 's1' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('produces different IDs for different flows', () => {
    const plan = mintProofGraphClaimId({
      flow: 'plan',
      statement: 'test',
      authoritySectionId: 's1',
    });
    const arch = mintProofGraphClaimId({
      flow: 'architecture',
      statement: 'test',
      authoritySectionId: 's1',
    });
    expect(plan).not.toBe(arch);
  });

  it('produces different IDs for different authority sections', () => {
    const a = mintProofGraphClaimId({ flow: 'plan', statement: 'test', authoritySectionId: 's1' });
    const b = mintProofGraphClaimId({ flow: 'plan', statement: 'test', authoritySectionId: 's2' });
    expect(a).not.toBe(b);
  });

  it('normalises whitespace and casing in the statement', () => {
    const a = mintProofGraphClaimId({
      flow: 'plan',
      statement: '  The Change  Preserves Behavior.  ',
      authoritySectionId: 's1',
    });
    const b = mintProofGraphClaimId({
      flow: 'plan',
      statement: 'the change preserves behavior.',
      authoritySectionId: 's1',
    });
    expect(a).toBe(b);
  });
});

describe('PlanClaimDeclarationInput', () => {
  it('parses claims without a claimId', () => {
    const parsed = PlanClaimDeclarationInput.parse({
      statement: 'test',
      critical: true,
      authoritySectionId: 's1',
      expectedCheckId: 'build',
    });
    expect(parsed).toMatchObject({ statement: 'test', critical: true, authoritySectionId: 's1' });
  });

  it('rejects a caller-supplied claimId', () => {
    expect(() =>
      PlanClaimDeclarationInput.parse({
        claimId: '10000000-0000-4000-8000-000000000001',
        statement: 'test',
        critical: true,
        authoritySectionId: 's1',
        expectedCheckId: 'build',
      }),
    ).toThrow();
  });
});

describe('ArchitectureClaimDeclarationInput', () => {
  it('parses claims without a claimId', () => {
    const parsed = ArchitectureClaimDeclarationInput.parse({
      statement: 'test',
      critical: false,
      authoritySectionId: 's1',
      requiredReviewEvidence: ['evidence'],
    });
    expect(parsed).toMatchObject({
      statement: 'test',
      critical: false,
      authoritySectionId: 's1',
      requiredReviewEvidence: ['evidence'],
    });
  });

  it('rejects a user-supplied claimId', () => {
    expect(() =>
      ArchitectureClaimDeclarationInput.parse({
        claimId: '10000000-0000-4000-8000-000000000001',
        statement: 'test',
        critical: false,
        authoritySectionId: 's1',
        requiredReviewEvidence: ['evidence'],
      }),
    ).toThrow();
  });
});

describe('normalizePlanClaimDeclaration', () => {
  const BASE = {
    claimId: '00000000-0000-4000-8000-000000000001',
    statement: 'test',
    critical: true,
    authoritySectionId: 's1',
    expectedCheckId: 'test',
  } as const;

  it('preserves assertion requirement unchanged', () => {
    const input: PlanClaimDeclaration = {
      ...BASE,
      counterexampleRequirement: {
        mode: 'assertion' as const,
        checkId: 'security',
        assertionId: 'junit:com.example.Test#method',
      },
    };
    const result = normalizePlanClaimDeclaration(input);
    expect(result.counterexampleRequirement).toEqual({
      mode: 'assertion',
      checkId: 'security',
      assertionId: 'junit:com.example.Test#method',
    });
  });

  it('normalizes legacy counterexampleCheckId to mode=check', () => {
    const input: PlanClaimDeclaration = {
      ...BASE,
      counterexampleCheckId: 'security',
    } as PlanClaimDeclaration;
    const result = normalizePlanClaimDeclaration(input);
    expect(result.counterexampleRequirement).toEqual({
      mode: 'check',
      checkId: 'security',
    });
  });

  it('returns undefined for missing counterexample', () => {
    const input = { ...BASE } as PlanClaimDeclaration;
    const result = normalizePlanClaimDeclaration(input);
    expect(result.counterexampleRequirement).toBeUndefined();
  });

  it('does not include counterexampleCheckId in normalized result', () => {
    const input: PlanClaimDeclaration = {
      ...BASE,
      counterexampleCheckId: 'security',
    } as PlanClaimDeclaration;
    const result = normalizePlanClaimDeclaration(input) as Record<string, unknown>;
    expect(result['counterexampleCheckId']).toBeUndefined();
  });

  it('does not mutate the input object', () => {
    const input: PlanClaimDeclaration = {
      ...BASE,
      counterexampleCheckId: 'security',
    } as PlanClaimDeclaration;
    const original = { ...input };
    normalizePlanClaimDeclaration(input);
    expect(input).toEqual(original);
  });

  it('preserves all other claim fields unchanged', () => {
    const input: PlanClaimDeclaration = {
      ...BASE,
      counterexampleRequirement: {
        mode: 'assertion' as const,
        checkId: 'sec',
        assertionId: 'junit:x#y',
      },
      structuralSurface: 'command-registration',
      mutationProfile: 'all-killed',
    };
    const result = normalizePlanClaimDeclaration(input);
    expect(result.claimId).toBe(BASE.claimId);
    expect(result.statement).toBe(BASE.statement);
    expect(result.critical).toBe(BASE.critical);
    expect(result.authoritySectionId).toBe(BASE.authoritySectionId);
    expect(result.expectedCheckId).toBe(BASE.expectedCheckId);
    expect(result.structuralSurface).toBe('command-registration');
    expect(result.mutationProfile).toBe('all-killed');
  });
});
