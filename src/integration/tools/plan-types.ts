/**
 * @module integration/tools/plan-types
 * @description Type definitions and type-guard helpers for the plan tool.
 *
 * @version v1
 */

import type {
  PlanEvidence,
  LoopVerdict,
  RevisionDelta,
  ReviewFindings,
} from '../../state/evidence.js';
import type { MutableSession, ToolContext } from './helpers.js';

export type PlanArgs = {
  planText?: string;
  reviewVerdict?: 'approve' | 'changes_requested';
  reviewFindings?: ReviewFindings;
  reviewerUnavailable?: boolean;
};

export type MutablePlanSession = MutableSession;

export type PlanInputFlags = {
  hasPlanText: boolean;
  hasVerdict: boolean;
  hasFindings: boolean;
  isInitialSubmission: boolean;
};

export type PlanReviewPolicy = {
  subagentEnabled: boolean;
  fallbackToSelf: boolean;
  strictEnforcement: boolean;
};

export type PlanExecutionScope = MutablePlanSession & {
  args: PlanArgs;
  context: ToolContext;
  input: PlanInputFlags;
  reviewPolicy: PlanReviewPolicy;
  maxSelfReviewIterations: number;
};

export type PlanRevisionResult = {
  currentPlan: PlanEvidence;
  history: PlanEvidence[];
  revisionDelta: RevisionDelta;
  prevDigest: string;
  verdict: LoopVerdict;
};

export type PlanSubmissionResponseInput = {
  scope: PlanExecutionScope;
  finalState: import('../../state/schema.js').SessionState;
  planEvidence: PlanEvidence;
  planVersion: number;
  reviewFindings: ReviewFindings | null;
  transitions: unknown;
};

export type ConvergedPlanReviewInput = {
  scope: PlanExecutionScope;
  finalState: import('../../state/schema.js').SessionState;
  ev: Parameters<typeof import('./helpers.js').formatEval>[0];
  transitions: unknown;
  revision: PlanRevisionResult;
  iteration: number;
};

export function planInputFlags(args: PlanArgs): PlanInputFlags {
  const hasPlanText = typeof args.planText === 'string' && args.planText.trim().length > 0;
  const hasVerdict = typeof args.reviewVerdict === 'string' && args.reviewVerdict.length > 0;
  const hasFindings = args.reviewFindings != null && typeof args.reviewFindings === 'object';
  return {
    hasPlanText,
    hasVerdict,
    hasFindings,
    isInitialSubmission: !hasVerdict,
  };
}

export function planReviewPolicy(scope: MutablePlanSession): PlanReviewPolicy {
  return {
    subagentEnabled: scope.policy.selfReview?.subagentEnabled ?? false,
    fallbackToSelf: scope.policy.selfReview?.fallbackToSelf ?? false,
    strictEnforcement: scope.policy.selfReview?.strictEnforcement ?? false,
  };
}
