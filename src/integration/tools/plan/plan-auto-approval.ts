/**
 * @module plan-auto-approval
 * @description Automatic plan-approval certificate minting for policy-auto gates.
 *
 * The certificate is minted from the SAME bound review evidence the explicit
 * rail would resolve — never from policy permission alone. When the frozen
 * policy WOULD auto-approve but the accepted review evidence cannot be
 * certified (missing, mismatched, or unbound), the preparation blocks: the
 * plan gate itself must refuse the automatic approval with the canonical
 * review-evidence error, not leave it to the final evidence gate. Only an
 * exhausted review (which the machine already routes to the explicit override
 * gate) and a human-gated policy return an unchanged state.
 *
 * @version v2
 */

import type { SessionState } from '../../../state/schema.js';
import { applyTransition } from '../../../rails/types.js';
import { enrichWithWorkflowDirective, writeStateWithArtifacts } from '../helpers.js';
import { blocked } from '../../../config/reasons.js';
import type { RailBlocked } from '../../../rails/types.js';
import { requiresGovernanceOverride } from '../../../machine/workflow-directive.js';
import {
  buildPlanReviewBinding,
  createAutomaticPlanApprovalCertificate,
  enforcePlanReviewEvidence,
  planReviewSubjectAuthority,
} from '../../../rails/plan-review-evidence.js';
import { resolvePlanReviewEvidence } from '../../../rails/review-evidence-resolution.js';
import type { PlanExecutionScope } from './plan-types.js';

export type AutomaticPlanApprovalPreparation =
  | { readonly kind: 'ready'; readonly state: SessionState }
  | { readonly kind: 'blocked'; readonly block: RailBlocked };

export function prepareAutomaticPlanApproval(
  state: SessionState,
  scope: PlanExecutionScope,
): AutomaticPlanApprovalPreparation {
  if (scope.policy.requireHumanGates !== false) return { kind: 'ready', state };
  if (requiresGovernanceOverride(state)) return { kind: 'ready', state };
  const plan = state.plan;
  if (!plan || plan.approvalCertificate || plan.reviewCompletion !== 'reviewer_accepted') {
    return { kind: 'ready', state };
  }
  const resolution = resolvePlanReviewEvidence(state, planReviewSubjectAuthority(plan));
  // Validate through the canonical plan-evidence gate on the gate phase: the
  // reviewed revision and claim set must bind exactly, or the automatic
  // approval is refused with the canonical review-evidence error.
  const validationState: SessionState = { ...state, phase: 'PLAN_REVIEW' };
  const evidenceBlock = enforcePlanReviewEvidence(validationState, resolution);
  if (evidenceBlock) return { kind: 'blocked', block: evidenceBlock };
  if (resolution === null) {
    return {
      kind: 'blocked',
      block: blocked('PLAN_REVIEW_EVIDENCE_REQUIRED', {
        reviewCompletion: plan.reviewCompletion,
        reviewEvidence: 'missing',
        capturedVerdict: 'unavailable',
      }),
    };
  }
  const binding = buildPlanReviewBinding('reviewer_accepted', resolution, plan.current.digest);
  if (!binding) {
    return {
      kind: 'blocked',
      block: blocked('PLAN_REVIEW_EVIDENCE_REQUIRED', {
        reviewCompletion: plan.reviewCompletion,
        reviewEvidence: 'resolved',
        capturedVerdict: String(resolution.reviewerVerdict ?? 'missing'),
      }),
    };
  }
  const certificate = createAutomaticPlanApprovalCertificate(state, plan, scope.ctx, binding);
  if (!certificate) {
    return {
      kind: 'blocked',
      block: blocked('PLAN_REVIEW_EVIDENCE_REQUIRED', {
        reviewCompletion: plan.reviewCompletion,
        reviewEvidence: 'resolved',
        capturedVerdict: 'unavailable',
      }),
    };
  }
  return {
    kind: 'ready',
    state: { ...state, plan: { ...plan, approvalCertificate: certificate } },
  };
}

/**
 * Persist the legitimate reviewer acceptance at the gate position and return
 * the canonical blocked response. No automatic transition is applied: the
 * frozen policy would auto-approve, but the accepted review cannot be
 * certified, so the PLAN gate itself refuses the approval.
 */
export async function persistBlockedAutomaticPlanApproval(input: {
  readonly state: SessionState;
  readonly scope: PlanExecutionScope;
  readonly block: RailBlocked;
}): Promise<string> {
  const gateState: SessionState =
    input.state.phase === 'PLAN_REVIEW'
      ? input.state
      : applyTransition(
          input.state,
          input.state.phase,
          'PLAN_REVIEW',
          'SELF_REVIEW_MET',
          input.scope.ctx.now(),
        );
  await writeStateWithArtifacts(input.scope.sessDir, gateState);
  return JSON.stringify(
    enrichWithWorkflowDirective(
      {
        error: true,
        code: input.block.code,
        message: input.block.reason,
        recovery: input.block.recovery ?? [],
        ...(input.block.quickFix !== undefined ? { quickFix: input.block.quickFix } : {}),
        phase: gateState.phase,
      },
      gateState,
    ),
  );
}
