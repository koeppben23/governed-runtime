/** @module proofgraph-approval.test */

import { describe, expect, it } from 'vitest';
import {
  ArchitectureClaimDeclarations,
  FlowClaimDeclarations,
  PlanClaimDeclarations,
  ProofGraphApprovalCertificate,
} from './proofgraph-approval.js';
import { SessionState } from './schema.js';
import { makeState } from '../fixtures.js';

const NOW = '2026-01-01T00:00:00.000Z';
const CERTIFICATE = {
  flow: 'plan' as const,
  authorityDigest: 'plan-digest',
  claimDeclarationsDigest: 'claims-digest',
  decisionAttestationDigest: 'decision-digest',
  approvedAt: NOW,
  approvedBy: 'user@example.test',
  certificateId: '00000000-0000-4000-8000-000000000001',
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

  it('rejects a certificate attached to the wrong flow persistence slot', () => {
    expect(() =>
      SessionState.parse(
        makeState('PLAN_REVIEW', {
          plan: {
            current: { body: 'Plan', digest: 'plan-digest', sections: [], createdAt: NOW },
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
          current: { body: 'Plan', digest: 'plan-digest', sections: [], createdAt: NOW },
          history: [],
          claimDeclarations: { flow: 'plan', claims: [PLAN_CLAIM] },
          approvalCertificate: CERTIFICATE,
        },
      }),
    );

    expect(state.plan?.approvalCertificate?.certificateId).toBe(CERTIFICATE.certificateId);
  });
});
