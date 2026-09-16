/**
 * @module fixtures
 * @description Shared test fixtures for the FlowGuard test suite.
 *
 * Provides minimal valid objects for each evidence type and a complete SessionState.
 * All timestamps are fixed for deterministic assertions.
 */

import {
  CURRENT_ASSURANCE_EPOCH,
  CURRENT_AUDIT_CHAIN_FORMAT,
  CURRENT_SESSION_STATE_SCHEMA_VERSION,
  CURRENT_STATE_DIGEST_FORMAT,
  type SessionState,
  type Phase,
} from './state/schema.js';
import {
  REVIEW_ASSURANCE_SCHEMA_VERSION,
  type ReviewAssuranceState,
  type ReviewAttempt,
  type ReviewInvocationEvidence,
  type ReviewObligation,
} from './state/evidence-review.js';
import type {
  TicketEvidence,
  ArchitectureDecision,
  PlanEvidence,
  PlanRecord,
  ValidationResult,
  ImplEvidence,
  ReviewDecision,
  DecisionIdentity,
  ErrorInfo,
  BindingInfo,
  PolicySnapshot,
} from './state/evidence.js';
import { IMPL_REVIEW_CONVERGED, SELF_REVIEW_CONVERGED } from './state/evidence-test-constants.js';
import { computeRecordDigest } from './state/evidence-plan.js';
import { POLICY_DIGEST_VERSION } from './shared/policy-digest.js';
import { canonicalJsonStringify } from './shared/canonical-json.js';
import { hashText } from './shared/hashing.js';

export {
  IMPL_REVIEW_CONVERGED,
  IMPL_REVIEW_PENDING_RESULT,
  SELF_REVIEW_CONVERGED,
  SELF_REVIEW_PENDING,
} from './state/evidence-test-constants.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const FIXED_TIME = '2026-01-01T00:00:00.000Z';
export const FIXED_UUID = '00000000-0000-4000-8000-000000000001';
export const FIXED_SESSION_UUID = '00000000-0000-4000-8000-000000000002';
export const FIXED_DIGEST = 'digest-of-test';
export const FIXED_FINGERPRINT = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const PLAN_DIGEST = hashText('## Plan\n1. Fix auth\n2. Add tests');

// ─── Evidence Fixtures ────────────────────────────────────────────────────────

export const BINDING: BindingInfo = {
  hostSessionId: FIXED_SESSION_UUID,
  worktree: '/tmp/test-repo',
  fingerprint: FIXED_FINGERPRINT,
  resolvedAt: FIXED_TIME,
};

export const POLICY_SNAPSHOT: PolicySnapshot = {
  mode: 'team',
  hash: 'a'.repeat(64),
  hashVersion: POLICY_DIGEST_VERSION,
  resolvedAt: FIXED_TIME,
  requestedMode: 'team',
  effectiveGateBehavior: 'human_gated',
  requireHumanGates: true,
  reviewBudget: { plan: 3, architecture: 3, implementation: 3 },
  maxIncoherentReviewerCaptureRetries: 1,
  maxReviewerAttempts: 1,
  allowSelfApproval: true,
  minimumActorAssuranceForApproval: 'best_effort',
  identityProvider: undefined,
  identityProviderMode: 'optional',
  reviewProfile: 'core',
  challengePolicy: {
    version: 'challenge-policy.v1',
    counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
  },
  enforceRiskClassification: false,
  allowRiskDowngradeOverride: false,
  allowReducedCeremony: false,
  discoveryHealth: { enforcement: 'off', onDegraded: 'allow', onDrift: 'allow' },
  validationEvidence: { enforcement: 'off', allowNoCommands: false },
  audit: {
    emitTransitions: true,
    emitToolCalls: true,
    enableChainHash: true,
    timestampAssurance: {
      enabled: false,
      mode: 'local_only',
      strict: false,
      criticalEvents: ['decision', 'lifecycle'],
      ntpServers: ['pool.ntp.org'],
      ntpDriftThresholdMs: 30000,
      tsaTimeoutMs: 10000,
    },
  },
  actorClassification: {
    flowguard_decision: 'human',
  },
};

export const REGULATED_POLICY_SNAPSHOT: PolicySnapshot = {
  ...POLICY_SNAPSHOT,
  mode: 'regulated',
  requestedMode: 'regulated',
  allowSelfApproval: false,
  minimumActorAssuranceForApproval: 'best_effort',
  enforceRiskClassification: true,
};

export const DECISION_IDENTITY_INITIATOR: DecisionIdentity = {
  actorId: 'initiator-1',
  actorEmail: 'initiator@test.com',
  actorSource: 'env',
  actorAssurance: 'best_effort',
};

export const DECISION_IDENTITY_REVIEWER: DecisionIdentity = {
  actorId: 'reviewer-1',
  actorEmail: 'reviewer@test.com',
  actorSource: 'env',
  actorAssurance: 'best_effort',
};

export const DECISION_IDENTITY_VERIFIED_REVIEWER: DecisionIdentity = {
  actorId: 'verified-reviewer-1',
  actorEmail: 'verified@test.com',
  actorSource: 'claim',
  actorAssurance: 'claim_validated',
};

export const TICKET: TicketEvidence = {
  text: 'Fix the auth bug in login.ts',
  digest: 'digest-of-ticket',
  source: 'user',
  createdAt: FIXED_TIME,
};

export const ARCHITECTURE_DECISION: ArchitectureDecision = {
  id: 'ADR-1',
  title: 'Use PostgreSQL for primary storage',
  adrText:
    '## Context\nWe need a database.\n\n## Decision\nUse PostgreSQL.\n\n## Consequences\nMust maintain DB infra.',
  status: 'proposed',
  reviewCompletion: 'pending',
  createdAt: FIXED_TIME,
  digest: 'digest-of-adr',
};

/**
 * Canonical review-assurance envelope builder: one obligation (or an explicit
 * obligation list) plus optional invocations and attempts. The single
 * implementation of the `review-assurance.v6` envelope used across test
 * suites; domain-specific obligation/invocation builders stay local to their
 * suites and feed this builder.
 */
export function assuranceWith(input: {
  readonly obligation?: ReviewObligation;
  readonly obligations?: readonly ReviewObligation[];
  readonly invocations?: readonly ReviewInvocationEvidence[];
  readonly attempts?: readonly ReviewAttempt[];
  readonly dispatches?: ReviewAssuranceState['dispatches'];
}): ReviewAssuranceState {
  const obligations = input.obligations ?? (input.obligation ? [input.obligation] : []);
  return {
    assuranceSchemaVersion: REVIEW_ASSURANCE_SCHEMA_VERSION,
    obligations: [...obligations],
    invocations: input.invocations ? [...input.invocations] : [],
    attempts: input.attempts ? [...input.attempts] : [],
    dispatches: input.dispatches ? [...input.dispatches] : [],
  };
}

/**
 * Host-observed capture record for the canonical bound review fixtures. The
 * captured structured findings are the only findings authority in the current
 * contract; `capturedFindingsHash` is the canonical findings hash over exactly
 * this record (hashFindings normalizes finding arrays, which are empty here).
 */
function capturedFindingsFor(input: {
  iteration: number;
  planVersion: number;
  sessionId: string;
}): Record<string, unknown> {
  return {
    iteration: input.iteration,
    planVersion: input.planVersion,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: input.sessionId },
    reviewedAt: FIXED_TIME,
    challenges: [],
  };
}

function capturedFindingsHash(findings: Record<string, unknown>): string {
  return hashText(canonicalJsonStringify(findings));
}

const ARCHITECTURE_REVIEW_CAPTURED_FINDINGS = capturedFindingsFor({
  iteration: 0,
  planVersion: 1,
  sessionId: 'child-session-1',
});

const PLAN_REVIEW_CAPTURED_FINDINGS = capturedFindingsFor({
  iteration: 0,
  planVersion: 1,
  sessionId: 'child-session-1',
});

/**
 * Canonical bound architecture review evidence for approve-path tests: a
 * consumed architecture obligation for exactly the ARCHITECTURE_DECISION
 * digest plus its invocation with a host-captured findings record.
 */
export const ARCHITECTURE_REVIEW_ASSURANCE: ReviewAssuranceState = {
  assuranceSchemaVersion: REVIEW_ASSURANCE_SCHEMA_VERSION,
  obligations: [
    {
      obligationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      obligationType: 'architecture',
      iteration: 0,
      reviewCycle: 1,
      planVersion: 1,
      criteriaVersion: 'criteria-v1',
      mandateDigest: 'mandate-digest-of-review-criteria',
      createdAt: FIXED_TIME,
      pluginHandshakeAt: null,
      status: 'consumed',
      invocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      blockedCode: null,
      fulfilledAt: FIXED_TIME,
      consumedAt: FIXED_TIME,
      subjectDigest: ARCHITECTURE_DECISION.digest,
      reviewProfile: 'core',
      profileSource: 'policy_default',
      requiredChallengeCount: 0,
      requiredChallengeKind: 'design_challenge',
      challengePolicyVersion: 'challenge-policy.v1',
      reviewMaterial: {
        content: ARCHITECTURE_DECISION.adrText,
        materialDigest: 'material-digest-of-architecture-review',
        subjectDigest: ARCHITECTURE_DECISION.digest,
      },
      reviewSubjectScope: {
        kind: 'artifact',
        artifact: {
          kind: 'adr',
          digest: ARCHITECTURE_DECISION.digest,
          sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'ADR' }]],
        },
      },
      repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
      maxReviewerAttempts: 0,
    },
  ],
  invocations: [
    {
      invocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      obligationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      obligationType: 'architecture',
      parentSessionId: 'parent-session-1',
      source: 'host-orchestrated',
      childSessionId: 'child-session-1',
      agentType: 'flowguard-reviewer',
      invocationMode: 'sdk_session_prompt',
      hostVisible: false,
      promptHash: 'a'.repeat(64),
      mandateDigest: 'mandate-digest-of-review-criteria',
      criteriaVersion: 'criteria-v1',
      findingsHash: capturedFindingsHash(ARCHITECTURE_REVIEW_CAPTURED_FINDINGS),
      invokedAt: FIXED_TIME,
      fulfilledAt: FIXED_TIME,
      consumedByObligationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      capturedVerdict: 'accept',
      capturedRawFindings: ARCHITECTURE_REVIEW_CAPTURED_FINDINGS,
      reviewOutputMode: 'structured_output',
      structuredOutputUsed: true,
      reviewAssuranceLevel: 'structured_high',
    },
  ],
  attempts: [
    {
      attemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      obligationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      obligationType: 'architecture',
      subjectDigest: ARCHITECTURE_DECISION.digest,
      ordinal: 0,
      childSessionId: 'child-session-1',
      status: 'bound',
      origin: { kind: 'initial' },
      repositoryDiscovery: { kind: 'not_applicable' },
      observations: [],
      createdAt: FIXED_TIME,
      completedAt: FIXED_TIME,
    },
  ],
  dispatches: [
    {
      dispatchId: '99999999-9999-4999-8999-999999999999',
      attemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      obligationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      hostCallId: 'child-session-1',
      canonicalPromptDigest: 'a'.repeat(64),
      dispatchAuthorizedAt: FIXED_TIME,
      dispatchStatus: 'completed',
      completedAt: FIXED_TIME,
    },
  ],
};

/**
 * Canonical bound plan review evidence for approve-path tests: a consumed plan
 * obligation for exactly the current plan digest plus its invocation with an
 * explicit `accept` captured verdict and canonical invocation linkage.
 */
export const PLAN_REVIEW_ASSURANCE: ReviewAssuranceState = assuranceWith({
  obligation: {
    obligationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    obligationType: 'plan',
    iteration: 0,
    reviewCycle: 1,
    planVersion: 1,
    criteriaVersion: 'criteria-v1',
    mandateDigest: 'mandate-digest-of-plan-review-criteria',
    createdAt: FIXED_TIME,
    pluginHandshakeAt: null,
    status: 'consumed',
    invocationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    blockedCode: null,
    fulfilledAt: FIXED_TIME,
    consumedAt: FIXED_TIME,
    subjectDigest: PLAN_DIGEST,
    reviewProfile: 'core',
    profileSource: 'policy_default',
    // Bound to the (empty) claim declaration set of PLAN_RECORD: the plan
    // approval gate fails closed when evidence carries no claim binding.
    claimDeclarationsDigest: hashText(
      canonicalJsonStringify({ flow: 'plan', version: 'v2', claims: [] }),
    ),
    requiredChallengeCount: 0,
    requiredChallengeKind: 'design_challenge',
    challengePolicyVersion: 'challenge-policy.v1',
    reviewMaterial: {
      content: '## Plan\n1. Fix auth\n2. Add tests',
      materialDigest: 'material-digest-of-plan-review',
      subjectDigest: PLAN_DIGEST,
    },
    reviewSubjectScope: {
      kind: 'artifact',
      artifact: {
        kind: 'plan',
        digest: PLAN_DIGEST,
        sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'Plan' }]],
      },
    },
    repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
    maxReviewerAttempts: 0,
  },
  invocations: [
    {
      invocationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      attemptId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      obligationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      obligationType: 'plan',
      parentSessionId: 'parent-session-1',
      source: 'host-orchestrated',
      childSessionId: 'child-session-1',
      agentType: 'flowguard-reviewer',
      invocationMode: 'sdk_session_prompt',
      hostVisible: false,
      promptHash: 'b'.repeat(64),
      mandateDigest: 'mandate-digest-of-plan-review-criteria',
      criteriaVersion: 'criteria-v1',
      findingsHash: capturedFindingsHash(PLAN_REVIEW_CAPTURED_FINDINGS),
      invokedAt: FIXED_TIME,
      fulfilledAt: FIXED_TIME,
      consumedByObligationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      capturedVerdict: 'accept',
      capturedRawFindings: PLAN_REVIEW_CAPTURED_FINDINGS,
      reviewOutputMode: 'structured_output',
      structuredOutputUsed: true,
      reviewAssuranceLevel: 'structured_high',
    },
  ],
  attempts: [
    {
      attemptId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      obligationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      obligationType: 'plan',
      subjectDigest: PLAN_DIGEST,
      ordinal: 0,
      childSessionId: 'child-session-1',
      status: 'bound',
      origin: { kind: 'initial' },
      repositoryDiscovery: { kind: 'not_applicable' },
      observations: [],
      createdAt: FIXED_TIME,
      completedAt: FIXED_TIME,
    },
  ],
  dispatches: [
    {
      dispatchId: '88888888-8888-4888-8888-888888888888',
      attemptId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      obligationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      hostCallId: 'child-session-1',
      canonicalPromptDigest: 'b'.repeat(64),
      dispatchAuthorizedAt: FIXED_TIME,
      dispatchStatus: 'completed',
      completedAt: FIXED_TIME,
    },
  ],
});

export const PLAN_EVIDENCE: PlanEvidence = {
  body: '## Plan\n1. Fix auth\n2. Add tests',
  digest: PLAN_DIGEST,
  sections: ['Plan'],
  createdAt: FIXED_TIME,
  revisionId: FIXED_UUID,
  recordDigest: computeRecordDigest({
    contentDigest: PLAN_DIGEST,
    planVersion: 1,
    supersedesRecordDigest: null,
    originatingReviewObligationId: null,
    revisionReason: null,
    revisionId: FIXED_UUID,
  }),
  planVersion: 1,
  supersedesRecordDigest: null,
  originatingReviewObligationId: null,
  revisionReason: null,
  lineageStatus: 'verified',
};

export const PLAN_RECORD: PlanRecord = {
  current: PLAN_EVIDENCE,
  history: [],
  reviewCompletion: 'pending',
};

export const VALIDATION_PASSED: ValidationResult[] = [
  {
    checkId: 'test',
    passed: true,
    detail: 'All tests pass',
    executedAt: FIXED_TIME,
    kind: 'test',
    command: 'npm test',
    exitCode: 0,
    executionMs: 1200,
    outputDigest: 'a'.repeat(64),
    timedOut: false,
    outcome: 'supported',
  },
  {
    checkId: 'lint',
    passed: true,
    detail: 'No lint errors',
    executedAt: FIXED_TIME,
    kind: 'lint',
    command: 'npm run lint',
    exitCode: 0,
    executionMs: 800,
    outputDigest: 'b'.repeat(64),
    timedOut: false,
    outcome: 'supported',
  },
];

export const VALIDATION_FAILED: ValidationResult[] = [
  {
    checkId: 'test',
    passed: false,
    detail: 'Tests failed: 3 failing',
    executedAt: FIXED_TIME,
    kind: 'test',
    command: 'npm test',
    exitCode: 1,
    executionMs: 2000,
    outputDigest: 'c'.repeat(64),
    timedOut: false,
    outcome: 'inconclusive',
  },
  {
    checkId: 'lint',
    passed: true,
    detail: 'No lint errors',
    executedAt: FIXED_TIME,
    kind: 'lint',
    command: 'npm run lint',
    exitCode: 0,
    executionMs: 800,
    outputDigest: 'd'.repeat(64),
    timedOut: false,
    outcome: 'supported',
  },
];

export const IMPL_EVIDENCE: ImplEvidence = {
  changedFiles: ['src/auth.ts', 'src/auth.test.ts'],
  domainFiles: ['src/auth.ts'],
  digest: 'digest-of-impl',
  executedAt: FIXED_TIME,
};

export const REVIEW_APPROVE: ReviewDecision = {
  verdict: 'approve',
  rationale: 'LGTM',
  decidedAt: FIXED_TIME,
  decisionIdentity: DECISION_IDENTITY_REVIEWER,
};

export const ERROR_INFO: ErrorInfo = {
  code: 'TOOL_ERROR',
  message: 'Something went wrong',
  recoveryHint: 'Retry the operation',
  occurredAt: FIXED_TIME,
};

/**
 * Synthetic frozen pre-mutation implementation base for progressed fixtures.
 * The persistence boundary refuses IMPLEMENTATION-phase states without a
 * frozen base authority; progressed states (VALIDATION and beyond in the
 * ticket flow) therefore carry this deterministic commit-kind target.
 */
export const FROZEN_IMPLEMENTATION_BASE = {
  kind: 'commit' as const,
  repositoryIdentity: {
    kind: 'local' as const,
    rootCommitDigest: 'sha256:' + 'f'.repeat(64),
  },
  objectSha: 'd'.repeat(40),
};

// ─── State Factory ────────────────────────────────────────────────────────────

/**
 * Create a minimal valid SessionState at any phase.
 * Override fields via the partial parameter.
 */
export function makeState(
  phase: Phase = 'READY',
  overrides: Partial<SessionState> = {},
): SessionState {
  const id = overrides.id ?? FIXED_UUID;
  return {
    id,
    flowguardSessionId: overrides.flowguardSessionId ?? id,
    schemaVersion: CURRENT_SESSION_STATE_SCHEMA_VERSION,
    assuranceEpoch: CURRENT_ASSURANCE_EPOCH,
    stateDigestFormat: CURRENT_STATE_DIGEST_FORMAT,
    runtimeLease: null,
    auditChainFormat: CURRENT_AUDIT_CHAIN_FORMAT,
    phase,
    binding: BINDING,
    ticket: null,
    architecture: null,
    plan: null,
    selfReview: null,
    validation: [],
    validationAttempts: [],
    mutationAttempts: [],
    mutationEpisodes: [],
    mutationEpisodeResolutions: [],
    challengeResolutions: [],
    implValidation: [],
    implementation: null,
    implementationRework: null,
    reducedCeremony: null,
    implReview: null,
    reviewCycles: { plan: 1, architecture: 1, implementation: 1 },
    reviewDecision: null,
    reviewReportPath: null,
    peerReviewEvidence: [],
    nextAdrNumber: 1,
    activeProfile: null,
    activeChecks: ['test', 'lint'],
    policySnapshot: POLICY_SNAPSHOT,
    initiatedBy: 'initiator-1',
    initiatedByIdentity: DECISION_IDENTITY_INITIATOR,
    transition: null,
    pendingAuditOperations: [],
    error: null,
    createdAt: FIXED_TIME,
    exportCompletionEvidence: null,
    regulatedArchiveStatus: null,
    ...overrides,
  };
}
export function makeProgressedState(phase: Phase): SessionState {
  switch (phase) {
    case 'READY':
      return makeState('READY');
    case 'TICKET':
      return makeState('TICKET');
    case 'PLAN':
      return makeState('PLAN', { ticket: TICKET, plan: PLAN_RECORD });
    case 'PLAN_REVIEW':
      return makeState('PLAN_REVIEW', {
        ticket: TICKET,
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
        selfReview: SELF_REVIEW_CONVERGED,
        reviewAssurance: PLAN_REVIEW_ASSURANCE,
      });
    case 'VALIDATION':
      return makeState('VALIDATION', {
        implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_CONVERGED,
        reviewDecision: REVIEW_APPROVE,
      });
    case 'IMPLEMENTATION':
      return makeState('IMPLEMENTATION', {
        implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_CONVERGED,
        reviewDecision: REVIEW_APPROVE,
        validation: VALIDATION_PASSED,
      });
    case 'IMPL_VALIDATION':
      return makeState('IMPL_VALIDATION', {
        implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_CONVERGED,
        reviewDecision: REVIEW_APPROVE,
        validation: VALIDATION_PASSED,
        implementation: IMPL_EVIDENCE,
        // Just entered IMPL_VALIDATION; post-impl checks not yet re-run (awaiting /check).
        implValidation: [],
      });
    case 'IMPL_REVIEW':
      return makeState('IMPL_REVIEW', {
        implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_CONVERGED,
        reviewDecision: REVIEW_APPROVE,
        validation: VALIDATION_PASSED,
        implementation: IMPL_EVIDENCE,
        implValidation: VALIDATION_PASSED,
      });
    case 'EVIDENCE_REVIEW':
      return makeState('EVIDENCE_REVIEW', {
        implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_CONVERGED,
        reviewDecision: REVIEW_APPROVE,
        validation: VALIDATION_PASSED,
        implementation: IMPL_EVIDENCE,
        implValidation: VALIDATION_PASSED,
        implReview: IMPL_REVIEW_CONVERGED,
      });
    case 'EXPORT_READY':
    case 'COMPLETE':
      return makeState(phase, {
        implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_CONVERGED,
        reviewDecision: REVIEW_APPROVE,
        validation: VALIDATION_PASSED,
        implementation: IMPL_EVIDENCE,
        implValidation: VALIDATION_PASSED,
        implReview: IMPL_REVIEW_CONVERGED,
      });
    case 'REJECTED':
    case 'ABORTED':
      return makeState(phase);
    case 'ARCHITECTURE':
      return makeState('ARCHITECTURE', {
        architecture: ARCHITECTURE_DECISION,
      });
    case 'ARCH_REVIEW':
      return makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'reviewer_accepted' },
        selfReview: SELF_REVIEW_CONVERGED,
        reviewAssurance: ARCHITECTURE_REVIEW_ASSURANCE,
      });
    case 'ARCH_COMPLETE':
      return makeState('ARCH_COMPLETE', {
        architecture: {
          ...ARCHITECTURE_DECISION,
          status: 'accepted',
          reviewCompletion: 'reviewer_accepted',
        },
        selfReview: SELF_REVIEW_CONVERGED,
        reviewDecision: REVIEW_APPROVE,
      });
    case 'PEER_REVIEW':
      return makeState('PEER_REVIEW');
    case 'PEER_REVIEW_COMPLETE':
      return makeState('PEER_REVIEW_COMPLETE', {
        reviewReportPath: '/tmp/test-repo/.flowguard/sessions/000-test/review-report.json',
      });
  }
}
