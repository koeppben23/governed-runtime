/**
 * @module integration/review-enforcement-types
 * @description Types, interfaces, and constants for review enforcement.
 *
 * Extracted from review-enforcement.ts (FG-REL-038) for single-responsibility.
 * This module is the universal coupling point — all enforcement clusters
 * depend on these types. Keeping them in a dedicated leaf module prevents
 * circular imports and enables lightweight consumer imports.
 *
 * @version v1
 */

import { TOOL_FLOWGUARD_REVIEW } from '../../tool-names.js';
import type { ReviewableTool } from '../obligation-tools.js';
export type { ReviewableTool } from '../obligation-tools.js';

export type PendingReviewTool = ReviewableTool | typeof TOOL_FLOWGUARD_REVIEW;

/** Record of a completed subagent invocation. */
export interface SubagentRecord {
  /** Subagent session ID extracted from response, or null if extraction failed. */
  readonly sessionId: string | null;
  /** ISO 8601 timestamp when the Task call completed. */
  readonly completedAt: string;
}

/**
 * Content metadata captured from FlowGuard tool response.
 * Used by Level 3 (Prompt Integrity) to validate the Task call prompt.
 */
export interface ContentMeta {
  /** Expected iteration value parsed from the INDEPENDENT_REVIEW_REQUIRED message. */
  readonly expectedIteration: number;
  /** Expected planVersion value parsed from the message (null if not present). */
  readonly expectedPlanVersion: number | null;
}

/**
 * Key fields captured from the actual subagent response.
 * Used by Level 4 (Findings Integrity) to detect findings modification.
 */
export interface CapturedFindings {
  /** The overallVerdict from the subagent's ReviewFindings. */
  readonly overallVerdict: string;
  /** Count of blockingIssues from the subagent's ReviewFindings. */
  readonly blockingIssuesCount: number;
  /** The sessionId from reviewedBy, if present. */
  readonly sessionId: string | null;
  /** Complete parsed ReviewFindings object, when extraction succeeds. */
  readonly rawFindings?: Record<string, unknown> | null;
}

/** Per-tool pending review state. */
export interface PendingReview {
  /** Which tool signaled the review requirement. */
  readonly tool: PendingReviewTool;
  /** ISO 8601 timestamp when the requirement was signaled. */
  readonly requestedAt: string;
  /** Whether a Task call to flowguard-reviewer has been made (Level 1). */
  subagentCalled: boolean;
  /** Record of the actual subagent call, if made (Level 2). */
  subagentRecord: SubagentRecord | null;
  /** Content metadata for prompt integrity validation (Level 3). */
  contentMeta: ContentMeta | null;
  /** Actual findings from the subagent response (Level 4). */
  capturedFindings: CapturedFindings | null;
}

/** Session-level enforcement state. */
export interface SessionEnforcementState {
  /** Pending reviews keyed by tool name. */
  readonly pendingReviews: Map<PendingReviewTool, PendingReview>;
}

/**
 * Optional context from the plugin hook for session ID resolution.
 *
 * Tier 1: `metadata.sessionID` — authoritative, from the task tool runtime.
 * Tier 2: Text extraction from the reviewer's output (existing behavior).
 * Tier 3: `derived:call:${callID}` — synthetic, guaranteed unique.
 */
export interface TaskToolContext {
  /** Metadata from the task tool output (may contain child sessionID). */
  readonly metadata?: Record<string, unknown>;
  /** Tool call ID — unique per invocation, used for Tier 3 synthetic ID. */
  readonly callID?: string;
}

/** Result of an enforcement check. */
export type EnforcementResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string; readonly reason: string };

// ─── Constants ───────────────────────────────────────────────────────────────

/** The prefix that FlowGuard tools use to signal subagent review is required. */
export const REVIEW_REQUIRED_PREFIX = 'INDEPENDENT_REVIEW_REQUIRED';

/** The subagent type name for the FlowGuard reviewer. */
export { REVIEWER_SUBAGENT_TYPE } from '../../tool-names.js';

/**
 * Minimum prompt length for subagent calls (Level 3).
 * A real review prompt must include plan/implementation text, ticket context,
 * iteration, and planVersion. 200 characters is a generous floor that catches
 * empty or trivially short prompts.
 */
export const MIN_SUBAGENT_PROMPT_LENGTH = 200;

/**
 * Machine-readable outcome of a host-task bind attempt.
 * Used for diagnostic logging — NOT a governance reason code.
 */
export type HostTaskBindOutcome =
  | 'bound'
  | 'no_matched_record'
  | 'no_child_session'
  | 'no_obligation_type'
  | 'no_findings'
  | 'no_matching_obligation'
  | 'field_mismatch'
  | 'duplicate_evidence';

/**
 * Structured result from buildHostTaskEvidence.
 *
 * Always includes a machine-readable `bindOutcome` and a serializable
 * `diagnostic` object so the caller can log exactly why binding succeeded
 * or failed without re-inspecting internal state.
 */
export interface HostTaskBindResult {
  /** Created evidence, or null if binding failed. */
  evidence: import('../../../state/evidence.js').ReviewInvocationEvidence | null;
  /** Machine-readable bind outcome for logging. */
  bindOutcome: HostTaskBindOutcome;
  /** Structured diagnostic metadata (safe to JSON.stringify). */
  diagnostic: Record<string, unknown>;
}
