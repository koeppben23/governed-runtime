/**
 * @module integration/tools/plan-route
 * @description Plan initial-submission routing for an existing plan review
 *              obligation: interrupted-dispatch re-arm and attempt re-emission.
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
import { ensureReviewAssurance } from '../review/assurance.js';
import {
  resolveReviewDispatchAuthority,
  reviewObligationResponseFields,
} from '../review/dispatch-authority.js';
import type { ReviewDispatchAuthority } from '../review/dispatch-authority.js';
import { resolveReviewContinuation } from '../review/review-continuation.js';
import { blockObligation } from '../review/obligation-state.js';
import { buildInterruptedDispatchRearm } from '../durable-dispatch.js';
import type { PlanExecutionScope } from './plan-types.js';
import { buildPlanReviewInstruction } from './plan-response.js';
import { enrichWithWorkflowDirective, formatBlocked, writeStateWithArtifacts } from './helpers.js';
import { IntegrationInvariantError } from '../errors.js';

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
    case 'awaiting_task': {
      // A pending continuation reviews the FROZEN subject: a submitted plan
      // with a different digest must never be silently ignored — fail closed.
      const changed = changedSubjectWhilePending(scope, continuation.obligation);
      if (changed) return changed;
      const authority = resolveReviewDispatchAuthority(
        state.reviewAssurance,
        continuation.obligation.obligationId,
      );
      if (authority.kind === 'blocked') {
        return formatBlocked(authority.code, { reason: authority.reason });
      }
      return planInstructionResponse(scope, authority.authority);
    }
    case 'interrupted_dispatch': {
      // A bindable attempt carries an unresolved durable dispatch. `/plan` is
      // the authorized trigger to re-arm the review durably: the spent attempt
      // is staled, its dispatch marked outcome_unknown, and a fresh append-only
      // attempt minted on the SAME obligation. Never a silent awaiting_task
      // re-emission of the spent attempt.
      const changed = changedSubjectWhilePending(scope, continuation.obligation);
      if (changed) return changed;
      return routePlanInterruptedDispatch(scope, continuation.obligation, continuation.attemptId);
    }
    case 'integrity_blocked':
      return formatBlocked(continuation.code, {
        obligationId: continuation.obligation.obligationId,
        reason: continuation.reason,
      });
    // A pending obligation without any legal reviewer attempt can never be
    // repaired by a re-invocation of the same plan: the broken obligation is
    // deterministically closed so the NEXT /plan mints a fresh obligation.
    case 'missing_attempt':
      return routePlanMissingAttempt(scope, continuation.obligation, continuation.code);
    // A blocked plan obligation is recovered by the regular submission path
    // (fresh plan revision + fresh obligation), and an obligation awaiting a
    // verdict or an absent obligation fall through to the existing gates.
    case 'blocked':
    case 'awaiting_verdict':
    case 'none':
      return null;
  }
}

async function routePlanMissingAttempt(
  scope: PlanExecutionScope,
  obligation: NonNullable<PlanExecutionScope['state']['reviewAssurance']>['obligations'][number],
  code: string,
): Promise<string> {
  const blockedState = blockObligation(scope.state, obligation.obligationId, code);
  await writeStateWithArtifacts(scope.sessDir, blockedState);
  return formatBlocked(code, {
    obligationId: obligation.obligationId,
    recovery:
      'The broken review obligation has been deterministically closed. Re-run /plan to submit a fresh plan revision and mint a new review obligation.',
  });
}

async function routePlanInterruptedDispatch(
  scope: PlanExecutionScope,
  obligation: NonNullable<PlanExecutionScope['state']['reviewAssurance']>['obligations'][number],
  attemptId: string,
): Promise<string> {
  const spent = scope.state.reviewAssurance?.attempts.find((a) => a.attemptId === attemptId);
  if (!spent) {
    return formatBlocked('REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE', {
      obligationId: obligation.obligationId,
      reason: 'interrupted reviewer attempt is absent from assurance',
    });
  }
  const rearmed = buildInterruptedDispatchRearm(
    scope.state.reviewAssurance,
    spent,
    scope.ctx.now(),
  );
  if (rearmed.kind === 'blocked') {
    return formatBlocked('REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE', {
      obligationId: obligation.obligationId,
      reason: rearmed.reason,
    });
  }
  await writeStateWithArtifacts(scope.sessDir, {
    ...scope.state,
    reviewAssurance: rearmed.assurance,
  });
  const fresh = (await readState(scope.sessDir)) ?? scope.state;
  const authority = resolveReviewDispatchAuthority(fresh.reviewAssurance, obligation.obligationId);
  if (authority.kind === 'blocked') {
    return formatBlocked(authority.code, { reason: authority.reason });
  }
  return planInstructionResponse({ ...scope, state: fresh }, authority.authority);
}

function changedSubjectWhilePending(
  scope: PlanExecutionScope,
  obligation: NonNullable<PlanExecutionScope['state']['reviewAssurance']>['obligations'][number],
): string | null {
  const planText = scope.args.planText;
  if (typeof planText !== 'string' || !planText.trim()) return null;
  const submittedDigest = scope.ctx.digest(planText);
  if (submittedDigest === obligation.subjectDigest) return null;
  return formatBlocked('REVIEW_SUBJECT_CHANGED_WHILE_PENDING', {
    obligationId: obligation.obligationId,
    subjectDigest: obligation.subjectDigest,
    submittedDigest,
  });
}

function planInstructionResponse(
  scope: PlanExecutionScope,
  authority: ReviewDispatchAuthority,
): string {
  const instruction = buildPlanReviewInstruction({
    scope,
    authority,
    iteration: authority.obligation.iteration,
    planVersion: authority.obligation.planVersion,
    subjectLabel: 'full plan text and ticket text',
    state: scope.state,
  });
  const plan = scope.state.plan;
  const selfReview = scope.state.selfReview;
  if (!plan || !selfReview) {
    throw new IntegrationInvariantError(
      'PLAN_REVIEW_STATE_REQUIRED',
      'a plan review instruction requires plan and self-review state',
    );
  }
  const response: Record<string, unknown> = {
    phase: scope.state.phase,
    status: 'Plan review is pending; reusing the existing review obligation.',
    planDigest: plan.current.digest,
    selfReviewIteration: selfReview.iteration,
    reviewMode: 'subagent',
    ...reviewObligationResponseFields(authority),
    reviewDispatch: instruction.reviewDispatch,
    reviewInvocation: instruction,
    _audit: { transitions: [] },
  };
  return JSON.stringify(enrichWithWorkflowDirective(response, scope.state));
}
