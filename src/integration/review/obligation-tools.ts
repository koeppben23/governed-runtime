/**
 * @module integration/review-obligation-tools
 * @description Single source of truth for reviewable tool ↔ obligation type mapping.
 *
 * Runtime authority rule: only tools listed here can create or fulfill independent
 * review obligations. Unknown tools return undefined and must be handled fail-closed
 * by callers that require a reviewable tool.
 *
 * @version v1
 */

import type { ReviewObligationType } from '../../state/evidence.js';
import {
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_REVIEW_IMPLEMENTATION,
  TOOL_FLOWGUARD_RUN_CHECK,
} from '../tool-names.js';

/**
 * Tools that OWN a review obligation and its pending-review key.
 *
 * These are the tools whose call records evidence and creates the obligation
 * (`pendingReviews` is keyed by these names). The implementation review verdict
 * is submitted by a SEPARATE tool (`flowguard_review_implementation`, issue
 * #565) which is NOT a reviewable/obligation-owning tool itself — it resolves to
 * the owning `flowguard_implement` obligation via
 * {@link resolveReviewObligationTool}.
 */
export type ReviewableTool =
  typeof TOOL_FLOWGUARD_PLAN | typeof TOOL_FLOWGUARD_IMPLEMENT | typeof TOOL_FLOWGUARD_ARCHITECTURE;

const REVIEW_OBLIGATION_BY_TOOL = {
  [TOOL_FLOWGUARD_PLAN]: 'plan',
  [TOOL_FLOWGUARD_IMPLEMENT]: 'implement',
  [TOOL_FLOWGUARD_ARCHITECTURE]: 'architecture',
} as const satisfies Readonly<Record<ReviewableTool, ReviewObligationType>>;

/** Type-guard: is the given tool name a reviewable (obligation-owning) FlowGuard tool? */
export function isReviewableTool(toolName: string): toolName is ReviewableTool {
  return Object.prototype.hasOwnProperty.call(REVIEW_OBLIGATION_BY_TOOL, toolName);
}

/**
 * Resolve the obligation-owning (reviewable) tool that a verdict submission
 * applies to.
 *
 * The implementation review verdict is submitted by
 * `flowguard_review_implementation`, but the obligation and its pending-review
 * key are owned by `flowguard_implement`. For plan/architecture the verdict is
 * submitted on the same tool that owns the obligation (identity).
 *
 * Returns `undefined` when the tool neither owns nor submits a verdict for a
 * review obligation, so callers fail closed explicitly.
 */
export function resolveReviewObligationTool(toolName: string): ReviewableTool | undefined {
  if (toolName === TOOL_FLOWGUARD_REVIEW_IMPLEMENTATION) return TOOL_FLOWGUARD_IMPLEMENT;
  if (isReviewableTool(toolName)) return toolName;
  return undefined;
}

/**
 * Resolve the logical owner for a tool response that signals an independent
 * review requirement. Post-implementation checks create the obligation only
 * after validation succeeds, but the implementation tool still owns its
 * verdict and enforcement key.
 */
export function reviewSignalOwner(toolName: string): ReviewableTool | undefined {
  if (toolName === TOOL_FLOWGUARD_RUN_CHECK) return TOOL_FLOWGUARD_IMPLEMENT;
  return resolveReviewObligationTool(toolName);
}

/**
 * True when the tool submits a review verdict (its own, for plan/architecture,
 * or the implementation verdict via `flowguard_review_implementation`).
 */
export function isVerdictSubmittingTool(toolName: string): boolean {
  return resolveReviewObligationTool(toolName) !== undefined;
}

/** Map a reviewable tool to its corresponding obligation type. */
export function obligationTypeForTool(toolName: ReviewableTool): ReviewObligationType;

/** Return undefined for non-reviewable tools so callers can fail closed explicitly. */
export function obligationTypeForTool(toolName: string): ReviewObligationType | undefined;

export function obligationTypeForTool(toolName: string): ReviewObligationType | undefined {
  if (!isReviewableTool(toolName)) return undefined;
  return REVIEW_OBLIGATION_BY_TOOL[toolName];
}

/** Canonical ordered list for tests and docs guards. */
export const REVIEWABLE_TOOLS = Object.keys(REVIEW_OBLIGATION_BY_TOOL) as ReviewableTool[];
