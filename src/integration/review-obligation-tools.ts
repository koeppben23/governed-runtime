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

import type { ReviewObligationType } from '../state/evidence.js';
import {
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_PLAN,
} from './tool-names.js';

/** Tools that can trigger independent review obligations. */
export type ReviewableTool =
  | typeof TOOL_FLOWGUARD_PLAN
  | typeof TOOL_FLOWGUARD_IMPLEMENT
  | typeof TOOL_FLOWGUARD_ARCHITECTURE;

const REVIEW_OBLIGATION_BY_TOOL = {
  [TOOL_FLOWGUARD_PLAN]: 'plan',
  [TOOL_FLOWGUARD_IMPLEMENT]: 'implement',
  [TOOL_FLOWGUARD_ARCHITECTURE]: 'architecture',
} as const satisfies Readonly<Record<ReviewableTool, ReviewObligationType>>;

/** Type-guard: is the given tool name a reviewable FlowGuard tool? */
export function isReviewableTool(toolName: string): toolName is ReviewableTool {
  return Object.prototype.hasOwnProperty.call(REVIEW_OBLIGATION_BY_TOOL, toolName);
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
