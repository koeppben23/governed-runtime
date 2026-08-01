import { describe, expect, it } from 'vitest';
import { makeState } from '../../fixtures.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { hashText } from '../../shared/hashing.js';
import {
  materializeApprovedPlanContract,
  materializeApprovedPlanContractResult,
} from './materialize-contract.js';

const PLAN_DIGEST = 'approved-plan';
const IMPL_DIGEST = 'current-implementation';
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const CLAIM_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-01-01T00:00:00.000Z';

function stateWithClaims() {
  const state = makeState('IMPL_REVIEW', {
    plan: {
      current: { body: 'approved plan', digest: PLAN_DIGEST, sections: [], createdAt: NOW },
      history: [],
      claimDeclarations: {
        flow: 'plan',
        claims: [
          {
            claimId: CLAIM_ID,
            statement: 'the approved plan behavior is implemented',
            critical: true,
            authoritySectionId: 'implementation',
            expectedCheckId: 'test',
            counterexampleCheckId: 'security',
            structuralSurface: 'command-registration',
            mutationProfile: 'semantic',
          },
        ],
      },
      approvalCertificate: {
        flow: 'plan',
        authorityDigest: PLAN_DIGEST,
        claimDeclarationsDigest: hashText(
          canonicalJsonStringify({
            flow: 'plan',
            claims: [
              {
                claimId: CLAIM_ID,
                statement: 'the approved plan behavior is implemented',
                critical: true,
                authoritySectionId: 'implementation',
                expectedCheckId: 'test',
                counterexampleCheckId: 'security',
                structuralSurface: 'command-registration',
                mutationProfile: 'semantic',
              },
            ],
          }),
        ),
        decisionAttestationDigest: 'a'.repeat(64),
        approvedAt: NOW,
        approvedBy: 'user',
        certificateId: '00000000-0000-4000-8000-000000000001',
      },
    },
    reviewDecision: {
      verdict: 'approve',
      rationale: 'approved',
      decidedAt: NOW,
      decidedBy: 'user',
    },
    implementation: {
      changedFiles: ['src/example.ts'],
      domainFiles: ['src/example.ts'],
      digest: IMPL_DIGEST,
      executedAt: NOW,
    },
    validationAttempts: [
      {
        attemptId: ATTEMPT_ID,
        scope: 'implementation',
        implementationDigest: IMPL_DIGEST,
        result: {
          checkId: 'test',
          passed: true,
          detail: 'passed',
          executedAt: NOW,
          kind: 'test',
          command: 'npm test',
          exitCode: 0,
          executionMs: 1,
          outputDigest: 'a'.repeat(64),
          timedOut: false,
        },
      },
    ],
  });
  return state;
}

describe('materializeApprovedPlanContract', () => {
  it('materializes approved pre-evidence claims with current implementation attempts only', () => {
    const contract = materializeApprovedPlanContract(stateWithClaims());

    expect(contract.claims).toHaveLength(1);
    expect(contract.claims[0]!.evidenceRefs).toEqual([
      { kind: 'validation_attempt', attemptId: ATTEMPT_ID },
      { kind: 'structural_surface', surfaceId: 'command-registration' },
    ]);
    expect(contract.claims[0]!.provenance).toEqual({
      kind: 'canonical_authority',
      authorityId: 'plan',
      digest: PLAN_DIGEST,
      approval: {
        certificateId: '00000000-0000-4000-8000-000000000001',
        claimDeclarationsDigest:
          stateWithClaims().plan!.approvalCertificate!.claimDeclarationsDigest,
        decisionAttestationDigest: 'a'.repeat(64),
        declarationId: CLAIM_ID,
      },
    });
  });

  it('retains a claim with required executed-test coverage when its expected check is absent', () => {
    const state = stateWithClaims();
    const contract = materializeApprovedPlanContract({ ...state, validationAttempts: [] });

    expect(contract.claims).toHaveLength(1);
    expect(contract.claims[0]!.evidenceRefs).toEqual([
      { kind: 'structural_surface', surfaceId: 'command-registration' },
    ]);
    expect(contract.claims[0]!.requiredEvidence).toEqual({
      positive: ['executed_test', 'structural_assertion', 'fault_injection'],
      adversarial: ['counterexample'],
    });
    expect(
      materializeApprovedPlanContractResult({ ...state, validationAttempts: [] }).coverage,
    ).toEqual([
      { claimId: CLAIM_ID, cause: 'missing_expected_check' },
      { claimId: CLAIM_ID, cause: 'unverified_mutation_profile' },
    ]);
  });

  it('fails closed when an approved certificate is absent or stale', () => {
    const state = stateWithClaims();
    const withoutCertificate = materializeApprovedPlanContract({
      ...state,
      plan: { ...state.plan!, approvalCertificate: undefined },
    });
    const staleCertificate = materializeApprovedPlanContract({
      ...state,
      plan: {
        ...state.plan!,
        approvalCertificate: { ...state.plan!.approvalCertificate!, authorityDigest: 'other-plan' },
      },
    });

    expect(withoutCertificate).toEqual({ version: 'contract.v1', claims: [] });
    expect(staleCertificate).toEqual({ version: 'contract.v1', claims: [] });
  });

  it('fails closed when the certificate declaration digest is not canonical', () => {
    const state = stateWithClaims();
    const contract = materializeApprovedPlanContract({
      ...state,
      plan: {
        ...state.plan!,
        approvalCertificate: {
          ...state.plan!.approvalCertificate!,
          claimDeclarationsDigest: 'b'.repeat(64),
        },
      },
    });

    expect(contract).toEqual({ version: 'contract.v1', claims: [] });
  });
});
