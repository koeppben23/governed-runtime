/**
 * @module integration/tools/plan-route
 * @description Plan initial-submission routing for an existing plan review
 *              obligation: output-repair reissue and attempt re-emission.
 *
 * `/plan` re-invocation is the authorized trigger for review lifecycle
 * transitions of the latest plan obligation. A blocked plan obligation is NOT
 * intercepted here: the regular submission path creates a fresh plan revision
 * and a fresh obligation — the flow-specific recovery for `/plan`.
 *
 * @version v1
 */

import { readState } from '../../adapters/persistence.js';
import type { SessionState } from '../../state/schema.js';
import { ensureReviewAssurance, reviewObligationResponseFields } from '../review/assurance.js';
import { resolveReviewContinuation } from '../review/review-continuation.js';
import { reissueReviewAttempt } from './review-tool/continuation.js';
import type { PlanExecutionScope } from './plan-types.js';
import { buildPlanReviewInstruction } from './plan-response.js';
import { appendNextAction, formatBlocked } from './helpers.js';

/**
 * Gate an initial plan submission against the plan review loop: a pending plan
 * obligation (without a routed continuation) blocks; a blocked plan obligation
 * authorizes a fresh submission (the plan recovery policy), capped at three
 * blocked obligations.
 */
export function blockedPlanReviewInProgress(state: SessionState): string | null {
  const assurance = ensureReviewAssurance(state.reviewAssurance);
  const blockedPlanObligations = assurance.obligations.filter(
    (o) => o.obligationType === 'plan' && o.status === 'blocked',
  );
  const lastPlanObligation = [...assurance.obligations]
    .reverse()
    .find((o) => o.obligationType === 'plan');

  if (lastPlanObligation?.status !== 'blocked') {
    return formatBlocked('PLAN_REVIEW_IN_PROGRESS');
  }
  if (blockedPlanObligations.length >= 3) {
    return formatBlocked('ORCHESTRATION_PERMANENTLY_FAILED', {
      attempts: String(blockedPlanObligations.length),
    });
  }
  return null;
}

export async function routePlanInitialSubmission(
  scope: PlanExecutionScope,
): Promise<string | null> {
  const { state } = scope;
  if (state.phase !== 'PLAN' || !state.plan || !state.selfReview) return null;

  const continuation = resolveReviewContinuation(state.reviewAssurance, 'plan');

  switch (continuation.kind) {
    case 'awaiting_task':
      return planInstructionResponse(scope, continuation.obligation, continuation.attemptId);
    case 'output_repair': {
      const reissue = await reissueReviewAttempt(
        scope.sessDir,
        state,
        continuation.obligation,
        scope.ctx.now(),
      );
      if (reissue.kind === 'blocked') {
        return formatBlocked(reissue.code, {
          obligationId: continuation.obligation.obligationId,
          reason: reissue.reason,
        });
      }
      const fresh = (await readState(scope.sessDir)) ?? state;
      return planInstructionResponse(
        { ...scope, state: fresh },
        continuation.obligation,
        reissue.attempt.attemptId,
      );
    }
    // A blocked plan obligation is recovered by the regular submission path
    // (fresh plan revision + fresh obligation), and an obligation awaiting a
    // verdict or an absent obligation fall through to the existing gates.
    case 'blocked':
    case 'awaiting_verdict':
    case 'none':
      return null;
  }
}

function planInstructionResponse(
  scope: PlanExecutionScope,
  obligation: NonNullable<PlanExecutionScope['state']['reviewAssurance']>['obligations'][number],
  attemptId: string | null,
): string {
  const instruction = buildPlanReviewInstruction({
    scope,
    obligation,
    iteration: obligation.iteration,
    planVersion: obligation.planVersion,
    subjectLabel: 'full plan text and ticket text',
    state: scope.state,
  });
  const response: Record<string, unknown> = {
    phase: scope.state.phase,
    status: 'Plan review is pending; reusing the existing review obligation.',
    planDigest: scope.state.plan!.current.digest,
    selfReviewIteration: scope.state.selfReview!.iteration,
    reviewMode: scope.reviewPolicy.subagentEnabled ? 'subagent' : 'self',
    ...reviewObligationResponseFields(obligation, attemptId),
    next: instruction.next,
    ...(instruction.reviewInvocation ? { reviewInvocation: instruction.reviewInvocation } : {}),
    _audit: { transitions: [] },
  };
  return appendNextAction(JSON.stringify(response), scope.state);
}
