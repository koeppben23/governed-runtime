/**
 * @module integration/plugin-host-task-diagnostics-helpers
 * @description Shared test factories and constants for plugin-host-task-diagnostics test suites.
 */

import { createSessionState, onFlowGuardToolAfter } from './review/enforcement/enforcement.js';
import { reviewDispatchRequired } from './review/dispatch-signal.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import {
  artifactReviewSubjectScope,
  createReviewObligation,
  freezeReviewMaterial,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from './review/assurance.js';
import type { ReviewAttempt, ReviewObligation } from '../state/evidence.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const NOW = '2026-05-10T12:00:00.000Z';
export const SESSION_ID = 'ses_parent_001';
export const CHILD_SESSION_ID = 'ses_child_001';
const MODE_A_OBLIGATION_ID = '44444444-4444-4444-8444-444444444444';

// ─── Factory Functions ───────────────────────────────────────────────────────

/**
 * Build a Mode A response carrying the structured review-dispatch signal with
 * iteration and planVersion. `obligationId` defaults to a realistic fixture
 * obligation identity so the pending review satisfies the host
 * attestation-constants invariant; pass `null` to deliberately model a signal
 * without obligation/host attestation.
 */
export function modeAResponse(
  iteration = 0,
  planVersion = 1,
  obligationId: string | null = MODE_A_OBLIGATION_ID,
): string {
  return JSON.stringify({
    phase: 'PLAN',
    status: `Plan submitted (v${planVersion}).`,
    selfReviewIteration: iteration,
    reviewMode: 'subagent',
    reviewDispatch: reviewDispatchRequired(),
    ...(obligationId
      ? {
          reviewAttemptId: `att-${obligationId}`,
          reviewObligation: {
            obligationId,
            obligationType: 'plan',
            iteration,
            planVersion,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            mandateDigest: REVIEW_MANDATE_DIGEST,
            requiredChallengeCount: 0,
            requiredChallengeKind: 'design_challenge',
          },
          requiredReviewAttestation: {
            reviewedBy: REVIEWER_SUBAGENT_TYPE,
            mandateDigest: REVIEW_MANDATE_DIGEST,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            toolObligationId: obligationId,
            iteration,
            planVersion,
          },
        }
      : {}),
  });
}

/** Build a substantive prompt for the subagent. */
export function validPrompt(iteration = 0, planVersion = 1): string {
  return (
    `Review this plan critically. The plan proposes implementing a new feature ` +
    `for user authentication with OAuth2 integration. ` +
    `Ticket: PROJ-123 - Add OAuth2 login flow. ` +
    `iteration=${iteration}, planVersion=${planVersion}. ` +
    `Check for completeness, correctness, feasibility, risk, and quality. ` +
    `Return structured ReviewFindings JSON with your assessment.`
  );
}

/** Build task result JSON with strict reviewer-owned findings input. */
export function taskResultWithAttestation(
  obligationId: string,
  opts: {
    childSessionId?: string;
    iteration?: number;
    planVersion?: number;
    verdict?: string;
  } = {},
): string {
  const {
    childSessionId: _childSessionId = CHILD_SESSION_ID,
    iteration = 0,
    planVersion = 1,
    verdict = 'accept',
  } = opts;
  return JSON.stringify({
    iteration,
    planVersion,
    reviewMode: 'subagent',
    overallVerdict: verdict,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    attestation: {
      toolObligationId: obligationId,
    },
  });
}

/** Create a pending obligation with matching iteration/planVersion/mandate/criteria. */
export function pendingObligation(overrides: Partial<ReviewObligation> = {}): ReviewObligation {
  const base = createReviewObligation({
    obligationType: 'plan',
    iteration: 0,
    reviewCycle: 1,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'diagnostics-test-subject',
    reviewMaterial: freezeReviewMaterial('# Diagnostics\nBody', 'diagnostics-test-subject'),
    reviewSubjectScope: artifactReviewSubjectScope(
      'plan',
      '# Diagnostics\nBody',
      'diagnostics-test-subject',
    ),
    changedFiles: ['docs/test.md'],
    policySnapshot: {
      challengePolicy: {
        version: 'challenge-policy.v1',
        counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
      },
      maxReviewerAttempts: 1,
    },
    repositoryAuthority: {
      kind: 'context',
      context: {
        kind: 'commit',
        repositoryIdentity: { host: 'github.com', owner: 'diag', name: 'repo' },
        objectSha: 'a'.repeat(40),
      },
    },
    repositoryEvidenceFreeze: { kind: 'available' },
  });
  return { ...base, ...overrides };
}

/**
 * Build the invocation attempt that production records BEFORE the reviewer
 * subagent runs, already bound to its child session.
 *
 * Binding resolves a callback against this envelope, so a test that exercises a
 * successful bind must provide it exactly as `createObligationAndAttempt` plus
 * the Task-start child-session binding would have produced it.
 */
function attemptFor(
  obligation: ReviewObligation,
  childSessionId: string = CHILD_SESSION_ID,
  overrides: Partial<ReviewAttempt> = {},
): ReviewAttempt {
  return {
    attemptId: `att-${obligation.obligationId}`,
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    subjectDigest: obligation.subjectDigest ?? 'diagnostics-test-subject',
    ordinal: 0,
    childSessionId,
    status: 'created',
    origin: { kind: 'initial' },
    repositoryDiscovery: { kind: 'not_applicable' },
    observations: [],
    createdAt: NOW,
    ...overrides,
  };
}

/**
 * Set up a structured-review requirement and its corresponding attempt fixture.
 */
export function setupFullCycle(
  opts: {
    obligationId?: string;
    childSessionId?: string;
    iteration?: number;
    planVersion?: number;
  } = {},
) {
  const {
    obligationId: customObligationId,
    childSessionId = CHILD_SESSION_ID,
    iteration = 0,
    planVersion = 1,
  } = opts;

  const state = createSessionState();
  // Step 1: Mode A — FlowGuard tool carries the review-dispatch signal
  onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(iteration, planVersion), NOW);

  const obligation = pendingObligation({
    ...(customObligationId ? { obligationId: customObligationId } : {}),
    iteration,
    planVersion,
  });

  return { state, obligation, attempts: [attemptFor(obligation, childSessionId)] };
}
