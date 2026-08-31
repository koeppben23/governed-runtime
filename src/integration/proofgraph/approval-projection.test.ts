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
import type { SessionState } from '../../state/schema.js';
import { buildProofApprovalProjection } from './approval-projection.js';

const CLAIM_ID = '88888888-8888-4888-8888-888888888888';
const CERTIFICATE_ID = '99999999-9999-4999-8999-999999999999';
const ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
        flow: 'plan',
        authorityDigest: PLAN_RECORD.current.digest,
        claimDeclarationsDigest: 'b'.repeat(64),
        decisionAttestationDigest: 'c'.repeat(64),
        approvedAt: '2026-01-01T00:00:00.000Z',
        approvedBy: 'approver',
        certificateId: CERTIFICATE_ID,
        planVersion: 1,
        planRecordDigest: 'record-digest',
        reviewBinding: {
          kind: 'current_review',
          reviewObligationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          reviewEvidenceDigest: 'd'.repeat(64),
          reviewedSubjectDigest: PLAN_RECORD.current.digest,
        },
      },
    },
    proofContract: {
      version: 'contract.v1',
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
              decisionAttestationDigest: 'c'.repeat(64),
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
      decisionAttestationDigest: 'c'.repeat(64),
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
        version: 'proofgraph.v1',
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
