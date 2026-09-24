/**
 * @module integration/review-enforcement-types
 * @description Types, interfaces, and constants for review enforcement.
 *
 * Extracted from review-enforcement.ts (FG-REL-038) for single-responsibility.
 * This module is the universal coupling point — all enforcement clusters
 * depend on these types. Keeping them in a dedicated leaf module prevents
 * circular imports and enables lightweight consumer imports.
 *
 * The transient pending-review record tracks only the FlowGuard
 * review-requirement signal identity. Reviewer execution authority is the
 * host-observed native structured invocation persisted in review assurance; no
 * capture or extraction state lives here.
 *
 * @version v2
 */

/** Result of an enforcement check. */
export type EnforcementResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string; readonly reason: string };

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Opening of the trailing line of the canonical reviewer prompt, which tells the
 * agent to append the artifact below it.
 *
 * Shared contract between the emitter (renderReviewerTaskPrompt) and the
 * checker, which locates it to verify that something was actually appended.
 * Emitter and enforcement must never drift apart.
 */
export const CANONICAL_PROMPT_APPEND_MARKER = 'Append the';
