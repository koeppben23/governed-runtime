/**
 * @module integration/plugin-host-task-diagnostics-helpers
 * @description Shared test factories and constants for plugin-host-task-diagnostics test suites.
 */

import {
  createSessionState,
  onFlowGuardToolAfter,
  onTaskToolAfter,
} from './review/enforcement/enforcement.js';
import { REVIEW_REQUIRED_PREFIX, REVIEWER_SUBAGENT_TYPE } from './review/enforcement/types.js';
import {
  createReviewObligation,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from './review/assurance.js';
import type { ReviewObligation } from '../state/evidence.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const NOW = '2026-05-10T12:00:00.000Z';
export const LATER = '2026-05-10T12:01:00.000Z';
export const SESSION_ID = 'ses_parent_001';
export const CHILD_SESSION_ID = 'ses_child_001';

// ─── Factory Functions ───────────────────────────────────────────────────────

/** Build a Mode A response with INDEPENDENT_REVIEW_REQUIRED containing iteration and planVersion. */
export function modeAResponse(iteration = 0, planVersion = 1): string {
  return JSON.stringify({
    phase: 'PLAN',
    status: `Plan submitted (v${planVersion}).`,
    selfReviewIteration: iteration,
    reviewMode: 'subagent',
    next:
      `${REVIEW_REQUIRED_PREFIX}: Call the flowguard-reviewer subagent via Task tool. ` +
      `Use subagent_type "flowguard-reviewer" with a prompt that includes: ` +
      `(1) the full plan text, (2) the ticket text, (3) iteration=${iteration}, ` +
      `(4) planVersion=${planVersion}.`,
  });
}

/** Build a substantive prompt for the subagent (meets MIN_SUBAGENT_PROMPT_LENGTH). */
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

/** Build task result JSON with review findings including attestation. */
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
    childSessionId = CHILD_SESSION_ID,
    iteration = 0,
    planVersion = 1,
    verdict = 'approve',
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
    reviewedBy: { sessionId: childSessionId },
    reviewedAt: NOW,
    attestation: {
      toolObligationId: obligationId,
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      iteration,
      planVersion,
      reviewedBy: REVIEWER_SUBAGENT_TYPE,
    },
  });
}

/** Create a pending obligation with matching iteration/planVersion/mandate/criteria. */
export function pendingObligation(overrides: Partial<ReviewObligation> = {}): ReviewObligation {
  const base = createReviewObligation({
    obligationType: 'plan',
    iteration: 0,
    planVersion: 1,
    now: NOW,
  });
  return { ...base, ...overrides };
}

/**
 * Set up a full enforcement cycle: Mode A → Task call → enforcement state ready.
 * Returns the obligation and the enforcement state.
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
  // Step 1: Mode A — FlowGuard tool signals INDEPENDENT_REVIEW_REQUIRED
  onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(iteration, planVersion), NOW);

  const obligation = pendingObligation({
    ...(customObligationId ? { obligationId: customObligationId } : {}),
    iteration,
    planVersion,
  });

  const taskResult = taskResultWithAttestation(obligation.obligationId, {
    childSessionId,
    iteration,
    planVersion,
  });

  // Step 2: Task call — onTaskToolAfter records subagent call
  onTaskToolAfter(
    state,
    {
      subagent_type: REVIEWER_SUBAGENT_TYPE,
      prompt: validPrompt(iteration, planVersion),
    },
    taskResult,
    LATER,
  );

  return { state, obligation };
}
