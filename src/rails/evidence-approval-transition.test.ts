/**
 * @module rails/evidence-approval-transition.test
 * @description The protected evidence-approval transition: generic application
 * refuses the edge; the sanctioned application enforces the canonical preflight
 * and auto-advance fails closed without state on denial.
 *
 * @test-policy HAPPY, BAD, EDGE
 */

import { describe, expect, it } from 'vitest';
import {
  applyEvidenceApprovalTransition,
  applyTransition,
  autoAdvance,
  type AutoAdvanceBlocked,
} from './types.js';
import { ProtectedTransitionError } from './protected-transition-error.js';
import { evaluate } from '../machine/evaluate.js';
import { TEAM_POLICY } from '../config/policy.js';
import {
  IMPL_EVIDENCE,
  makePlanApprovalCertificate,
  makeState,
  PLAN_RECORD,
  REVIEW_APPROVE,
} from '../fixtures.js';
import { createPolicySnapshot } from '../config/policy-snapshot.js';
import { getPolicyPreset } from '../config/policy.js';
import type { SessionState } from '../state/schema.js';
import type { ProofGraphProjection } from '../state/proofgraph.js';
import type { PlanClaimDeclarations } from '../state/proofgraph-approval.js';
import { hashText } from '../shared/hashing.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';

const NOW = '2026-01-01T00:00:00.000Z';
const CLAIM_ID = '00000000-0000-4000-8000-0000000000d1';

const AUTO_POLICY = { ...TEAM_POLICY, requireHumanGates: false };
const ctx = { now: () => NOW, digest: hashText, policy: AUTO_POLICY };

/** A clear evidence basis under an automatic (solo) session policy. */
function autoClearState(): SessionState {
  return makeState('EVIDENCE_REVIEW', {
    policySnapshot: createPolicySnapshot(getPolicyPreset('solo'), NOW, hashText),
  });
}

function declarations(): PlanClaimDeclarations {
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
      },
    ],
  };
}

/** EVIDENCE_REVIEW with a certified critical claim but no trigger coverage. */
function blockedState(): SessionState {
  const decls = declarations();
  const base = makeState('EVIDENCE_REVIEW', {
    reviewDecision: REVIEW_APPROVE,
    implementation: IMPL_EVIDENCE,
    implementationRiskAssessment: {
      computedMinimumTaskClass: 'HIGH-RISK',
      effectiveTaskClass: 'HIGH-RISK',
      declaredTaskClass: null,
      declarationKind: 'absent',
      ticketDigest: null,
      touchedSurfaces: ['src/state/module.ts'],
      riskTriggers: ['state_integrity'],
      assessedFrom: 'implementation_changed_files',
      assessedFileCount: 1,
      implementationDigest: IMPL_EVIDENCE.digest,
    },
    plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted', claimDeclarations: decls },
  });
  const certificate = makePlanApprovalCertificate(base, {
    claimDeclarationsDigest: hashText(canonicalJsonStringify(decls)),
  });
  const projection: ProofGraphProjection = {
    version: 'proofgraph.v2',
    evaluatedAt: NOW,
    claims: [
      {
        claimId: CLAIM_ID,
        statement: 'the change preserves the intended behavior',
        signalClass: 'fact',
        critical: true,
        provenance: {
          kind: 'canonical_authority',
          authorityId: 'plan',
          digest: certificate.authorityDigest,
          approval: {
            certificateId: certificate.certificateId,
            claimDeclarationsDigest: certificate.claimDeclarationsDigest,
            decisionAttestationDigest: certificate.decisionAttestationDigest,
            declarationId: CLAIM_ID,
          },
        },
        evidenceRefs: [],
        counterexampleRefs: [],
        verificationState: 'PROVEN',
      },
    ],
  };
  const {
    verificationState: _state,
    freshness: _freshness,
    ...sourceClaim
  } = projection.claims[0]!;
  return {
    ...base,
    plan: { ...base.plan!, approvalCertificate: certificate },
    // Materialized source contract the gate requires alongside the certificate;
    // the declared fact without its evaluated verification state.
    proofContract: { version: 'contract.v2', claims: [sourceClaim] },
    proofGraph: projection,
  };
}

describe('protected evidence-approval transition', () => {
  it('refuses the approval edge through the generic applier', () => {
    const state = autoClearState();
    expect(() => applyTransition(state, 'EVIDENCE_REVIEW', 'EXPORT_READY', 'APPROVE', NOW)).toThrow(
      ProtectedTransitionError,
    );
  });

  it('blocks the sanctioned application on the canonical denial without mutating state', () => {
    const state = blockedState();
    const result = applyEvidenceApprovalTransition(state, NOW);
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.block.code).toBe('PROOFGRAPH_RISK_TRIGGER_UNCOVERED');
    }
    expect(state.phase).toBe('EVIDENCE_REVIEW');
    expect(state.transition?.to).not.toBe('EXPORT_READY');
  });

  it('applies the sanctioned transition for a clear evidence basis', () => {
    const state = autoClearState();
    const result = applyEvidenceApprovalTransition(state, NOW);
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.state.phase).toBe('EXPORT_READY');
      expect(result.state.transition).toMatchObject({
        from: 'EVIDENCE_REVIEW',
        to: 'EXPORT_READY',
        event: 'APPROVE',
      });
    }
  });

  it('refuses the sanctioned application outside EVIDENCE_REVIEW', () => {
    const state = makeState('IMPL_REVIEW');
    expect(() => applyEvidenceApprovalTransition(state, NOW)).toThrow(ProtectedTransitionError);
  });

  it('auto-advance fails closed on denial: no state, no transitions, canonical code', () => {
    const result = autoAdvance(blockedState(), (s) => evaluate(s, AUTO_POLICY), ctx);
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      const blockedResult: AutoAdvanceBlocked = result;
      expect(blockedResult.block.code).toBe('PROOFGRAPH_RISK_TRIGGER_UNCOVERED');
      expect(blockedResult.phase).toBe('EVIDENCE_REVIEW');
    }
    expect('state' in result).toBe(false);
    expect('transitions' in result).toBe(false);
  });

  it('auto-advance applies the protected edge for a clear evidence basis and carries the admission', () => {
    const result = autoAdvance(autoClearState(), (s) => evaluate(s, AUTO_POLICY), ctx);
    expect(result.kind).toBe('advanced');
    if (result.kind === 'advanced') {
      expect(result.state.phase).toBe('EXPORT_READY');
      expect(result.transitions.some((transition) => transition.to === 'EXPORT_READY')).toBe(true);
      // The admission must survive autoAdvance: the persistence boundary
      // refuses a new EXPORT_READY without it.
      expect(result.approvalAdmission).toBeDefined();
    }
  });
});
