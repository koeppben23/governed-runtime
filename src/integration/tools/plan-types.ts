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
import { classifyToolCallMode, toolCallFlags } from './review-validation-mode.js';

export type PlanArgs = {
  planText?: string;
  reviewVerdict?: 'accept' | 'changes_requested';
  reviewFindings?: ReviewFindings;
  reviewerUnavailable?: boolean;
  targetPaths?: string[];
};

export type MutablePlanSession = MutableSession;

export type PlanInputFlags = {
  hasPlanText: boolean;
  hasVerdict: boolean;
  hasFindings: boolean;
  hasReviewerUnavailable: boolean;
  isInitialSubmission: boolean;
};

export type PlanCallMode =
  | { kind: 'initial_submission' }
  | { kind: 'approval' }
  | { kind: 'revision' }
  | {
      kind: 'invalid';
      code:
        | 'INVALID_PLAN_TOOL_SEQUENCE'
        | 'PLAN_APPROVE_WITH_TEXT'
        | 'PLAN_SUBMISSION_MIXED_INPUTS'
        | 'PLAN_FINDINGS_WITHOUT_VERDICT';
      params?: Record<string, string>;
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
  /**
   * True when convergence was forced by reaching the iteration limit without
   * an approving verdict (last verdict was changes_requested). Drives honest,
   * non-"approved" messaging and the review-card warning banner.
   */
  forcedConvergence?: boolean;
};

export function planInputFlags(args: PlanArgs): PlanInputFlags {
  const f = toolCallFlags({
    text: args.planText,
    reviewVerdict: args.reviewVerdict,
    reviewFindings: args.reviewFindings,
    reviewerUnavailable: args.reviewerUnavailable,
  });
  return {
    hasPlanText: f.hasText,
    hasVerdict: f.hasVerdict,
    hasFindings: f.hasFindings,
    hasReviewerUnavailable: f.hasReviewerUnavailable,
    isInitialSubmission: !f.hasVerdict,
  };
}

export function classifyPlanCall(args: PlanArgs, input = planInputFlags(args)): PlanCallMode {
  void input;
  const mode = classifyToolCallMode('plan', {
    text: args.planText,
    reviewVerdict: args.reviewVerdict,
    reviewFindings: args.reviewFindings,
    reviewerUnavailable: args.reviewerUnavailable,
  });
  if (mode.kind === 'invalid') {
    return {
      kind: 'invalid',
      code: mode.code as Extract<PlanCallMode, { kind: 'invalid' }>['code'],
      params: mode.params,
    };
  }
  if (mode.kind === 'initial_submission') return { kind: 'initial_submission' };
  if (mode.kind === 'revision') return { kind: 'revision' };
  return { kind: 'approval' };
}

export function planReviewPolicy(scope: MutablePlanSession): PlanReviewPolicy {
  return {
    subagentEnabled: scope.policy.selfReview?.subagentEnabled ?? false,
    fallbackToSelf: scope.policy.selfReview?.fallbackToSelf ?? false,
    strictEnforcement: scope.policy.selfReview?.strictEnforcement ?? false,
  };
}
