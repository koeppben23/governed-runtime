/**
 * @module fixtures
 * @description Shared test fixtures for the FlowGuard test suite.
 *
 * Provides minimal valid objects for each evidence type and a complete SessionState.
 * All timestamps are fixed for deterministic assertions.
 */

import type { SessionState, Phase } from './state/schema.js';
import type {
  ReviewAssuranceState,
  ReviewAttempt,
  ReviewInvocationEvidence,
  ReviewObligation,
} from './state/evidence-review.js';
import type {
  TicketEvidence,
  ArchitectureDecision,
  PlanEvidence,
  PlanRecord,
  SelfReviewLoop,
  ValidationResult,
  ImplEvidence,
  ImplReviewResult,
  ReviewDecision,
  DecisionIdentity,
  ErrorInfo,
  BindingInfo,
  PolicySnapshot,
} from './state/evidence.js';
import { computeRecordDigest } from './state/evidence-plan.js';
import { POLICY_DIGEST_VERSION } from './shared/policy-digest.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const FIXED_TIME = '2026-01-01T00:00:00.000Z';
export const FIXED_UUID = '00000000-0000-4000-8000-000000000001';
export const FIXED_SESSION_UUID = '00000000-0000-4000-8000-000000000002';
export const FIXED_DIGEST = 'digest-of-test';
export const FIXED_FINGERPRINT = 'a1b2c3d4e5f6a1b2c3d4e5f6';

// ─── Evidence Fixtures ────────────────────────────────────────────────────────

export const BINDING: BindingInfo = {
  sessionId: FIXED_SESSION_UUID,
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
  maxSelfReviewIterations: 3,
  maxImplReviewIterations: 3,
  maxIncoherentReviewerCaptureRetries: 1,
  maxReviewerOutputRepairAttempts: 1,
  allowSelfApproval: true,
  minimumActorAssuranceForApproval: 'best_effort',
  requireVerifiedActorsForApproval: false,
  identityProvider: undefined,
  identityProviderMode: 'optional',
  reviewOutputPolicy: 'text_compat_allowed',
  reviewInvocationPolicy: 'sdk_allowed',
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
  requireVerifiedActorsForApproval: false,
  reviewOutputPolicy: 'structured_required',
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
 * implementation of the `review-assurance.v5` envelope used across test
 * suites; domain-specific obligation/invocation builders stay local to their
 * suites and feed this builder.
 */
export function assuranceWith(input: {
  readonly obligation?: ReviewObligation;
  readonly obligations?: readonly ReviewObligation[];
  readonly invocations?: readonly ReviewInvocationEvidence[];
  readonly attempts?: readonly ReviewAttempt[];
}): ReviewAssuranceState {
  const obligations = input.obligations ?? (input.obligation ? [input.obligation] : []);
  return {
    assuranceSchemaVersion: 'review-assurance.v5',
    obligations: [...obligations],
    invocations: input.invocations ? [...input.invocations] : [],
    attempts: input.attempts ? [...input.attempts] : [],
  };
}

/**
 * Canonical bound architecture review evidence for approve-path tests: a
 * consumed architecture obligation for exactly the ARCHITECTURE_DECISION
 * digest plus its invocation with a findings hash.
 */
export const ARCHITECTURE_REVIEW_ASSURANCE: ReviewAssuranceState = {
  assuranceSchemaVersion: 'review-assurance.v5',
  obligations: [
    {
      obligationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      obligationType: 'architecture',
      iteration: 0,
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
      maxReviewerOutputRepairAttempts: 0,
    },
  ],
  invocations: [
    {
      invocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      obligationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      obligationType: 'architecture',
      parentSessionId: 'parent-session-1',
      childSessionId: 'child-session-1',
      agentType: 'flowguard-reviewer',
      invocationMode: 'host_subagent_task',
      hostVisible: true,
      promptHash: 'prompt-hash-of-architecture-review',
      mandateDigest: 'mandate-digest-of-review-criteria',
      criteriaVersion: 'criteria-v1',
      findingsHash: 'findings-hash-of-architecture-review',
      invokedAt: FIXED_TIME,
      fulfilledAt: FIXED_TIME,
      consumedByObligationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      capturedVerdict: 'accept',
      reviewOutputMode: 'structured_output',
      structuredOutputUsed: true,
      reviewAssuranceLevel: 'structured_high',
    },
  ],
  attempts: [],
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
    subjectDigest: 'digest-of-plan',
    reviewMaterial: {
      content: '## Plan\n1. Fix auth\n2. Add tests',
      materialDigest: 'material-digest-of-plan-review',
      subjectDigest: 'digest-of-plan',
    },
    reviewSubjectScope: {
      kind: 'artifact',
      artifact: {
        kind: 'plan',
        digest: 'digest-of-plan',
        sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'Plan' }]],
      },
    },
    repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
    maxReviewerOutputRepairAttempts: 0,
  },
  invocations: [
    {
      invocationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      obligationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      obligationType: 'plan',
      parentSessionId: 'parent-session-1',
      childSessionId: 'child-session-1',
      agentType: 'flowguard-reviewer',
      invocationMode: 'host_subagent_task',
      hostVisible: true,
      promptHash: 'prompt-hash-of-plan-review',
      mandateDigest: 'mandate-digest-of-plan-review-criteria',
      criteriaVersion: 'criteria-v1',
      findingsHash: 'findings-hash-of-plan-review',
      invokedAt: FIXED_TIME,
      fulfilledAt: FIXED_TIME,
      consumedByObligationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      capturedVerdict: 'accept',
      reviewOutputMode: 'structured_output',
      structuredOutputUsed: true,
      reviewAssuranceLevel: 'structured_high',
    },
  ],
});

export const PLAN_EVIDENCE: PlanEvidence = {
  body: '## Plan\n1. Fix auth\n2. Add tests',
  digest: 'digest-of-plan',
  sections: ['Plan'],
  createdAt: FIXED_TIME,
  recordDigest: computeRecordDigest({
    contentDigest: 'digest-of-plan',
    planVersion: 1,
    supersedesRecordDigest: null,
    originatingReviewObligationId: null,
    revisionReason: null,
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

export const SELF_REVIEW_CONVERGED: SelfReviewLoop = {
  iteration: 1,
  maxIterations: 3,
  prevDigest: null,
  currDigest: 'digest-of-plan',
  revisionDelta: 'none',
  verdict: 'accept',
};

export const SELF_REVIEW_PENDING: SelfReviewLoop = {
  iteration: 1,
  maxIterations: 3,
  prevDigest: null,
  currDigest: 'digest-of-plan',
  revisionDelta: 'minor',
  verdict: 'changes_requested',
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

export const IMPL_REVIEW_CONVERGED: ImplReviewResult = {
  iteration: 1,
  maxIterations: 3,
  prevDigest: null,
  currDigest: 'digest-of-impl',
  revisionDelta: 'none',
  verdict: 'accept',
  executedAt: FIXED_TIME,
};

export const IMPL_REVIEW_PENDING_RESULT: ImplReviewResult = {
  iteration: 1,
  maxIterations: 3,
  prevDigest: null,
  currDigest: 'digest-of-impl',
  revisionDelta: 'minor',
  verdict: 'changes_requested',
  executedAt: FIXED_TIME,
};

export const REVIEW_APPROVE: ReviewDecision = {
  verdict: 'approve',
  rationale: 'LGTM',
  decidedAt: FIXED_TIME,
  decidedBy: 'reviewer-1',
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
  return {
    id: FIXED_UUID,
    schemaVersion: 'v1',
    phase,
    binding: BINDING,
    ticket: null,
    architecture: null,
    plan: null,
    selfReview: null,
    validation: [],
    validationAttempts: [],
    mutationAttempts: [],
    challengeResolutions: [],
    implValidation: [],
    implementation: null,
    reducedCeremony: null,
    implReview: null,
    reviewDecision: null,
    reviewReportPath: null,
    standaloneReviewEvidence: [],
    nextAdrNumber: 1,
    activeProfile: null,
    activeChecks: ['test', 'lint'],
    policySnapshot: POLICY_SNAPSHOT,
    initiatedBy: 'initiator-1',
    initiatedByIdentity: DECISION_IDENTITY_INITIATOR,
    transition: null,
    error: null,
    createdAt: FIXED_TIME,
    ...overrides,
  };
}

/**
 * Create a state that's progressed to a specific phase with appropriate evidence.
 */
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
    case 'COMPLETE':
      return makeState('COMPLETE', {
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
    case 'REVIEW':
      return makeState('REVIEW');
    case 'REVIEW_COMPLETE':
      return makeState('REVIEW_COMPLETE', {
        reviewReportPath: '/tmp/test-repo/.flowguard/sessions/000-test/review-report.json',
      });
  }
}
