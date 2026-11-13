/** Explicit response shape for a review that exhausted its budget without acceptance. */
import type { PlanRevisionResult } from './plan-types.js';

/**
 * A forced-convergence review never adopts the revision submitted with the
 * final verdict. Make that explicit to the model, not only to the human card:
 * the reviewed artifact remains current, and the next step is a user decision.
 */
export function forcedConvergenceResponseFields(
  revision: PlanRevisionResult,
  forcedConvergence: boolean | undefined,
): Record<string, unknown> {
  if (forcedConvergence !== true) return { adopted: true };
  const discarded = revision.discardedDraft !== undefined;
  return {
    adopted: false,
    reviewCompletion: 'review_exhausted',
    currentPlanVersion: revision.history.length + 1,
    ...(discarded ? { discardedRevisionVersion: revision.history.length + 2 } : {}),
    nextActions: [
      '/request-changes — start a new review cycle; resubmit the revision for independent review',
      '/override-approve <Begründung> — accept the reviewed plan despite the open findings',
      '/reject — decline and end the workflow',
    ],
    agentInstruction: discarded
      ? 'The revision submitted with the final verdict was not adopted and has not been reviewed. Do not present it as the current plan; the only approvable plan is the one shown in the review card.'
      : 'The review reached its iteration limit without acceptance. Do not submit another plan revision at PLAN_REVIEW; ask the user to choose /request-changes, /override-approve <Begründung>, or /reject.',
  };
}
