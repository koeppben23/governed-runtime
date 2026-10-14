/**
 * @module audit/proofgraph/enforcement-projection.test
 * @description Tests for governance/blocking proofgraph enforcement projection.
 */

import { describe, expect, it } from 'vitest';
import { computeProofGraphEnforcement } from './enforcement-projection.js';
import type { ProofGraphSummary } from './summary.js';
import type { AuthorizedClaimBinding } from '../../state/proofgraph-approval.js';
import type { ProofContract } from '../../state/proofgraph-contract.js';
import type { ProofClaim } from '../../state/proofgraph.js';
import { materializedClaimDigest } from '../../state/proofgraph-claim-certification.js';

/**
 * The canonical source contract a materializer would persist for the given
 * evaluated claims. Used only by this suite's `enforce()` wrapper so the
 * enforcement-logic cases stay focused; dedicated source-integrity cases pass
 * an explicit contract (or an empty one for an absent source).
 */
function declaredSource(claims: readonly ProofClaim[] | undefined): ProofContract {
  return {
    version: 'contract.v2',
    claims: (claims ?? []).map(
      ({ verificationState: _state, freshness: _freshness, ...rest }) => rest,
    ),
  };
}

type EnforceInput = Parameters<typeof computeProofGraphEnforcement>[0];
function enforce(input: Omit<EnforceInput, 'contract'> & { readonly contract?: ProofContract }) {
  return computeProofGraphEnforcement({
    ...input,
    ...(input.authorizedClaimBindings
      ? {
          authorizedClaimBindings: new Map(
            [...input.authorizedClaimBindings].map(([id, binding]) => [
              id,
              {
                ...binding,
                certifiedClaimDigest: materializedClaimDigest(
                  provenClaim({
                    claimId: id,
                    coversRiskTriggers: input.projection?.claims.find(
                      (claim) => claim.claimId === id,
                    )?.coversRiskTriggers,
                  }) as unknown as ProofClaim,
                )!,
              },
            ]),
          ),
        }
      : {}),
    contract: input.contract ?? declaredSource(input.projection?.claims),
  });
}

function summary(claims: unknown[] = []): {
  projection: ProofGraphSummary['projection'];
} {
  return {
    projection: {
      version: 'proofgraph.v2',
      claims: claims as never,
      evaluatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

/**
 * The certificate the fixture claims are bound to. Kept in one place so every
 * test that exercises authorization also supplies the matching expected
 * binding.
 */
const AUTHORIZED_BINDING: AuthorizedClaimBinding = {
  authorityId: 'auth-1',
  authorityDigest: 'a'.repeat(64),
  certificateId: '00000000-0000-4000-8000-000000000001',
  claimDeclarationsDigest: 'a'.repeat(64),
  decisionAttestationDigest: 'b'.repeat(64),
  declarationId: '00000000-0000-4000-8000-000000000002',
  certifiedClaimDigest: 'c'.repeat(64),
};

const AUTHORIZED_BINDINGS = new Map([
  ['c1', AUTHORIZED_BINDING],
  ['c2', AUTHORIZED_BINDING],
]);

function provenClaim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const value = {
    claimId: 'c1',
    statement: 'System satisfies constraint X',
    critical: true,
    signalClass: 'fact',
    provenance: {
      kind: 'canonical_authority',
      authorityId: 'auth-1',
      digest: 'a'.repeat(64),
      approval: {
        certificateId: '00000000-0000-4000-8000-000000000001',
        claimDeclarationsDigest: 'a'.repeat(64),
        decisionAttestationDigest: 'b'.repeat(64),
        declarationId: '00000000-0000-4000-8000-000000000002',
      },
    },
    verificationState: 'PROVEN',
    evidenceRefs: [],
    counterexampleRefs: [],
    certifiedPlan: { authoritySectionId: 's1', expectedCheckId: 'test', digest: 'c'.repeat(64) },
    ...overrides,
  };
  value.certifiedPlan.digest =
    materializedClaimDigest(value as unknown as ProofClaim) ?? 'c'.repeat(64);
  return value;
}

/** Claim whose provenance is built from AUTHORIZED_BINDING with one field overridden. */
function claimWithBinding(overrides: Partial<AuthorizedClaimBinding>): Record<string, unknown> {
  const binding = { ...AUTHORIZED_BINDING, ...overrides };
  return provenClaim({
    provenance: {
      kind: 'canonical_authority',
      authorityId: binding.authorityId,
      digest: binding.authorityDigest,
      approval: {
        certificateId: binding.certificateId,
        claimDeclarationsDigest: binding.claimDeclarationsDigest,
        decisionAttestationDigest: binding.decisionAttestationDigest,
        declarationId: binding.declarationId,
      },
    },
  });
}

describe('computeProofGraphEnforcement', () => {
  it.each([
    { critical: false },
    { signalClass: 'hypothesis', provenance: null },
    { signalClass: 'derived_signal', provenance: null },
    { provenance: null },
  ])(
    'fails closed on an authorized id collision with an ineligible occurrence: %j',
    (overrides) => {
      const eligible = provenClaim();
      const ineligible = provenClaim(overrides);
      for (const claims of [
        [eligible, ineligible],
        [ineligible, eligible],
      ]) {
        expect(
          enforce({
            projection: summary(claims).projection,
            authorizedCriticalClaimIds: ['c1'],
            authorizedClaimBindings: AUTHORIZED_BINDINGS,
          }).decisionKind,
        ).toBe('evaluation_unavailable');
      }
    },
  );
  it('evaluation_unavailable when the authorized source contract is absent', () => {
    const result = enforce({
      projection: summary([provenClaim()]).projection,
      contract: { version: 'contract.v2', claims: [] },
      authorizedCriticalClaimIds: ['c1'],
      authorizedClaimBindings: AUTHORIZED_BINDINGS,
    });
    expect(result.decisionKind).toBe('evaluation_unavailable');
  });

  it('evaluation_unavailable when the source contract repeats the authorized id even if the projection is unique', () => {
    const claim = provenClaim();
    const source = declaredSource([claim] as never);
    const result = enforce({
      projection: summary([claim]).projection,
      contract: { version: 'contract.v2', claims: [...source.claims, ...source.claims] },
      authorizedCriticalClaimIds: ['c1'],
      authorizedClaimBindings: AUTHORIZED_BINDINGS,
    });
    expect(result.decisionKind).toBe('evaluation_unavailable');
  });

  it('satisfied when all eligible claims are PROVEN', () => {
    const result = enforce({
      projection: summary([provenClaim()]).projection,
      authorizedCriticalClaimIds: ['c1'],
      authorizedClaimBindings: AUTHORIZED_BINDINGS,
    });

    expect(result.satisfied).toBe(true);
    expect(result.decisionKind).toBe('clear');
    expect(result.blockingClaims).toHaveLength(0);
    expect(result.claims[0]!.reasonCodes).toContain('proven');
    expect(result.claims[0]!.registryCode).toBeDefined();
  });

  it('gated when a claim is NOT_VERIFIED', () => {
    const result = enforce({
      projection: summary([provenClaim({ claimId: 'c1', verificationState: 'NOT_VERIFIED' })])
        .projection,
      authorizedCriticalClaimIds: ['c1'],
      authorizedClaimBindings: AUTHORIZED_BINDINGS,
    });

    expect(result.satisfied).toBe(false);
    expect(result.decisionKind).toBe('facts_unproven');
    expect(result.blockingClaims[0]!.reasonCode).toBe('evidence_missing');
  });

  it('gated when a claim is CONTRADICTED', () => {
    const result = enforce({
      projection: summary([provenClaim({ verificationState: 'CONTRADICTED' })]).projection,
      authorizedCriticalClaimIds: ['c1'],
      authorizedClaimBindings: AUTHORIZED_BINDINGS,
    });

    expect(result.blockingClaims[0]!.reasonCode).toBe('counterexample_observed');
  });

  it('gated when a claim is STALE', () => {
    const result = enforce({
      projection: summary([provenClaim({ verificationState: 'STALE' })]).projection,
      authorizedCriticalClaimIds: ['c1'],
      authorizedClaimBindings: AUTHORIZED_BINDINGS,
    });

    expect(result.blockingClaims[0]!.reasonCode).toBe('evidence_stale');
  });

  it('evaluation_unavailable when authorized claim missing from projection', () => {
    const result = enforce({
      projection: summary([]).projection,
      authorizedCriticalClaimIds: ['missing-claim'],
    });

    expect(result.satisfied).toBe(false);
    expect(result.decisionKind).toBe('evaluation_unavailable');
    expect(result.blockingClaims[0]!.reasonCode).toBe('evaluation_unavailable');
  });

  it('evaluation_unavailable when the evaluated claim binds a different certificate', () => {
    const result = enforce({
      projection: summary([
        provenClaim({
          provenance: {
            kind: 'canonical_authority',
            authorityId: 'auth-1',
            digest: 'a'.repeat(64),
            approval: {
              ...AUTHORIZED_BINDING,
              certificateId: '00000000-0000-4000-8000-0000000000ff',
            },
          },
        }),
      ]).projection,
      authorizedCriticalClaimIds: ['c1'],
      authorizedClaimBindings: AUTHORIZED_BINDINGS,
    });

    expect(result.satisfied).toBe(false);
    expect(result.decisionKind).toBe('evaluation_unavailable');
  });

  it.each([
    ['authorityId', { authorityId: 'other-authority' }],
    ['authorityDigest', { authorityDigest: 'f'.repeat(64) }],
    ['certificateId', { certificateId: '00000000-0000-4000-8000-0000000000ff' }],
    ['claimDeclarationsDigest', { claimDeclarationsDigest: 'f'.repeat(64) }],
    ['decisionAttestationDigest', { decisionAttestationDigest: 'f'.repeat(64) }],
    ['declarationId', { declarationId: '00000000-0000-4000-8000-0000000000ff' }],
  ] as const)(
    'evaluation_unavailable when the evaluated claim binding differs in %s',
    (_field, override) => {
      const result = enforce({
        projection: summary([claimWithBinding(override)]).projection,
        authorizedCriticalClaimIds: ['c1'],
        authorizedClaimBindings: AUTHORIZED_BINDINGS,
      });
      expect(result.decisionKind).toBe('evaluation_unavailable');
    },
  );

  it('evaluation_unavailable when an authorized claim has no approval binding', () => {
    const result = enforce({
      projection: summary([
        provenClaim({
          provenance: {
            kind: 'canonical_authority',
            authorityId: 'auth-1',
            digest: 'a'.repeat(64),
          },
        }),
      ]).projection,
      authorizedCriticalClaimIds: ['c1'],
      authorizedClaimBindings: AUTHORIZED_BINDINGS,
    });
    expect(result.decisionKind).toBe('evaluation_unavailable');
  });

  it('evaluation_unavailable when an authorized claim appears more than once', () => {
    const result = enforce({
      projection: summary([provenClaim(), provenClaim({ verificationState: 'UNPROVEN' })])
        .projection,
      authorizedCriticalClaimIds: ['c1'],
      authorizedClaimBindings: AUTHORIZED_BINDINGS,
    });
    expect(result.decisionKind).toBe('evaluation_unavailable');
  });

  it('certificate_invalid reason when the approval certificate is invalid', () => {
    const result = enforce({
      projection: summary([provenClaim()]).projection,
      authorizedCriticalClaimIds: ['c1'],
      certificateValid: false,
    });

    expect(result.satisfied).toBe(false);
    expect(result.decisionKind).toBe('certificate_invalid');
    expect(result.reasonCode).toBe('certificate_invalid');
  });

  it('critical_fact_required when risk triggers exist but no eligible claims', () => {
    const result = enforce({
      projection: summary([]).projection,
      authorizedCriticalClaimIds: [],
      riskTriggers: ['state_integrity'],
    });

    expect(result.decisionKind).toBe('critical_fact_required');
    expect(result.reasonCode).toBe('critical_fact_required');
  });

  it('risk_trigger_uncovered when no eligible claim declares the trigger coverage', () => {
    const result = enforce({
      projection: summary([provenClaim()]).projection,
      authorizedCriticalClaimIds: ['c1'],
      authorizedClaimBindings: AUTHORIZED_BINDINGS,
      riskTriggers: ['state_integrity'],
    });

    expect(result.satisfied).toBe(false);
    expect(result.decisionKind).toBe('risk_trigger_uncovered');
    expect(result.reasonCode).toBe('risk_trigger_uncovered');
    expect(result.uncoveredTriggers).toEqual(['state_integrity']);
  });

  it('clear when an eligible proven claim covers every detected trigger', () => {
    const result = enforce({
      projection: summary([
        provenClaim({ coversRiskTriggers: ['state_integrity', 'identity_boundary'] }),
      ]).projection,
      authorizedCriticalClaimIds: ['c1'],
      authorizedClaimBindings: AUTHORIZED_BINDINGS,
      authorizedRiskTriggerCoverage: new Map([['c1', ['state_integrity', 'identity_boundary']]]),
      riskTriggers: ['state_integrity', 'identity_boundary'],
    });

    expect(result.satisfied).toBe(true);
    expect(result.decisionKind).toBe('clear');
    expect(result.uncoveredTriggers).toEqual([]);
  });

  it('does not trust projection coverage without the certificate-bound relation', () => {
    const result = enforce({
      projection: summary([provenClaim({ coversRiskTriggers: ['state_integrity'] })]).projection,
      authorizedCriticalClaimIds: ['c1'],
      authorizedClaimBindings: AUTHORIZED_BINDINGS,
      authorizedRiskTriggerCoverage: new Map(),
      riskTriggers: ['state_integrity'],
    });

    expect(result.decisionKind).toBe('risk_trigger_uncovered');
    expect(result.uncoveredTriggers).toEqual(['state_integrity']);
  });

  it('rejects projection coverage widened beyond the approved relation', () => {
    const result = enforce({
      projection: summary([
        provenClaim({ coversRiskTriggers: ['state_integrity', 'audit_authority'] }),
      ]).projection,
      authorizedCriticalClaimIds: ['c1'],
      authorizedClaimBindings: AUTHORIZED_BINDINGS,
      authorizedRiskTriggerCoverage: new Map([['c1', ['state_integrity']]]),
      riskTriggers: ['state_integrity', 'audit_authority'],
    });

    expect(result.decisionKind).toBe('risk_trigger_uncovered');
    expect(result.uncoveredTriggers).toEqual(['audit_authority']);
  });

  it('ignores authorized coverage for a claim that is not eligible in the projection', () => {
    const result = enforce({
      projection: summary([provenClaim({ claimId: 'c1' })]).projection,
      authorizedCriticalClaimIds: ['c1'],
      authorizedClaimBindings: AUTHORIZED_BINDINGS,
      authorizedRiskTriggerCoverage: new Map([['c2', ['state_integrity']]]),
      riskTriggers: ['state_integrity'],
    });

    expect(result.decisionKind).toBe('risk_trigger_uncovered');
    expect(result.uncoveredTriggers).toEqual(['state_integrity']);
  });

  it('reports only the triggers without coverage', () => {
    const result = enforce({
      projection: summary([provenClaim({ coversRiskTriggers: ['state_integrity'] })]).projection,
      authorizedCriticalClaimIds: ['c1'],
      authorizedClaimBindings: AUTHORIZED_BINDINGS,
      authorizedRiskTriggerCoverage: new Map([['c1', ['state_integrity']]]),
      riskTriggers: ['state_integrity', 'audit_authority'],
    });

    expect(result.decisionKind).toBe('risk_trigger_uncovered');
    expect(result.uncoveredTriggers).toEqual(['audit_authority']);
  });

  it('splits coverage across several eligible claims', () => {
    const result = enforce({
      projection: summary([
        provenClaim({ claimId: 'c1', coversRiskTriggers: ['state_integrity'] }),
        provenClaim({ claimId: 'c2', coversRiskTriggers: ['audit_authority'] }),
      ]).projection,
      authorizedCriticalClaimIds: ['c1', 'c2'],
      authorizedClaimBindings: AUTHORIZED_BINDINGS,
      authorizedRiskTriggerCoverage: new Map([
        ['c1', ['state_integrity']],
        ['c2', ['audit_authority']],
      ]),
      riskTriggers: ['state_integrity', 'audit_authority'],
    });

    expect(result.satisfied).toBe(true);
  });

  it('does not let an advisory claim cover a trigger', () => {
    const result = enforce({
      projection: summary([
        provenClaim({
          signalClass: 'hypothesis',
          critical: false,
          coversRiskTriggers: ['state_integrity'],
        }),
      ]).projection,
      authorizedCriticalClaimIds: [],
      riskTriggers: ['state_integrity'],
    });

    expect(result.decisionKind).toBe('critical_fact_required');
  });

  it('does not let a certificate-less claim cover a trigger', () => {
    const result = enforce({
      projection: summary([
        provenClaim({
          provenance: {
            kind: 'canonical_authority',
            authorityId: 'auth-1',
            digest: 'a'.repeat(64),
          },
          coversRiskTriggers: ['state_integrity'],
        }),
      ]).projection,
      authorizedCriticalClaimIds: [],
      riskTriggers: ['state_integrity'],
    });

    expect(result.decisionKind).toBe('critical_fact_required');
  });

  it('riskAssessmentStale causes stale decision', () => {
    const result = enforce({
      projection: summary([provenClaim()]).projection,
      authorizedCriticalClaimIds: ['c1'],
      authorizedClaimBindings: AUTHORIZED_BINDINGS,
      riskAssessmentStale: true,
    });

    expect(result.decisionKind).toBe('risk_assessment_stale');
    expect(result.reasonCode).toBe('risk_assessment_stale');
  });

  it('clear when no authorized claims and no risk triggers', () => {
    const result = enforce({
      projection: summary([]).projection,
      authorizedCriticalClaimIds: [],
    });

    expect(result.satisfied).toBe(true);
  });

  it('reasonCode is proven when satisfied', () => {
    const result = enforce({
      projection: summary([provenClaim()]).projection,
      authorizedCriticalClaimIds: ['c1'],
      authorizedClaimBindings: AUTHORIZED_BINDINGS,
    });

    expect(result.reasonCode).toBe('proven');
  });
});
