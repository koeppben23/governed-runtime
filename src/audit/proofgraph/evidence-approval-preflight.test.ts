/**
 * @module audit/proofgraph/evidence-approval-preflight.test
 * @description The single substantive evidence-approval prerequisite: exact
 * registry-code mapping and precedence.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, expect, it } from 'vitest';
import { evaluateEvidenceApprovalPreflight } from './evidence-approval-preflight.js';
import {
  IMPL_EVIDENCE,
  makePlanApprovalCertificate,
  makeState,
  materializedPlanClaim,
  PLAN_RECORD,
} from '../../fixtures.js';
import type { SessionState } from '../../state/schema.js';
import type { ProofGraphProjection } from '../../state/proofgraph.js';
import type { PlanClaimDeclarations } from '../../state/proofgraph-approval.js';
import { hashText } from '../../shared/hashing.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';

const CLAIM_ID = '00000000-0000-4000-8000-0000000000c1';
const CERT_ID = '00000000-0000-4000-8000-0000000000cf';
const NOW = '2026-01-01T00:00:00.000Z';

function declarations(covers: boolean): PlanClaimDeclarations {
  return {
    flow: 'plan',
    version: 'v2',
    claims: [
      {
        claimId: CLAIM_ID,
        statement: 'the change preserves the intended behavior',
        critical: true,
        authoritySectionId: 's1',
        claimScope: 'specific_behavior',
        expectedCheckId: 'test',
        ...(covers ? { coversRiskTriggers: ['state_integrity' as const] } : {}),
      },
    ],
  };
}

function riskAssessment(implementationDigest: string) {
  return {
    computedMinimumTaskClass: 'HIGH-RISK' as const,
    effectiveTaskClass: 'HIGH-RISK' as const,
    declaredTaskClass: null,
    declarationKind: 'absent' as const,
    ticketDigest: null,
    touchedSurfaces: ['src/state/module.ts'],
    riskTriggers: ['state_integrity' as const],
    assessedFrom: 'implementation_changed_files' as const,
    assessedFileCount: 1,
    implementationDigest,
  };
}

function certifiedClaim(
  state: SessionState,
  verificationState: 'PROVEN' | 'UNPROVEN',
): ProofGraphProjection {
  const certificate = state.plan?.approvalCertificate;
  if (!certificate) throw new Error('fixture requires a certificate');
  const declaration = state.plan?.claimDeclarations?.claims[0];
  if (!declaration) throw new Error('fixture requires a declaration');
  return {
    version: 'proofgraph.v2',
    evaluatedAt: NOW,
    claims: [{ ...materializedPlanClaim(declaration, certificate), verificationState }],
  };
}

function evidenceState(input: {
  readonly decls?: PlanClaimDeclarations;
  readonly withCertificate?: boolean;
  readonly verificationState?: 'PROVEN' | 'UNPROVEN';
  readonly triggers?: boolean;
  readonly assessment?: boolean;
}): SessionState {
  const decls = input.decls;
  const base = makeState('EVIDENCE_REVIEW', {
    implementation: IMPL_EVIDENCE,
    implementationRiskAssessment:
      input.assessment === false ? null : riskAssessment(IMPL_EVIDENCE.digest),
    plan: decls
      ? {
          ...PLAN_RECORD,
          reviewCompletion: 'reviewer_accepted',
          claimDeclarations: decls,
        }
      : null,
  });
  if (!decls || input.withCertificate !== true) return base;
  const certificate = makePlanApprovalCertificate(base, {
    claimDeclarationsDigest: hashText(canonicalJsonStringify(decls)),
  });
  const certified: SessionState = {
    ...base,
    plan: { ...base.plan!, approvalCertificate: certificate },
  };
  // Materialized contract the gate requires alongside the certificate: the
  // same declared critical fact without its evaluated verification state.
  const materialized = certifiedClaim(certified, 'PROVEN').claims[0];
  if (!materialized) throw new Error('fixture requires a certified claim');
  const { verificationState: _state, freshness: _freshness, ...sourceClaim } = materialized;
  return {
    ...certified,
    proofContract: { version: 'contract.v2', claims: [sourceClaim] },
  };
}

describe('evaluateEvidenceApprovalPreflight', () => {
  it('clears a claimless, trigger-less workflow without inventing a certificate', () => {
    const state = makeState('EVIDENCE_REVIEW', {
      implementation: IMPL_EVIDENCE,
      implementationRiskAssessment: {
        ...riskAssessment(IMPL_EVIDENCE.digest),
        riskTriggers: [],
      },
    });
    expect(evaluateEvidenceApprovalPreflight(state)).toEqual({ kind: 'clear' });
  });

  it('clears outside the evidence gate', () => {
    expect(evaluateEvidenceApprovalPreflight(makeState('IMPL_REVIEW'))).toEqual({ kind: 'clear' });
  });

  it('blocks critical declarations without a certificate', () => {
    const state = evidenceState({ decls: declarations(true), withCertificate: false });
    expect(evaluateEvidenceApprovalPreflight(state)).toEqual({
      kind: 'blocked',
      code: 'PROOFGRAPH_CERTIFICATE_INVALID',
    });
  });

  it('blocks when the authorized critical claim has no persisted evaluation', () => {
    const state = evidenceState({ decls: declarations(true), withCertificate: true });
    expect(evaluateEvidenceApprovalPreflight(state)).toEqual({
      kind: 'blocked',
      code: 'PROOFGRAPH_EVALUATION_UNAVAILABLE',
      params: { claimIds: CLAIM_ID },
    });
  });

  it('blocks an uncovered specific risk trigger with the exact coverage code', () => {
    const base = evidenceState({
      decls: declarations(false),
      withCertificate: true,
    });
    const state: SessionState = { ...base, proofGraph: certifiedClaim(base, 'PROVEN') };
    expect(evaluateEvidenceApprovalPreflight(state)).toEqual({
      kind: 'blocked',
      code: 'PROOFGRAPH_RISK_TRIGGER_UNCOVERED',
      params: { triggers: 'state_integrity' },
    });
  });

  it('clears a covered, PROVEN critical claim', () => {
    const base = evidenceState({ decls: declarations(true), withCertificate: true });
    const state: SessionState = { ...base, proofGraph: certifiedClaim(base, 'PROVEN') };
    expect(evaluateEvidenceApprovalPreflight(state)).toEqual({ kind: 'clear' });
  });

  it('blocks a covered but unproven critical claim with the unproven-facts code', () => {
    const base = evidenceState({ decls: declarations(true), withCertificate: true });
    const state: SessionState = { ...base, proofGraph: certifiedClaim(base, 'UNPROVEN') };
    const result = evaluateEvidenceApprovalPreflight(state);
    expect(result).toMatchObject({
      kind: 'blocked',
      code: 'PROOFGRAPH_CRITICAL_FACTS_UNPROVEN',
    });
  });

  it('surfaces a persisted blocking rejected claim verbatim', () => {
    const base = evidenceState({ decls: declarations(true), withCertificate: true });
    const state: SessionState = {
      ...base,
      plan: {
        ...base.plan!,
        claimSubmissionDiagnostics: {
          submittedClaimDeclarationsDigest: 'a'.repeat(64),
          acceptedClaimDeclarationsDigest: 'a'.repeat(64),
          rejectedClaims: [
            {
              claimRef: CLAIM_ID,
              statement: 'rejected behavior',
              critical: true,
              disposition: 'rejected_blocking',
              code: 'PROOFGRAPH_CLAIM_NOT_DECLARED',
              reason: 'persisted-forensic-reason',
              recovery: ['correct the declaration'],
            },
          ],
        },
      },
    };
    const result = evaluateEvidenceApprovalPreflight(state);
    expect(result).toMatchObject({
      kind: 'blocked',
      code: 'PROOFGRAPH_CLAIM_NOT_DECLARED',
      reason: 'persisted-forensic-reason',
    });
  });
});
