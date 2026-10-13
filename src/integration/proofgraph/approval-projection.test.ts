/**
 * Approval and materialization projection (#762).
 *
 * A certificate buried in session state is not auditable. These tests pin that
 * the full binding chain — declaration, certificate, materialized claim,
 * implementation revision, evidence, verification state — is projected, and that
 * missing links stay explicit instead of defaulting to a proven-looking value.
 */

import { describe, expect, it } from 'vitest';
import { makeState, PLAN_RECORD, IMPL_EVIDENCE } from '../../fixtures.js';
import { planApprovalContextOf } from '../../state/proofgraph-approval-context.js';
import { hashText } from '../../shared/hashing.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import type { SessionState } from '../../state/schema.js';
import { buildProofApprovalProjection } from './approval-projection.js';

const CLAIM_ID = '88888888-8888-4888-8888-888888888888';
const CERTIFICATE_ID = '99999999-9999-4999-8999-999999999999';
const ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const CERT_CONTEXT = planApprovalContextOf(makeState('IMPL_REVIEW'));
const CERT_ATTESTATION = {
  kind: 'explicit_decision' as const,
  decision: {
    verdict: 'approve' as const,
    rationale: 'LGTM',
    decidedAt: '2026-01-01T00:00:00.000Z',
    decisionIdentity: {
      actorId: 'approver',
      actorEmail: null,
      actorSource: 'unknown' as const,
      actorAssurance: 'best_effort' as const,
    },
  },
  flowguardSessionId: CERT_CONTEXT.flowguardSessionId,
  bindingDigest: CERT_CONTEXT.bindingDigest,
  policyHash: CERT_CONTEXT.policyHash,
  policyHashVersion: CERT_CONTEXT.policyHashVersion,
};
const CERT_DIGEST = hashText(canonicalJsonStringify(CERT_ATTESTATION));

function contractState(overrides: Partial<SessionState> = {}): SessionState {
  return makeState('IMPL_REVIEW', {
    implementation: IMPL_EVIDENCE,
    plan: {
      ...PLAN_RECORD,
      claimDeclarations: {
        flow: 'plan',
        version: 'v2',
        claims: [
          {
            claimId: CLAIM_ID,
            statement: 'updateTask rejects unknown ids',
            critical: true,
            authoritySectionId: 'step-1',
            claimScope: 'specific_behavior',
            expectedCheckId: 'build',
          },
        ],
      },
      approvalCertificate: {
        schemaVersion: 'plan-approval-certificate.v1' as const,
        flow: 'plan' as const,
        authorityDigest: PLAN_RECORD.current.digest,
        claimDeclarationsDigest: 'b'.repeat(64),
        decisionAttestationDigest: CERT_DIGEST,
        approvedAt: '2026-01-01T00:00:00.000Z',
        certificateId: CERTIFICATE_ID,
        planVersion: 1,
        planRecordDigest: 'record-digest',
        reviewBinding: {
          kind: 'current_review',
          reviewObligationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          reviewEvidenceDigest: 'd'.repeat(64),
          reviewedSubjectDigest: PLAN_RECORD.current.digest,
        },
        approvalAttestation: CERT_ATTESTATION,
      },
    },
    proofContract: {
      version: 'contract.v2',
      claims: [
        {
          claimId: CLAIM_ID,
          statement: 'updateTask rejects unknown ids',
          signalClass: 'fact',
          critical: true,
          provenance: {
            kind: 'canonical_authority',
            authorityId: 'plan',
            digest: PLAN_RECORD.current.digest,
            approval: {
              certificateId: CERTIFICATE_ID,
              claimDeclarationsDigest: 'b'.repeat(64),
              decisionAttestationDigest: CERT_DIGEST,
              declarationId: CLAIM_ID,
            },
          },
          evidenceRefs: [{ kind: 'validation_attempt', attemptId: ATTEMPT_ID }],
          counterexampleRefs: [],
        },
      ],
    },
    ...overrides,
  });
}

describe('buildProofApprovalProjection', () => {
  it('projects every digest of the plan approval certificate', () => {
    const projection = buildProofApprovalProjection(contractState());

    expect(projection.certificates).toHaveLength(1);
    expect(projection.certificates[0]).toMatchObject({
      flow: 'plan',
      certificateId: CERTIFICATE_ID,
      authorityDigest: PLAN_RECORD.current.digest,
      claimDeclarationsDigest: 'b'.repeat(64),
      decisionAttestationDigest: CERT_DIGEST,
      declaredClaimCount: 1,
    });
  });

  it('binds the materialized claim to its certificate, revision, and evidence', () => {
    const projection = buildProofApprovalProjection(contractState());

    expect(projection.implementationDigest).toBe(IMPL_EVIDENCE.digest);
    expect(projection.claims[0]).toMatchObject({
      claimId: CLAIM_ID,
      signalClass: 'fact',
      critical: true,
      certificateId: CERTIFICATE_ID,
      authorityDigest: PLAN_RECORD.current.digest,
      evidenceRefCount: 1,
      counterexampleRefCount: 0,
    });
  });

  it('reports a null verification state before the graph has been evaluated', () => {
    expect(buildProofApprovalProjection(contractState()).claims[0]?.verificationState).toBeNull();
  });

  it('reports the evaluated verification state once the graph exists', () => {
    const state = contractState({
      proofGraph: {
        version: 'proofgraph.v2',
        evaluatedAt: '2026-01-01T00:00:00.000Z',
        claims: [
          {
            claimId: CLAIM_ID,
            statement: 'updateTask rejects unknown ids',
            signalClass: 'fact',
            critical: true,
            verificationState: 'PROVEN',
            provenance: null,
            evidenceRefs: [],
            counterexampleRefs: [],
          },
        ],
      },
    });
    expect(buildProofApprovalProjection(state).claims[0]?.verificationState).toBe('PROVEN');
  });

  it('surfaces recorded coverage gaps', () => {
    const state = contractState({
      proofContractCoverage: [{ claimId: CLAIM_ID, cause: 'missing_expected_check' }],
    });
    expect(buildProofApprovalProjection(state).coverageGaps).toEqual([
      { claimId: CLAIM_ID, cause: 'missing_expected_check' },
    ]);
  });

  it('projects an empty chain without inventing certificates', () => {
    const projection = buildProofApprovalProjection(makeState('READY'));
    expect(projection).toEqual({
      certificates: [],
      implementationDigest: null,
      claims: [],
      coverageGaps: [],
    });
  });
});
