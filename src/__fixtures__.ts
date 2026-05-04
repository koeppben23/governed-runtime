/**
 * @module __fixtures__
 * @description Shared test fixtures for the FlowGuard test suite.
 *
 * Provides minimal valid objects for each evidence type and a complete SessionState.
 * All timestamps are fixed for deterministic assertions.
 */

import type { SessionState, Phase } from './state/schema.js';
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
  hash: 'policy-hash-team',
  resolvedAt: FIXED_TIME,
  requestedMode: 'team',
  effectiveGateBehavior: 'human_gated',
  requireHumanGates: true,
  maxSelfReviewIterations: 3,
  maxImplReviewIterations: 3,
  allowSelfApproval: true,
  minimumActorAssuranceForApproval: 'best_effort',
  requireVerifiedActorsForApproval: false,
  identityProvider: undefined,
  identityProviderMode: 'optional',
  audit: {
    emitTransitions: true,
    emitToolCalls: true,
    enableChainHash: true,
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
  createdAt: FIXED_TIME,
  digest: 'digest-of-adr',
};

export const PLAN_EVIDENCE: PlanEvidence = {
  body: '## Plan\n1. Fix auth\n2. Add tests',
  digest: 'digest-of-plan',
  sections: ['Plan'],
  createdAt: FIXED_TIME,
};

export const PLAN_RECORD: PlanRecord = {
  current: PLAN_EVIDENCE,
  history: [],
};

export const SELF_REVIEW_CONVERGED: SelfReviewLoop = {
  iteration: 1,
  maxIterations: 3,
  prevDigest: null,
  currDigest: 'digest-of-plan',
  revisionDelta: 'none',
  verdict: 'approve',
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
  { checkId: 'test_quality', passed: true, detail: 'All tests pass', executedAt: FIXED_TIME },
  { checkId: 'rollback_safety', passed: true, detail: 'Safe to rollback', executedAt: FIXED_TIME },
];

export const VALIDATION_FAILED: ValidationResult[] = [
  { checkId: 'test_quality', passed: false, detail: 'Missing tests', executedAt: FIXED_TIME },
  { checkId: 'rollback_safety', passed: true, detail: 'Safe to rollback', executedAt: FIXED_TIME },
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
  verdict: 'approve',
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
    implementation: null,
    implReview: null,
    reviewDecision: null,
    reviewReportPath: null,
    nextAdrNumber: 1,
    activeProfile: null,
    activeChecks: ['test_quality', 'rollback_safety'],
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
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_CONVERGED,
      });
    case 'VALIDATION':
      return makeState('VALIDATION', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_CONVERGED,
        reviewDecision: REVIEW_APPROVE,
      });
    case 'IMPLEMENTATION':
      return makeState('IMPLEMENTATION', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_CONVERGED,
        reviewDecision: REVIEW_APPROVE,
        validation: VALIDATION_PASSED,
      });
    case 'IMPL_REVIEW':
      return makeState('IMPL_REVIEW', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_CONVERGED,
        reviewDecision: REVIEW_APPROVE,
        validation: VALIDATION_PASSED,
        implementation: IMPL_EVIDENCE,
      });
    case 'EVIDENCE_REVIEW':
      return makeState('EVIDENCE_REVIEW', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_CONVERGED,
        reviewDecision: REVIEW_APPROVE,
        validation: VALIDATION_PASSED,
        implementation: IMPL_EVIDENCE,
        implReview: IMPL_REVIEW_CONVERGED,
      });
    case 'COMPLETE':
      return makeState('COMPLETE', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_CONVERGED,
        reviewDecision: REVIEW_APPROVE,
        validation: VALIDATION_PASSED,
        implementation: IMPL_EVIDENCE,
        implReview: IMPL_REVIEW_CONVERGED,
      });
    case 'ARCHITECTURE':
      return makeState('ARCHITECTURE', {
        architecture: ARCHITECTURE_DECISION,
      });
    case 'ARCH_REVIEW':
      return makeState('ARCH_REVIEW', {
        architecture: ARCHITECTURE_DECISION,
        selfReview: SELF_REVIEW_CONVERGED,
      });
    case 'ARCH_COMPLETE':
      return makeState('ARCH_COMPLETE', {
        architecture: { ...ARCHITECTURE_DECISION, status: 'accepted' },
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
