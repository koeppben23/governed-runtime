/**
 * @module integration/review-enforcement-test-helpers
 * @description Shared test factories and constants for review-enforcement test suites.
 */

import { REVIEW_REQUIRED_PREFIX, REVIEWER_SUBAGENT_TYPE } from './types.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const NOW = '2026-04-24T12:00:00.000Z';
export const LATER = '2026-04-24T12:01:00.000Z';
export const FIXTURE_OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_MANDATE_DIGEST = 'm'.repeat(64);
export const FIXTURE_CRITERIA_VERSION = 'fixture-criteria-v1';

// ─── Factory Functions ───────────────────────────────────────────────────────

/**
 * Build a Mode A response with INDEPENDENT_REVIEW_REQUIRED containing iteration
 * and planVersion.
 *
 * `obligationId` models the REAL production signal (plan-response.ts emits
 * reviewObligationId + reviewInvocation.requiredReviewAttestation): only when
 * it is set does the pending review become bindable/usable under the host
 * attestation-constants invariant.
 */
export function modeASubagentResponse(
  opts: {
    iteration?: number;
    planVersion?: number;
    phase?: string;
    obligationId?: string;
  } = {},
): string {
  const { iteration = 0, planVersion = 1, phase = 'PLAN', obligationId } = opts;
  return JSON.stringify({
    phase,
    status: `Plan submitted (v${planVersion}).`,
    selfReviewIteration: iteration,
    reviewMode: 'subagent',
    ...(obligationId
      ? {
          reviewAttemptId: `att-${obligationId}`,
          reviewObligationId: obligationId,
          requiredReviewAttestation: {
            reviewedBy: REVIEWER_SUBAGENT_TYPE,
            mandateDigest: FIXTURE_MANDATE_DIGEST,
            criteriaVersion: FIXTURE_CRITERIA_VERSION,
            toolObligationId: obligationId,
            iteration,
            planVersion,
          },
        }
      : {}),
    next:
      `${REVIEW_REQUIRED_PREFIX}: Call the flowguard-reviewer subagent via Task tool. ` +
      `Use subagent_type "flowguard-reviewer" with a prompt that includes: ` +
      `(1) the full plan text, (2) the ticket text, (3) iteration=${iteration}, ` +
      `(4) planVersion=${planVersion}.`,
  });
}

/** Build a Mode A response without an independent-review next marker. */
export function modeANoReviewRequiredResponse(): string {
  return JSON.stringify({
    phase: 'PLAN',
    status: 'Plan submitted (v1).',
    reviewMode: 'subagent',
    next: 'Plan submitted. Await explicit review routing.',
  });
}

/** Build a Mode B success response. */
export function modeBSuccessResponse(): string {
  return JSON.stringify({
    phase: 'PLAN',
    status: 'Independent review iteration 1/3. Verdict: approve.',
    reviewMode: 'subagent',
  });
}

/** Build a Mode B error response. */
export function modeBErrorResponse(): string {
  return JSON.stringify({
    error: true,
    code: 'REVISED_PLAN_REQUIRED',
  });
}

/** Build a Task tool result with subagent findings. */
export function taskResultWithFindings(
  sessionId: string,
  opts: {
    verdict?: string;
    blockingIssues?: unknown[];
  } = {},
): string {
  const { verdict = 'accept', blockingIssues = [] } = opts;
  return JSON.stringify({
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: verdict,
    blockingIssues,
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId },
    reviewedAt: NOW,
  });
}

/** Build a Task tool result with embedded text around JSON. */
export function taskResultWithEmbeddedFindings(
  sessionId: string,
  opts: { verdict?: string; blockingIssues?: unknown[] } = {},
): string {
  return `Here are my review findings:\n${taskResultWithFindings(sessionId, opts)}\nEnd of review.`;
}

/**
 * Build a Task tool result whose findings JSON is valid JSON with a present
 * `overallVerdict` (so extractCapturedFindings succeeds) but a MISTYPED required
 * field — `majorRiskes` instead of `majorRisks`. The captured rawFindings then
 * FAIL ReviewFindings.safeParse, reproducing the live-demo host-task deadlock
 * where a single reviewer typo poisoned the obligation.
 */
export function taskResultWithMalformedFindings(sessionId: string): string {
  return JSON.stringify({
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRiskes: [], // typo → required `majorRisks` missing → unparseable
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId },
    reviewedAt: NOW,
  });
}

/** Build a substantive prompt for the subagent (meets MIN_SUBAGENT_PROMPT_LENGTH). */
export function validSubagentPrompt(
  opts: { iteration?: number; planVersion?: number } = {},
): string {
  const { iteration = 0, planVersion = 1 } = opts;
  return (
    `Review this plan critically. The plan proposes implementing a new feature ` +
    `for user authentication with OAuth2 integration. ` +
    `Ticket: PROJ-123 - Add OAuth2 login flow. ` +
    `iteration=${iteration}, planVersion=${planVersion}. ` +
    `Check for completeness, correctness, feasibility, risk, and quality. ` +
    `Return structured ReviewFindings JSON with your assessment.`
  );
}
