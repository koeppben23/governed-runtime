/**
 * @module plan-auto-approval
 * @description Automatic plan-approval certificate minting for policy-auto gates.
 *
 * The certificate is minted from the SAME bound review evidence the explicit
 * rail would resolve — never from policy permission alone — so an exhausted or
 * unverifiable review can never be certified automatically. When certification
 * is not possible, the state is returned unchanged: the protected final-evidence
 * gate stays fail-closed for any critical declaration, and a claimless non-risk
 * workflow remains possible.
 *
 * @version v1
 */

import type { SessionState } from '../../../state/schema.js';
import { requiresGovernanceOverride } from '../../../machine/workflow-directive.js';
import {
  buildPlanReviewBinding,
  createAutomaticPlanApprovalCertificate,
  enforcePlanReviewEvidence,
  planReviewSubjectAuthority,
} from '../../../rails/plan-review-evidence.js';
import { resolvePlanReviewEvidence } from '../../../rails/review-evidence-resolution.js';
import type { PlanExecutionScope } from './plan-types.js';

export function mintAutomaticPlanApprovalCertificateIfPermitted(
  state: SessionState,
  scope: PlanExecutionScope,
): SessionState {
  if (scope.policy.requireHumanGates !== false) return state;
  if (requiresGovernanceOverride(state)) return state;
  const plan = state.plan;
  if (!plan || plan.approvalCertificate || plan.reviewCompletion !== 'reviewer_accepted') {
    return state;
  }
  const resolution = resolvePlanReviewEvidence(state, planReviewSubjectAuthority(plan));
  // Validate through the canonical plan-evidence gate on the gate phase: the
  // reviewed revision and claim set must bind exactly.
  const validationState: SessionState = { ...state, phase: 'PLAN_REVIEW' };
  if (resolution === null || enforcePlanReviewEvidence(validationState, resolution) !== null) {
    return state;
  }
  const binding = buildPlanReviewBinding('reviewer_accepted', resolution, plan.current.digest);
  if (!binding) return state;
  const certificate = createAutomaticPlanApprovalCertificate(state, plan, scope.ctx, binding);
  if (!certificate) return state;
  return { ...state, plan: { ...plan, approvalCertificate: certificate } };
}
