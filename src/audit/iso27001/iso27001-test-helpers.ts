/**
 * @module audit/iso27001/iso27001-test-helpers
 * @description Shared fixtures for the ISO/IEC 27001:2022 projection tests.
 *
 * Test scaffolding only: production code must never import this module.
 */

import {
  FIXED_TIME,
  IMPL_EVIDENCE,
  makePlanApprovalCertificate,
  makeProgressedState,
  REVIEW_APPROVE,
  type PlanApprovalCertificateOverrides,
} from '../../fixtures.js';
import { createDecisionEvent } from '../event-builders.js';
import { GENESIS_HASH } from '../types.js';
import { getLastChainHash } from '../integrity.js';
import { decisionReceipts } from '../query.js';
import { stampChainSequence } from '../audit-test-helpers.js';
import type { AuditEvent, ReviewAssuranceState, ReviewFindings } from '../../state/evidence.js';
import type {
  AssertionExtractionResult,
  ValidationAttempt,
} from '../../state/evidence-validation.js';
import type { ReviewVerdict } from '../../state/evidence-primitives.js';
import type { SessionState } from '../../state/schema.js';
import {
  VERIFIED_ARCHIVE_SNAPSHOT,
  type LiveExportBinding,
  type VerifiedEvidenceSnapshot,
} from './evidence.js';
import type { SelectorContext } from './selectors.js';

const TEST_PACKAGE_SHA256 = 'a'.repeat(64);
const TEST_SIDECAR_SHA256 = 'a'.repeat(64);
const TEST_CONTENT_DIGEST = 'b'.repeat(64);
const TEST_OBLIGATION_ID = '00000000-0000-4000-8000-000000000765';
export const TEST_ATTEMPT_ID = '00000000-0000-4000-8000-000000000766';

/**
 * Canonical ISO fixture state: an EXPORT_READY session with a current plan
 * approval certificate, digest-bound implementation risk assessment, one
 * supported implementation attempt, and a bound implementation review. Tests
 * override exactly the field they exercise.
 */
export function makeIsoState(overrides: Partial<SessionState> = {}): SessionState {
  const base: SessionState = { ...makeProgressedState('EXPORT_READY'), ...overrides };
  const plan = base.plan;
  if (plan === null || overrides.plan !== undefined || plan.approvalCertificate !== undefined) {
    return base;
  }
  return {
    ...base,
    plan: { ...plan, approvalCertificate: makePlanApprovalCertificate(base) },
  };
}

/**
 * Attach a current approval certificate to an arbitrary fixture state (after
 * plan-level overrides such as claim declarations have been applied).
 */
export function withPlanCertificate(
  state: SessionState,
  overrides: PlanApprovalCertificateOverrides = {},
): SessionState {
  const plan = state.plan;
  if (plan === null) return state;
  return {
    ...state,
    plan: { ...plan, approvalCertificate: makePlanApprovalCertificate(state, overrides) },
  };
}

/** Canonical supported implementation attempt with structured assertions. */
export function makeAssertionExtraction(input: {
  readonly attemptId: string;
  readonly localId: string;
  readonly status: 'passed' | 'failed' | 'errored' | 'skipped';
}): Extract<AssertionExtractionResult, { status: 'extracted' }> {
  const passed = input.status === 'passed' ? 1 : 0;
  const failed = input.status === 'failed' || input.status === 'errored' ? 1 : 0;
  const skipped = input.status === 'skipped' ? 1 : 0;
  return {
    status: 'extracted',
    attemptId: input.attemptId,
    providerId: 'vitest',
    format: 'vitest_json',
    bindingCapability: 'assertion',
    reportDigests: ['e'.repeat(64)],
    assertions: [
      {
        assertion: { providerId: 'vitest', localId: input.localId },
        providerId: 'vitest',
        status: input.status,
        testName: `security regression ${input.localId}`,
      },
    ],
    summary: {
      assertionCount: 1,
      passedCount: passed,
      failedCount: failed,
      erroredCount: 0,
      skippedCount: skipped,
      suiteInfrastructureError: false,
    },
  };
}

/** Canonical supported post-implementation attempt bound to the fixture impl. */
export function makeImplementationAttempt(input: {
  readonly attemptId?: string;
  readonly checkId?: string;
  readonly extraction?: AssertionExtractionResult;
  readonly passed?: boolean;
  readonly outcome?: 'supported' | 'inconclusive' | 'blocked';
  readonly timedOut?: boolean;
  readonly implementationDigest?: string;
}): ValidationAttempt {
  const attemptId = input.attemptId ?? TEST_ATTEMPT_ID;
  const extraction = input.extraction;
  return {
    attemptId,
    scope: 'implementation',
    implementationId: IMPL_EVIDENCE.implementationId,
    implementationDigest: input.implementationDigest ?? IMPL_EVIDENCE.digest,
    executionObservation: {
      executionObservedStateDigest: 'f'.repeat(64),
      preCommitStateDigest: 'f'.repeat(64),
    },
    result: {
      checkId: input.checkId ?? 'test',
      passed: input.passed ?? true,
      detail: 'fixture',
      executedAt: FIXED_TIME,
      kind: 'test',
      command: 'npm test',
      exitCode: input.passed === false ? 1 : 0,
      executionMs: 1000,
      outputDigest: '1'.repeat(64),
      timedOut: input.timedOut ?? false,
      outcome: input.outcome ?? 'supported',
      ...(extraction !== undefined ? { assertionExtraction: extraction } : {}),
    },
  };
}

/** Accepted independent findings bound to the current implementation digest. */
export function makeBoundImplFindings(implementationDigest: string): {
  findings: ReviewFindings;
  assurance: ReviewAssuranceState;
} {
  const findings: ReviewFindings = {
    iteration: 1,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'child-session-1' },
    reviewedAt: FIXED_TIME,
    attestation: {
      mandateDigest: 'mandate-digest',
      criteriaVersion: 'criteria-v1',
      toolObligationId: TEST_OBLIGATION_ID,
      iteration: 1,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
    },
    challenges: [],
  };
  const assurance: ReviewAssuranceState = {
    assuranceSchemaVersion: 'review-assurance.v7',
    obligations: [],
    invocations: [],
    attempts: [
      {
        attemptId: TEST_ATTEMPT_ID,
        obligationId: TEST_OBLIGATION_ID,
        obligationType: 'implement',
        subjectDigest: implementationDigest,
        ordinal: 0,
        status: 'bound',
        origin: { kind: 'initial' },
        repositoryDiscovery: { kind: 'not_applicable' },
        observations: [],
        createdAt: FIXED_TIME,
        completedAt: FIXED_TIME,
      },
    ],
    dispatches: [],
  };
  return { findings, assurance };
}

/** A valid single-event decision trail for receipt matching. */
export function makeDecisionTrail(input: {
  readonly flowguardSessionId: string;
  readonly gatePhase: 'PLAN_REVIEW' | 'EVIDENCE_REVIEW' | 'ARCH_REVIEW';
  readonly verdict: ReviewVerdict;
  readonly decidedAt?: string;
  readonly decisionId?: string;
  readonly actorId?: string;
}): AuditEvent[] {
  const decidedAt = input.decidedAt ?? FIXED_TIME;
  const event = createDecisionEvent({
    flowguardSessionId: input.flowguardSessionId,
    gatePhase: input.gatePhase,
    occurredAt: decidedAt,
    actor: 'human',
    prevHash: GENESIS_HASH,
    detail: {
      decisionId: input.decisionId ?? 'decision-1',
      decisionSequence: 1,
      verdict: input.verdict,
      rationale: 'fixture rationale',
      decidedAt,
      decisionIdentity: {
        ...REVIEW_APPROVE.decisionIdentity,
        actorId: input.actorId ?? REVIEW_APPROVE.decisionIdentity.actorId,
      },
      fromPhase: 'EVIDENCE_REVIEW',
      toPhase: 'COMPLETE',
      transitionEvent: 'APPROVE',
      transitionAt: decidedAt,
      policyMode: 'team',
    },
  });
  return [stampChainSequence(event, 1)];
}

/** Verified-snapshot fixture over the given state and audit trail. */
export function makeVerifiedSnapshot(
  state: SessionState,
  events: readonly AuditEvent[] = [],
): VerifiedEvidenceSnapshot {
  return {
    integrity: VERIFIED_ARCHIVE_SNAPSHOT,
    sessionId: state.binding.hostSessionId,
    fingerprint: state.binding.fingerprint,
    packageSha256: TEST_PACKAGE_SHA256,
    sidecarSha256: TEST_SIDECAR_SHA256,
    manifestContentDigest: TEST_CONTENT_DIGEST,
    manifestSchemaVersion: 'archive-manifest.v4',
    manifestPolicyMode: state.policySnapshot.mode,
    auditChainHead: getLastChainHash([...events]),
    auditEventCount: events.length,
    fileDigests: {
      'state/session-state.json': 'c'.repeat(64),
      'audit/audit.jsonl': 'd'.repeat(64),
    },
    state,
    events,
  };
}

export const MATCHING_LIVE_BINDING: LiveExportBinding = {
  stateAvailable: true,
  exportCompletionPackageDigest: TEST_PACKAGE_SHA256,
  exportMaterializedEvent: true,
};

/** Selector context with canonical receipts derived from the snapshot events. */
export function makeSelectorContext(
  snapshot: VerifiedEvidenceSnapshot,
  liveBinding: LiveExportBinding = MATCHING_LIVE_BINDING,
): SelectorContext {
  let receipts: SelectorContext['receipts'] = [];
  let receiptsReadable = true;
  try {
    receipts = decisionReceipts([...snapshot.events]);
  } catch {
    receiptsReadable = false;
  }
  return { snapshot, liveBinding, receipts, receiptsReadable };
}
