/**
 * @module audit/proofgraph/gate.test
 * @description Pure ProofGraph gate decision (#762): unconditional, fact-only,
 * critical, PROVEN-required.
 *
 * Enforcement is no longer policy-switchable. What bounds the blast radius is
 * the eligibility rule itself, so these tests pin exactly which claims can and
 * cannot block.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateProofGraphGate,
  evaluateProofGraphGateFromState,
  isRiskAssessmentCurrent,
} from './gate.js';
import type { ProofGraphSummary } from './summary.js';
import type { ProofClaim, ProofGraphProjection } from '../../state/proofgraph.js';
import type { ClaimVerificationState, SignalClass } from '../../state/proofgraph-primitives.js';
import type { SessionState } from '../../state/schema.js';
import type {
  PlanApprovalCertificate,
  PlanClaimDeclarations,
} from '../../state/proofgraph-approval.js';
import type { PlanRecord } from '../../state/evidence-plan.js';
import { makeState } from '../../fixtures.js';
import { hashText } from '../../shared/hashing.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';

const NOW = '2026-01-01T00:00:00.000Z';

const APPROVAL = {
  certificateId: '00000000-0000-4000-8000-0000000000ce',
  claimDeclarationsDigest: 'a'.repeat(64),
  decisionAttestationDigest: 'b'.repeat(64),
  declarationId: '00000000-0000-4000-8000-0000000000de',
} as const;

function claim(
  claimId: string,
  opts: {
    signalClass?: SignalClass;
    critical?: boolean;
    state?: ClaimVerificationState;
    /** Omit to model a self-declared claim that never passed a human approval. */
    certified?: boolean;
  } = {},
): ProofClaim {
  return {
    claimId,
    statement: 'x',
    signalClass: opts.signalClass ?? 'fact',
    critical: opts.critical ?? true,
    provenance: {
      kind: 'canonical_authority',
      authorityId: 'plan',
      digest: 'd',
      ...(opts.certified === false ? {} : { approval: APPROVAL }),
    },
    evidenceRefs: [],
    counterexampleRefs: [],
    verificationState: opts.state ?? 'PROVEN',
  };
}

function summary(claims: ProofClaim[]): ProofGraphSummary {
  return {
    projection: { version: 'proofgraph.v1', claims, evaluatedAt: NOW },
    counts: { PROVEN: 0, UNPROVEN: 0, CONTRADICTED: 0, STALE: 0, BLOCKED: 0, NOT_VERIFIED: 0 },
    criticalClaimCount: 0,
    criticalUnprovenCount: 0,
    counterexamples: [],
    mutation: [],
    unresolvedAssumptions: [],
    claimDiagnostics: new Map(),
  };
}

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('evaluateProofGraphGate', () => {
  it('does not gate a session without any claims', () => {
    const decision = evaluateProofGraphGate(summary([]));
    expect(decision).toMatchObject({ gated: false, blockingClaimIds: [] });
  });

  it('blocks when a certificate-authorized critical claim is absent from the projection', () => {
    const decision = evaluateProofGraphGate({
      authorizedCriticalClaimIds: [UUID(1)],
    });
    expect(decision).toMatchObject({
      gated: true,
      kind: 'evaluation_unavailable',
      blockingClaimIds: [UUID(1)],
    });
  });

  it('blocks a present but invalid plan certificate before evaluating claims', () => {
    const decision = evaluateProofGraphGate({ certificateValid: false });
    expect(decision).toMatchObject({ gated: true, kind: 'certificate_invalid' });
  });

  it('does not gate when all critical fact claims are PROVEN', () => {
    const decision = evaluateProofGraphGate(summary([claim(UUID(1), { state: 'PROVEN' })]));
    expect(decision).toMatchObject({ gated: false, blockingClaimIds: [] });
    // The reason a reviewer reads must match the verdict, not merely exist.
    expect(decision.reason).toBe('All critical fact claims are PROVEN.');
  });

  it('gates on a critical fact claim that is not PROVEN', () => {
    const decision = evaluateProofGraphGate(summary([claim(UUID(1), { state: 'UNPROVEN' })]));
    expect(decision.gated).toBe(true);
    expect(decision.blockingClaimIds).toEqual([UUID(1)]);
    expect(decision.reason).toBe('1 critical fact claim(s) are not PROVEN.');
  });

  it('counts every blocking claim in the reason', () => {
    const decision = evaluateProofGraphGate(
      summary([
        claim(UUID(1), { state: 'UNPROVEN' }),
        claim(UUID(2), { state: 'STALE' }),
        claim(UUID(3), { state: 'PROVEN' }),
      ]),
    );
    expect(decision.blockingClaimIds).toEqual([UUID(1), UUID(2)]);
    expect(decision.reason).toBe('2 critical fact claim(s) are not PROVEN.');
  });

  it('gates on a critical fact claim that is CONTRADICTED', () => {
    const decision = evaluateProofGraphGate(summary([claim(UUID(1), { state: 'CONTRADICTED' })]));
    expect(decision.gated).toBe(true);
  });

  it('does not gate a non-critical fact claim', () => {
    const decision = evaluateProofGraphGate(
      summary([claim(UUID(1), { critical: false, state: 'UNPROVEN' })]),
    );
    expect(decision.gated).toBe(false);
  });

  it('does not gate a critical fact claim that carries no approval certificate', () => {
    // Self-declared after implementation: no human ever approved this obligation,
    // so it must stay advisory rather than block the approver.
    const decision = evaluateProofGraphGate(
      summary([claim(UUID(1), { state: 'UNPROVEN', certified: false })]),
    );
    expect(decision.gated).toBe(false);
    expect(decision.blockingClaimIds).toEqual([]);
  });

  it('does not gate a critical derived_signal or hypothesis claim (fact-only)', () => {
    const claims = [
      claim(UUID(1), { signalClass: 'derived_signal', state: 'UNPROVEN' }),
      claim(UUID(2), { signalClass: 'hypothesis', state: 'CONTRADICTED' }),
    ];
    const decision = evaluateProofGraphGate(summary(claims));
    expect(decision.gated).toBe(false);
    expect(decision.blockingClaimIds).toEqual([]);
  });

  it('requires a certified critical fact for a specific risk trigger', () => {
    const decision = evaluateProofGraphGate({
      ...summary([]),
      implementationDigest: 'implementation-digest',
      riskAssessment: {
        implementationDigest: 'implementation-digest',
        riskTriggers: ['state_integrity'],
      },
    });
    expect(decision).toMatchObject({
      gated: true,
      kind: 'critical_fact_required',
      relevantTriggers: ['state_integrity'],
    });
  });

  it('does not impose a critical fact requirement for ceremony_only', () => {
    const decision = evaluateProofGraphGate({
      ...summary([]),
      implementationDigest: 'implementation-digest',
      riskAssessment: {
        implementationDigest: 'implementation-digest',
        riskTriggers: ['ceremony_only'],
      },
    });
    expect(decision).toMatchObject({ gated: false, kind: 'clear', relevantTriggers: [] });
  });

  it('blocks a legacy assessment that has no trigger taxonomy', () => {
    const decision = evaluateProofGraphGate({
      ...summary([]),
      implementationDigest: 'implementation-digest',
      riskAssessment: { implementationDigest: 'implementation-digest' },
    });
    expect(decision).toMatchObject({ gated: true, kind: 'risk_assessment_stale' });
  });

  // The following pin the discriminating conditions of the risk-assessment path.
  // Without them the corresponding branches can be inverted without any test
  // noticing (confirmed by surviving mutants).

  it('treats a matching digest with a non-array trigger taxonomy as NOT current', () => {
    // Same implementation digest, but riskTriggers is not an array: the
    // assessment predates the taxonomy and must not be accepted as current.
    expect(
      isRiskAssessmentCurrent(
        { implementationDigest: 'implementation-digest' },
        'implementation-digest',
      ),
    ).toBe(false);
    expect(
      isRiskAssessmentCurrent(
        { implementationDigest: 'implementation-digest', riskTriggers: [] },
        'implementation-digest',
      ),
    ).toBe(true);
  });

  it('does not report a stale assessment when there is no implementation digest to bind to', () => {
    // riskAssessment present but no implementation digest: the assessment cannot
    // be judged stale against a revision that does not exist, so the gate falls
    // through to the claim-only decision instead of blocking.
    const decision = evaluateProofGraphGate({
      ...summary([]),
      riskAssessment: { implementationDigest: 'other', riskTriggers: [] },
    });
    expect(decision.kind).not.toBe('risk_assessment_stale');
    expect(decision).toMatchObject({ gated: false, kind: 'clear' });
  });

  it('does not demand another critical fact when an eligible claim already exists', () => {
    // triggers present AND an eligible claim present: the critical-fact
    // requirement is already satisfied, so the gate must judge that claim
    // instead of demanding one.
    const decision = evaluateProofGraphGate({
      ...summary([claim(UUID(1), { state: 'PROVEN' })]),
      implementationDigest: 'implementation-digest',
      riskAssessment: {
        implementationDigest: 'implementation-digest',
        riskTriggers: ['state_integrity'],
      },
    });
    expect(decision.kind).not.toBe('critical_fact_required');
    expect(decision).toMatchObject({ gated: false, kind: 'clear' });
  });

  it('does not report missing evaluation when every authorized claim is present', () => {
    // The authorized id resolves to an eligible claim, so the
    // evaluation_unavailable path must not trigger.
    const decision = evaluateProofGraphGate({
      ...summary([claim(UUID(1), { state: 'PROVEN' })]),
      authorizedCriticalClaimIds: [UUID(1)],
    });
    expect(decision.kind).not.toBe('evaluation_unavailable');
    expect(decision).toMatchObject({ gated: false, kind: 'clear', blockingClaimIds: [] });
  });

  it('classifies an unproven eligible claim as facts_unproven, not clear', () => {
    const decision = evaluateProofGraphGate(summary([claim(UUID(1), { state: 'UNPROVEN' })]));
    expect(decision).toMatchObject({ gated: true, kind: 'facts_unproven' });
  });
});

describe('evaluateProofGraphGateFromState', () => {
  function declarations(critical: boolean, claimId: string = UUID(1)): PlanClaimDeclarations {
    return {
      flow: 'plan',
      version: 'v2',
      claims: [
        {
          claimId,
          statement: 'x',
          critical,
          authoritySectionId: 's1',
          claimScope: 'specific_behavior',
          expectedCheckId: 'test',
        },
      ],
    };
  }

  function certificate(decls: PlanClaimDeclarations): PlanApprovalCertificate {
    return {
      flow: 'plan',
      authorityDigest: 'plan-digest',
      claimDeclarationsDigest: hashText(canonicalJsonStringify(decls)),
      decisionAttestationDigest: 'd',
      approvedAt: NOW,
      approvedBy: 'reviewer',
      certificateId: '00000000-0000-4000-8000-0000000000ce',
      planVersion: 1,
      planRecordDigest: 'record-digest',
      reviewBinding: {
        kind: 'current_review',
        reviewObligationId: '00000000-0000-4000-8000-0000000000cf',
        reviewEvidenceDigest: 'review-evidence-digest',
        reviewedSubjectDigest: 'plan-digest',
      },
      reviewObligationId: '00000000-0000-4000-8000-0000000000cf',
      reviewEvidenceDigest: 'review-evidence-digest',
    };
  }

  function planRecord(decls: PlanClaimDeclarations, cert?: PlanApprovalCertificate): PlanRecord {
    return {
      current: {
        body: 'x',
        digest: 'plan-digest',
        sections: [],
        createdAt: NOW,
        recordDigest: 'record-digest',
        planVersion: 1,
        supersedesRecordDigest: null,
        originatingReviewObligationId: null,
        revisionReason: null,
        lineageStatus: 'verified',
      },
      history: [],
      reviewCompletion: 'pending',
      claimDeclarations: decls,
      ...(cert ? { approvalCertificate: cert } : {}),
    };
  }

  function projection(claims: ProofClaim[]): ProofGraphProjection {
    return { version: 'proofgraph.v1', claims, evaluatedAt: NOW };
  }

  function stateWith(overrides: Partial<SessionState>): SessionState {
    return makeState('EVIDENCE_REVIEW', overrides);
  }

  it('is clear for a session without plan, claims, or risk assessment', () => {
    const decision = evaluateProofGraphGateFromState(stateWith({ plan: null }));
    expect(decision).toMatchObject({ gated: false, kind: 'clear', blockingClaimIds: [] });
  });

  it('reports a gated certificate outcome when critical claims are declared but not approved', () => {
    const decision = evaluateProofGraphGateFromState(
      stateWith({ plan: planRecord(declarations(true)) }),
    );
    // Mirrors the review-decision rail: no current certificate → not authorized.
    expect(decision).toMatchObject({ gated: true, kind: 'certificate_invalid' });
  });

  it('is clear for a session with no critical declarations and no certificate', () => {
    const decision = evaluateProofGraphGateFromState(
      stateWith({ plan: planRecord(declarations(false)) }),
    );
    expect(decision).toMatchObject({ gated: false, kind: 'clear' });
  });

  it('reports evaluation_unavailable when an authorized critical claim is absent from the projection', () => {
    const decls = declarations(true);
    const decision = evaluateProofGraphGateFromState(
      stateWith({ plan: planRecord(decls, certificate(decls)) }),
    );
    expect(decision).toMatchObject({
      gated: true,
      kind: 'evaluation_unavailable',
      blockingClaimIds: [UUID(1)],
    });
  });

  it('reports facts_unproven when an authorized critical claim is not PROVEN', () => {
    const decls = declarations(true);
    const decision = evaluateProofGraphGateFromState(
      stateWith({
        plan: planRecord(decls, certificate(decls)),
        proofGraph: projection([claim(UUID(1), { state: 'UNPROVEN' })]),
      }),
    );
    expect(decision).toMatchObject({
      gated: true,
      kind: 'facts_unproven',
      blockingClaimIds: [UUID(1)],
    });
  });

  it('is clear when the authorized critical claim is PROVEN', () => {
    const decls = declarations(true);
    const decision = evaluateProofGraphGateFromState(
      stateWith({
        plan: planRecord(decls, certificate(decls)),
        proofGraph: projection([claim(UUID(1), { state: 'PROVEN' })]),
      }),
    );
    expect(decision).toMatchObject({ gated: false, kind: 'clear', blockingClaimIds: [] });
  });

  it('reports a stale risk assessment against the current implementation digest', () => {
    const decls = declarations(true);
    const decision = evaluateProofGraphGateFromState(
      stateWith({
        plan: planRecord(decls, certificate(decls)),
        proofGraph: projection([claim(UUID(1), { state: 'PROVEN' })]),
        implementation: { digest: 'impl-digest' } as SessionState['implementation'],
        implementationRiskAssessment: {
          computedMinimumTaskClass: 'STANDARD',
          touchedSurfaces: ['src/'],
          assessedFrom: 'implementation_changed_files',
          assessedFileCount: 1,
          implementationDigest: 'other-digest',
          riskTriggers: ['state_integrity'],
        },
      }),
    );
    expect(decision).toMatchObject({ gated: true, kind: 'risk_assessment_stale' });
  });
});
