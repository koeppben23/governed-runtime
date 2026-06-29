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
  reviewVerdict?: 'accept' | 'changes_requested';
  reviewFindings?: ReviewFindings;
  reviewerUnavailable?: boolean;
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
        'INVALID_PLAN_TOOL_SEQUENCE' | 'PLAN_APPROVE_WITH_TEXT' | 'PLAN_SUBMISSION_MIXED_INPUTS';
    };

type InvalidPlanCallCode = Extract<PlanCallMode, { kind: 'invalid' }>['code'];

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
  const hasPlanText = typeof args.planText === 'string' && args.planText.trim().length > 0;
  const hasVerdict = typeof args.reviewVerdict === 'string' && args.reviewVerdict.length > 0;
  const hasFindings = args.reviewFindings != null && typeof args.reviewFindings === 'object';
  const hasReviewerUnavailable = args.reviewerUnavailable === true;
  return {
    hasPlanText,
    hasVerdict,
    hasFindings,
    hasReviewerUnavailable,
    isInitialSubmission: !hasVerdict,
  };
}

export function classifyPlanCall(args: PlanArgs, input = planInputFlags(args)): PlanCallMode {
  const invalidCode = [
    [
      input.hasPlanText && input.hasVerdict && args.reviewVerdict !== 'changes_requested',
      'PLAN_APPROVE_WITH_TEXT',
    ],
    [input.hasPlanText && input.hasFindings && !input.hasVerdict, 'PLAN_SUBMISSION_MIXED_INPUTS'],
    [
      input.hasPlanText && input.hasReviewerUnavailable && !input.hasVerdict,
      'INVALID_PLAN_TOOL_SEQUENCE',
    ],
  ] satisfies readonly [boolean, InvalidPlanCallCode][];
  const matchedInvalidCode = invalidCode.find(([matches]) => matches)?.[1];

  if (matchedInvalidCode) return { kind: 'invalid', code: matchedInvalidCode };
  if (!input.hasVerdict) return { kind: 'initial_submission' };
  if (args.reviewVerdict === 'changes_requested') return { kind: 'revision' };
  return { kind: 'approval' };
}

export function planReviewPolicy(scope: MutablePlanSession): PlanReviewPolicy {
  return {
    subagentEnabled: scope.policy.selfReview?.subagentEnabled ?? false,
    fallbackToSelf: scope.policy.selfReview?.fallbackToSelf ?? false,
    strictEnforcement: scope.policy.selfReview?.strictEnforcement ?? false,
  };
}
