/**
 * @module integration/tools/plan-types
 * @description Type definitions and type-guard helpers for the plan tool.
 *
 * @version v1
 */

import type { PlanEvidence, LoopVerdict, RevisionDelta } from '../../state/evidence.js';
import type { PlanClaimDeclarationInput } from '../../state/proofgraph-approval.js';
import type { EvalResult } from '../../machine/evaluate.js';
import type { MutableSession, ToolContext } from './helpers.js';
import { classifyToolCallMode, toolCallFlags } from './review-validation-mode.js';

export type PlanArgs = {
  planText?: string;
  claims?: PlanClaimDeclarationInput[];
  reviewVerdict?: 'accept' | 'changes_requested';
  reviewerUnavailable?: boolean;
  targetPaths?: string[];
};

export type MutablePlanSession = MutableSession;

export type PlanInputFlags = {
  hasPlanText: boolean;
  hasVerdict: boolean;
  hasReviewerUnavailable: boolean;
  isInitialSubmission: boolean;
};

export type PlanCallMode =
  | { kind: 'initial_submission' }
  | { kind: 'approval' }
  | { kind: 'revision' }
  | {
      kind: 'invalid';
      code: 'INVALID_PLAN_TOOL_SEQUENCE' | 'PLAN_APPROVE_WITH_TEXT';
      params?: Record<string, string>;
    };

export type PlanReviewPolicy = Record<never, never>;

export type PlanClaimSubmissionDiagnostics = {
  submittedClaimDeclarationsDigest: string;
  acceptedClaimDeclarationsDigest: string;
  rejectedClaims: {
    claimRef: string;
    statement: string;
    critical: boolean;
    disposition: 'rejected_non_blocking' | 'rejected_blocking';
    code: string;
    reason: string;
    recovery: string[];
  }[];
};

export type PlanExecutionScope = MutablePlanSession & {
  args: PlanArgs;
  context: ToolContext;
  input: PlanInputFlags;
  reviewPolicy: PlanReviewPolicy;
  maxPlanReviewIterations: number;
  claimSubmissionDiagnostics?: PlanClaimSubmissionDiagnostics;
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
  transitions: unknown;
  /** Exact current plan review obligation/attempt authority for the dispatch. */
  authority: import('../review/dispatch-authority.js').ReviewDispatchAuthority;
};

export type ConvergedPlanReviewInput = {
  scope: PlanExecutionScope;
  finalState: import('../../state/schema.js').SessionState;
  ev: EvalResult;
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
    reviewerUnavailable: args.reviewerUnavailable,
  });
  return {
    hasPlanText: f.hasText,
    hasVerdict: f.hasVerdict,
    hasReviewerUnavailable: f.hasReviewerUnavailable,
    isInitialSubmission: !f.hasVerdict,
  };
}

export function classifyPlanCall(args: PlanArgs, input = planInputFlags(args)): PlanCallMode {
  void input;
  const mode = classifyToolCallMode('plan', {
    text: args.planText,
    reviewVerdict: args.reviewVerdict,
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
  void scope;
  return {};
}
