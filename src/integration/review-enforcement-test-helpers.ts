/**
 * @module integration/review-enforcement-test-helpers
 * @description Shared test factories and constants for review-enforcement test suites.
 */

import { REVIEW_REQUIRED_PREFIX } from './review-enforcement-types.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const NOW = '2026-04-24T12:00:00.000Z';
export const LATER = '2026-04-24T12:01:00.000Z';

// ─── Factory Functions ───────────────────────────────────────────────────────

/** Build a Mode A response with INDEPENDENT_REVIEW_REQUIRED containing iteration and planVersion. */
export function modeASubagentResponse(
  opts: { iteration?: number; planVersion?: number; phase?: string } = {},
): string {
  const { iteration = 0, planVersion = 1, phase = 'PLAN' } = opts;
  return JSON.stringify({
    phase,
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
  const { verdict = 'approve', blockingIssues = [] } = opts;
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
