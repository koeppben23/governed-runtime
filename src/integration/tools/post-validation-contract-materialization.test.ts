/**
 * @module integration/tools/post-validation-contract-materialization.test
 * @description Post-validation contract materialization boundary (Run-9 F1):
 * the reduced-ceremony path must carry the approved-plan contract into
 * EVIDENCE_REVIEW, and the materialization must be idempotent, gated on the
 * canonical reduced-ceremony binding, and never rewrite an existing contract.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  IMPL_EVIDENCE,
  makeState,
  POLICY_SNAPSHOT,
  VALIDATION_PASSED,
  VERIFICATION_CANDIDATES,
} from '../../fixtures.js';
import {
  TEST_EXECUTION_OBSERVATION,
  makePlanRevision,
} from '../../state/evidence-test-constants.js';
import type {
  ImplementationRiskAssessment,
  ReducedCeremonyDecision,
  SessionState,
} from '../../state/schema.js';
import type { PlanClaimDeclarations } from '../../state/proofgraph-approval.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { hashText } from '../../shared/hashing.js';
import { evaluateProofGraphGateFromState } from '../../audit/proofgraph/gate.js';
import { materializePostValidationContract } from './implementation-review-activation.js';

const DOC_IMPL = {
  ...IMPL_EVIDENCE,
  changedFiles: ['docs/usage-notes.md'],
  domainFiles: [],
};

const TEST_ATTEMPT_ID = '00000000-0000-4000-8000-0000000000a1';
const LINT_ATTEMPT_ID = '00000000-0000-4000-8000-0000000000a2';
const CLAIM_ID = '22222222-2222-4222-8222-222222222222';

function attempt(checkId: string) {
  const base = VALIDATION_PASSED[checkId === 'test' ? 0 : 1]!;
  return {
    attemptId: checkId === 'test' ? TEST_ATTEMPT_ID : LINT_ATTEMPT_ID,
    scope: 'implementation' as const,
    implementationId: DOC_IMPL.implementationId,
    implementationDigest: DOC_IMPL.digest,
    executionObservation: TEST_EXECUTION_OBSERVATION,
    result: { ...base, checkId, passed: true },
  };
}

const RISK_ASSESSMENT: ImplementationRiskAssessment = {
  computedMinimumTaskClass: 'TRIVIAL',
  effectiveTaskClass: 'TRIVIAL',
  declaredTaskClass: null,
  declarationKind: 'absent' as const,
  ticketDigest: null,
  touchedSurfaces: ['docs/usage-notes.md'],
  riskTriggers: [],
  assessedFrom: 'implementation_changed_files',
  assessedFileCount: 1,
  implementationDigest: DOC_IMPL.digest,
};

const POLICY = {
  ...POLICY_SNAPSHOT,
  allowReducedCeremony: true,
  requireHumanGates: true,
  effectiveGateBehavior: 'human_gated' as const,
};

const DECISION: ReducedCeremonyDecision = {
  profile: 'reduced',
  reason: 'POST_IMPL_VERIFIED_TRIVIAL',
  effectiveTaskClass: 'TRIVIAL',
  declaredTaskClass: null,
  declarationKind: 'absent' as const,
  ticketDigest: null,
  computedMinimumTaskClass: 'TRIVIAL',
  touchedSurfaces: ['docs/usage-notes.md'],
  implementationId: DOC_IMPL.implementationId,
  implementationDigest: DOC_IMPL.digest,
  policyDigest: POLICY.hash,
  verificationBasis: {
    checkIds: ['test', 'lint'],
    attempts: [
      { checkId: 'test', attemptId: TEST_ATTEMPT_ID, executedAt: VALIDATION_PASSED[0]!.executedAt },
      { checkId: 'lint', attemptId: LINT_ATTEMPT_ID, executedAt: VALIDATION_PASSED[1]!.executedAt },
    ],
  },
  decidedAt: '2026-01-02T00:00:00.000Z',
};

const PLAN_CURRENT = makePlanRevision({ body: 'approved plan' });

function declarations(): PlanClaimDeclarations {
  return {
    flow: 'plan',
    version: 'v2',
    claims: [
      {
        claimId: CLAIM_ID,
        statement: 'the approved plan behavior is implemented',
        critical: true,
        authoritySectionId: 'implementation',
        claimScope: 'specific_behavior',
        expectedCheckId: 'test',
        structuralSurface: 'command-registration',
      },
    ],
  };
}

const EMPTY_DECLARATIONS: PlanClaimDeclarations = { flow: 'plan', version: 'v2', claims: [] };

function certificate(
  decls: PlanClaimDeclarations = declarations(),
  overrides: Record<string, unknown> = {},
) {
  return {
    flow: 'plan' as const,
    authorityDigest: PLAN_CURRENT.digest,
    claimDeclarationsDigest: hashText(canonicalJsonStringify(decls)),
    decisionAttestationDigest: 'a'.repeat(64),
    approvedAt: '2026-01-02T00:00:00.000Z',
    approvedBy: 'FlowGuard Demo',
    certificateId: randomUUID(),
    planVersion: PLAN_CURRENT.planVersion,
    planRecordDigest: PLAN_CURRENT.recordDigest,
    reviewBinding: {
      kind: 'current_review' as const,
      reviewObligationId: randomUUID(),
      reviewEvidenceDigest: 'b'.repeat(64),
      reviewedSubjectDigest: PLAN_CURRENT.digest,
    },
    ...overrides,
  };
}

function planBlock(overrides: Partial<NonNullable<SessionState['plan']>> = {}) {
  const claimDeclarations = overrides.claimDeclarations ?? declarations();
  return {
    current: PLAN_CURRENT,
    history: [],
    reviewFindings: [],
    reviewCompletion: 'reviewer_accepted' as const,
    ...overrides,
    claimDeclarations,
    approvalCertificate: overrides.approvalCertificate ?? certificate(claimDeclarations),
  };
}

function reducedReadyState(overrides: Partial<SessionState> = {}): SessionState {
  return makeState('EVIDENCE_REVIEW', {
    verificationCandidates: VERIFICATION_CANDIDATES,
    implementation: DOC_IMPL,
    implementationRiskAssessment: RISK_ASSESSMENT,
    activeChecks: ['test', 'lint'],
    implValidation: VALIDATION_PASSED,
    validationAttempts: [attempt('test'), attempt('lint')],
    policySnapshot: POLICY,
    reducedCeremony: DECISION,
    plan: planBlock(),
    ...overrides,
  });
}

describe('materializePostValidationContract — reduced entry (Run-9 F1)', () => {
  it('HAPPY: materializes the approved-plan contract at the reduced EVIDENCE_REVIEW entry', async () => {
    const state = reducedReadyState();

    const materialized = await materializePostValidationContract(state, '/tmp/worktree');

    expect(materialized.proofContract?.claims.map((claim) => claim.claimId)).toEqual([CLAIM_ID]);
    expect(materialized.proofContract?.claims[0]?.provenance).toMatchObject({
      kind: 'canonical_authority',
      authorityId: 'plan',
      digest: PLAN_CURRENT.digest,
    });
    expect(materialized.proofGraph).toBe(state.proofGraph);
  });

  it('HAPPY: repeating the same generation is idempotent', async () => {
    const state = reducedReadyState();
    const first = await materializePostValidationContract(state, '/tmp/worktree');

    const second = await materializePostValidationContract(first, '/tmp/worktree');

    expect(second).toBe(first);
  });

  it('BAD: a foreign pre-gate contract is replaced by the approved-plan materialization', async () => {
    const manualClaim = {
      claimId: randomUUID(),
      statement: 'a manual declaration created before the review gate',
      signalClass: 'hypothesis' as const,
      critical: false,
      provenance: null,
      evidenceRefs: [],
      counterexampleRefs: [],
    };
    const state = reducedReadyState({
      proofContract: { version: 'contract.v2', claims: [manualClaim] },
      proofContractCoverage: [],
    });

    const materialized = await materializePostValidationContract(state, '/tmp/worktree');

    expect(materialized.proofContract?.claims.map((claim) => claim.claimId)).toEqual([CLAIM_ID]);
    expect(materialized.proofContractCoverage).toEqual([]);
  });

  it('BAD: a stale contract from an earlier implementation generation is replaced', async () => {
    // IMPL_REVIEW needs no reduced binding, so the rework generation can be
    // simulated by adding the implementation attempts after the first
    // materialization.
    const withoutAttempts = reducedReadyState({
      phase: 'IMPL_REVIEW',
      validationAttempts: [],
    });
    const first = await materializePostValidationContract(withoutAttempts, '/tmp/worktree');
    expect(first.proofContractCoverage).toEqual([
      { claimId: CLAIM_ID, cause: 'missing_expected_check' },
    ]);
    expect(first.proofContract?.claims[0]?.evidenceRefs).toEqual([
      { kind: 'structural_surface', surfaceId: 'command-registration' },
    ]);

    const withAttempts = {
      ...first,
      validationAttempts: [attempt('test'), attempt('lint')],
    };
    const second = await materializePostValidationContract(withAttempts, '/tmp/worktree');

    expect(second.proofContract).not.toBe(first.proofContract);
    expect(second.proofContract?.claims[0]?.evidenceRefs).toEqual([
      { kind: 'validation_attempt', attemptId: TEST_ATTEMPT_ID },
      { kind: 'structural_surface', surfaceId: 'command-registration' },
    ]);
    expect(second.proofContractCoverage).toEqual([]);
  });

  it('BAD: no contract without the canonical reduced-ceremony binding', async () => {
    const broken = reducedReadyState({
      reducedCeremony: { ...DECISION, policyDigest: 'c'.repeat(64) },
    });

    const materialized = await materializePostValidationContract(broken, '/tmp/worktree');

    expect(materialized).toBe(broken);
    expect(materialized.proofContract).toBeUndefined();
  });

  it('BAD: an invalid certificate with declarations stays blocked, never claimless', async () => {
    const state = reducedReadyState({
      plan: planBlock({
        approvalCertificate: certificate(declarations(), {
          planRecordDigest: 'd'.repeat(64),
        }),
      }),
    });

    const materialized = await materializePostValidationContract(state, '/tmp/worktree');

    expect(materialized.proofContract?.claims).toEqual([]);
    expect(materialized.proofContractCoverage).toEqual([{ cause: 'invalid_certificate' }]);
    const gate = evaluateProofGraphGateFromState(materialized);
    expect(gate.gated).toBe(true);
    expect(gate.kind).toBe('certificate_invalid');
  });

  it('CORNER: a claimless declared plan stays a legitimate empty contract', async () => {
    const state = reducedReadyState({
      plan: planBlock({ claimDeclarations: EMPTY_DECLARATIONS }),
    });

    const materialized = await materializePostValidationContract(state, '/tmp/worktree');

    expect(materialized.proofContract?.claims).toEqual([]);
    expect(materialized.proofContractCoverage).toEqual([{ cause: 'missing_declarations' }]);
    expect(evaluateProofGraphGateFromState(materialized).gated).toBe(false);
  });

  it('CORNER: a non-entry phase is never materialized', async () => {
    const state = reducedReadyState({ phase: 'PLAN' });

    const materialized = await materializePostValidationContract(state, '/tmp/worktree');

    expect(materialized).toBe(state);
    expect(materialized.proofContract).toBeUndefined();
  });
});
