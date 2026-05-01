/**
 * @module integration/review-enforcement
 * @description Runtime enforcement for independent review subagent invocation.
 *
 * Problem: FlowGuard tools return advisory `next` messages instructing the
 * primary agent to call the flowguard-reviewer subagent via the Task tool.
 * However, the primary agent could ignore this instruction, fabricate
 * ReviewFindings without invoking the subagent, send an empty/garbage prompt,
 * or modify the subagent's actual findings before submitting them.
 *
 * Solution: This module observes the entire tool-call sequence via OpenCode's
 * plugin hook system (tool.execute.before/after) and enforces four levels:
 *
 * Enforcement levels:
 * - Level 1 (Binary Gate): A Task call to flowguard-reviewer MUST occur
 *   before any verdict submission. Enforced in tool.execute.before for
 *   flowguard_plan/flowguard_implement Mode B calls.
 * - Level 2 (Session ID): The submitted reviewFindings.reviewedBy.sessionId
 *   must match the actual subagent session ID. Enforced when both the actual
 *   and submitted session IDs are available.
 * - Level 3 (Prompt Integrity): The Task call prompt must contain expected
 *   iteration/planVersion values and meet minimum length requirements.
 *   Enforced in tool.execute.before for task calls to flowguard-reviewer.
 * - Level 4 (Findings Integrity): The submitted reviewFindings must match the
 *   actual subagent response (overallVerdict and blockingIssues count).
 *   Enforced in tool.execute.before for flowguard_plan/flowguard_implement
 *   Mode B calls.
 *
 * 1:1 obligation matching (P34a/P34b contract):
 * Each Task call to flowguard-reviewer satisfies exactly ONE pending review
 * obligation. P34a (plan review) and P34b (implement review) are independent
 * governance obligations — a single subagent call cannot satisfy both.
 * When multiple pending reviews exist, the Task prompt's iteration/planVersion
 * values are matched against each pending review's contentMeta to determine
 * which obligation the call fulfills. If no match is found, no obligation is
 * satisfied (fail-closed).
 *
 * Architecture:
 * - Pure logic module — no OpenCode/plugin dependencies, fully unit-testable.
 * - Plugin integration happens in plugin.ts (delegates to this module).
 * - Session-scoped state tracked per session ID.
 *
 * Conformance: Uses documented OpenCode plugin hooks (tool.execute.before/after)
 * per https://opencode.ai/docs/plugins
 *
 * @version v3
 */

// ─── Types ────────────────────────────────────────────────────────────────────

import {
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_IMPLEMENT,
  REVIEWER_SUBAGENT_TYPE,
} from './tool-names.js';
import type { SessionState } from '../state/schema.js';

/** Tools that can trigger independent review. */
export type ReviewableTool = typeof TOOL_FLOWGUARD_PLAN | typeof TOOL_FLOWGUARD_IMPLEMENT;

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
}

/** Per-tool pending review state. */
export interface PendingReview {
  /** Which tool signaled the review requirement. */
  readonly tool: ReviewableTool;
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
  readonly pendingReviews: Map<ReviewableTool, PendingReview>;
}

/** Result of an enforcement check. */
export type EnforcementResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string; readonly reason: string };

// ─── Constants ───────────────────────────────────────────────────────────────

/** The prefix that FlowGuard tools use to signal subagent review is required. */
export const REVIEW_REQUIRED_PREFIX = 'INDEPENDENT_REVIEW_REQUIRED';

/** The subagent type name for the FlowGuard reviewer. */
export { REVIEWER_SUBAGENT_TYPE } from './tool-names.js';

/**
 * Minimum prompt length for subagent calls (Level 3).
 * A real review prompt must include plan/implementation text, ticket context,
 * iteration, and planVersion. 200 characters is a generous floor that catches
 * empty or trivially short prompts.
 */
export const MIN_SUBAGENT_PROMPT_LENGTH = 200;

// ─── State factory ───────────────────────────────────────────────────────────

/** Create a fresh enforcement state for a session. */
export function createSessionState(): SessionEnforcementState {
  return { pendingReviews: new Map() };
}

// ─── Hook handlers (pure functions) ──────────────────────────────────────────

/**
 * Process a FlowGuard tool response (tool.execute.after).
 *
 * Mode A (plan/impl submission): If the response `next` field starts with
 * INDEPENDENT_REVIEW_REQUIRED, registers a pending review with content metadata
 * extracted from the message.
 *
 * Mode B (verdict submission): If the call succeeded, clears the pending review.
 *
 * @param state - Session enforcement state (mutated in place)
 * @param toolName - FlowGuard tool name
 * @param args - Tool call arguments
 * @param output - Raw tool output string
 * @param now - ISO 8601 timestamp
 */
export function onFlowGuardToolAfter(
  state: SessionEnforcementState,
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  now: string,
): void {
  if (toolName !== TOOL_FLOWGUARD_PLAN && toolName !== TOOL_FLOWGUARD_IMPLEMENT) return;

  const reviewTool = toolName as ReviewableTool;
  const parsed = safeParse(output);
  if (!parsed) return;

  // Mode B: agent is submitting a verdict → clear pending review on success
  const hasSelfReviewVerdict = 'selfReviewVerdict' in args || 'reviewVerdict' in args;
  if (hasSelfReviewVerdict) {
    // Only clear if the call succeeded (no error in output)
    if (parsed.error !== true) {
      state.pendingReviews.delete(reviewTool);
    }
  }

  const next = typeof parsed.next === 'string' ? parsed.next : '';
  if (next.startsWith(REVIEW_REQUIRED_PREFIX)) {
    state.pendingReviews.set(reviewTool, {
      tool: reviewTool,
      requestedAt: now,
      subagentCalled: false,
      subagentRecord: null,
      contentMeta: extractContentMeta(next),
      capturedFindings: null,
    });
  }
}

/**
 * Enforce prompt integrity before allowing a subagent call (Level 3).
 * Called in tool.execute.before for task calls with subagent_type=flowguard-reviewer.
 *
 * Validates:
 * 1. Prompt meets minimum length (catches empty/trivial prompts)
 * 2. Prompt contains expected iteration value (contextual match)
 * 3. Prompt contains expected planVersion value (contextual match, plan only)
 *
 * @param state - Session enforcement state (read-only check)
 * @param taskArgs - Task tool call arguments
 * @returns Enforcement result
 */
export function enforceBeforeSubagentCall(
  state: SessionEnforcementState,
  taskArgs: Record<string, unknown>,
  strictEnforcement = false,
): EnforcementResult {
  const subagentType = typeof taskArgs.subagent_type === 'string' ? taskArgs.subagent_type : '';
  if (subagentType !== REVIEWER_SUBAGENT_TYPE) return { allowed: true };

  const prompt = typeof taskArgs.prompt === 'string' ? taskArgs.prompt : '';

  // Collect pending reviews that haven't had a subagent call yet
  const pendingReviews = [...state.pendingReviews.values()].filter((p) => !p.subagentCalled);
  if (pendingReviews.length === 0) {
    // No pending review — subagent call without prior FlowGuard tool signal.
    // Allow: could be a legitimate retry or the first call in a new iteration.
    return { allowed: true };
  }

  // Check prompt is substantive (not empty/trivial)
  if (prompt.length < MIN_SUBAGENT_PROMPT_LENGTH) {
    return {
      allowed: false,
      code: 'SUBAGENT_PROMPT_EMPTY',
      reason:
        `FlowGuard enforcement: the prompt for ${REVIEWER_SUBAGENT_TYPE} is too short ` +
        `(${prompt.length} chars, minimum ${MIN_SUBAGENT_PROMPT_LENGTH}). ` +
        `Include the plan/implementation text, ticket text, iteration, and planVersion.`,
    };
  }

  // Check prompt contains expected context from at least one pending review
  const missingFields: string[] = [];
  let hasMatchingContext = false;

  for (const pending of pendingReviews) {
    if (!pending.contentMeta) {
      // Content meta extraction failed — strict enforcement requires verifiable context
      if (strictEnforcement) {
        return {
          allowed: false,
          code: 'SUBAGENT_CONTEXT_UNVERIFIABLE',
          reason:
            'Content meta extraction failed — cannot validate subagent context in strict mode. ' +
            'The FlowGuard tool response must include structured review obligation metadata.',
        };
      }
      // Non-strict: allow with explicit degradation
      hasMatchingContext = true;
      break;
    }

    const { expectedIteration, expectedPlanVersion } = pending.contentMeta;
    const hasIteration = promptContainsValue(prompt, 'iteration', expectedIteration);
    const hasPlanVersion =
      expectedPlanVersion === null || promptContainsValue(prompt, 'version', expectedPlanVersion);

    if (hasIteration && hasPlanVersion) {
      hasMatchingContext = true;
      break;
    }

    if (!hasIteration) missingFields.push(`iteration=${expectedIteration}`);
    if (!hasPlanVersion && expectedPlanVersion !== null) {
      missingFields.push(`planVersion=${expectedPlanVersion}`);
    }
  }

  if (!hasMatchingContext) {
    return {
      allowed: false,
      code: 'SUBAGENT_PROMPT_MISSING_CONTEXT',
      reason:
        `FlowGuard enforcement: the prompt for ${REVIEWER_SUBAGENT_TYPE} does not contain ` +
        `the expected review context. Missing: ${[...new Set(missingFields)].join(', ')}. ` +
        `Include the iteration and planVersion values from the FlowGuard tool response.`,
    };
  }

  return { allowed: true };
}

/**
 * Process a Task tool completion (tool.execute.after for 'task').
 *
 * If the Task call was to flowguard-reviewer:
 * - Matches exactly one pending review obligation via contentMeta (P34 1:1 contract)
 * - Records the subagent session ID — null if extraction fails (Level 2 strict)
 * - Captures actual findings from the subagent response (Level 4)
 *
 * 1:1 obligation matching: Each Task call satisfies exactly one pending review.
 * P34a (plan) and P34b (implement) are independent obligations. When multiple
 * are pending, the prompt's iteration/planVersion must match the target obligation's
 * contentMeta. If only one is pending, it is matched unambiguously.
 *
 * @param state - Session enforcement state (mutated in place)
 * @param args - Task tool arguments (expects subagent_type and prompt fields)
 * @param taskResult - Raw task result string (subagent response)
 * @param now - ISO 8601 timestamp
 */
export function onTaskToolAfter(
  state: SessionEnforcementState,
  args: Record<string, unknown>,
  taskResult: string,
  now: string,
): void {
  const subagentType = typeof args.subagent_type === 'string' ? args.subagent_type : '';
  if (subagentType !== REVIEWER_SUBAGENT_TYPE) return;

  // Extract session ID — null if extraction fails (no fallback, strict)
  const sessionId = extractSubagentSessionId(taskResult);

  // Capture actual findings from the subagent response
  const capturedFindings = extractCapturedFindings(taskResult);

  const record: SubagentRecord = {
    sessionId,
    completedAt: now,
  };

  // Match exactly ONE pending review obligation (P34 1:1 contract).
  // Each subagent call satisfies one obligation. If both plan and implement
  // reviews are pending, each requires its own subagent invocation.
  const matched = matchPendingReview(state, args);
  if (matched) {
    matched.subagentCalled = true;
    matched.subagentRecord = record;
    matched.capturedFindings = capturedFindings;
  }
}

/**
 * Match a Task call to exactly one pending review obligation.
 *
 * Matching strategy (P34 1:1 contract):
 * - 0 pending: null (no obligation to satisfy)
 * - 1 pending: that one (unambiguous — L3 already validated the prompt)
 * - >1 pending: match by contentMeta (iteration + planVersion from prompt)
 * - >1 pending, no contentMeta match: null (fail-closed, ambiguous)
 *
 * @param state - Session enforcement state (read-only)
 * @param taskArgs - Task tool call arguments (expects prompt field)
 * @returns The matched PendingReview, or null if no match
 */
export function matchPendingReview(
  state: SessionEnforcementState,
  taskArgs: Record<string, unknown>,
): PendingReview | null {
  const uncalled = [...state.pendingReviews.values()].filter((p) => !p.subagentCalled);

  if (uncalled.length === 0) return null;
  if (uncalled.length === 1) return uncalled[0]!;

  // Multiple pending — match by contentMeta from prompt
  const prompt = typeof taskArgs.prompt === 'string' ? taskArgs.prompt : '';

  for (const pending of uncalled) {
    if (!pending.contentMeta) continue;

    const { expectedIteration, expectedPlanVersion } = pending.contentMeta;
    const hasIteration = promptContainsValue(prompt, 'iteration', expectedIteration);
    const hasPlanVersion =
      expectedPlanVersion === null || promptContainsValue(prompt, 'version', expectedPlanVersion);

    if (hasIteration && hasPlanVersion) return pending;
  }

  return null; // No match — fail-closed
}

/**
 * Enforce subagent invocation and findings integrity before allowing a
 * self-review verdict (tool.execute.before for flowguard_plan/flowguard_implement).
 *
 * Enforcement checks (in order):
 * - Level 1: Binary gate — subagent must have been called
 * - Level 2: Session ID match — when both actual and submitted IDs are available
 * - Level 4: Findings integrity — submitted overallVerdict and blockingIssues count
 *   must match the actual subagent response
 *
 * Returns { allowed: true } if no enforcement is needed, or
 * { allowed: false, code, reason } if the call should be blocked.
 *
 * @param state - Session enforcement state (read-only check)
 * @param toolName - FlowGuard tool name
 * @param args - Tool call arguments
 * @returns Enforcement result
 */
export function enforceBeforeVerdict(
  state: SessionEnforcementState,
  toolName: string,
  args: Record<string, unknown>,
  sessionState?: SessionState | null,
  strictEnforcement = false,
): EnforcementResult {
  if (toolName !== TOOL_FLOWGUARD_PLAN && toolName !== TOOL_FLOWGUARD_IMPLEMENT) {
    return { allowed: true };
  }

  const reviewTool = toolName as ReviewableTool;

  // Only enforce on Mode B calls (verdict submission)
  const hasSelfReviewVerdict = 'selfReviewVerdict' in args || 'reviewVerdict' in args;
  if (!hasSelfReviewVerdict) return { allowed: true };

  // Check if there's a pending review for this tool
  const pending = state.pendingReviews.get(reviewTool);
  if (!pending) {
    // P35 Recovery: Reconstruct from session-state.json when transient cache miss
    if (sessionState?.reviewAssurance?.obligations) {
      const pendingObligation = sessionState.reviewAssurance.obligations.find(
        (o) =>
          o.status === 'pending' &&
          ((reviewTool === TOOL_FLOWGUARD_PLAN && o.obligationType === 'plan') ||
            (reviewTool === TOOL_FLOWGUARD_IMPLEMENT && o.obligationType === 'implement')),
      );
      if (pendingObligation) {
        return {
          allowed: false,
          code: 'SUBAGENT_REVIEW_NOT_INVOKED',
          reason:
            `FlowGuard enforcement: recovered from session state — obligation ` +
            `${pendingObligation.obligationId} is pending but no subagent call was recorded ` +
            `in the transient enforcement state. A ${REVIEWER_SUBAGENT_TYPE} subagent call via the ` +
            `Task tool is required to fulfill this P35 obligation.`,
        };
      }
      // No pending obligations — genuinely no requirement
      return { allowed: true };
    }
    // Strict: state unreadable → fail-closed
    if (strictEnforcement) {
      return {
        allowed: false,
        code: 'REVIEW_ASSURANCE_STATE_UNAVAILABLE',
        reason:
          'Cannot verify review obligation fulfillment in strict mode — ' +
          'enforcement state is unavailable and session state cannot be read. ' +
          'Re-hydrate the session or run /continue before submitting a verdict.',
      };
    }
    return { allowed: true };
  }

  // ── Level 1: Binary gate — subagent must have been called ──────────────
  if (!pending.subagentCalled) {
    return {
      allowed: false,
      code: 'SUBAGENT_REVIEW_NOT_INVOKED',
      reason:
        `FlowGuard enforcement: ${reviewTool} signaled INDEPENDENT_REVIEW_REQUIRED ` +
        `but no Task call to ${REVIEWER_SUBAGENT_TYPE} was detected. ` +
        `You MUST call the ${REVIEWER_SUBAGENT_TYPE} subagent via the Task tool before ` +
        `submitting a self-review verdict.`,
    };
  }

  // ── Level 2: Session ID match (strict when both IDs available) ─────────
  const reviewFindings = args.reviewFindings as Record<string, unknown> | undefined;
  if (reviewFindings && pending.subagentRecord) {
    const reviewedBy = reviewFindings.reviewedBy as Record<string, unknown> | undefined;
    const submittedSessionId =
      typeof reviewedBy?.sessionId === 'string' ? reviewedBy.sessionId : null;

    if (
      submittedSessionId &&
      pending.subagentRecord.sessionId !== null &&
      submittedSessionId !== pending.subagentRecord.sessionId
    ) {
      return {
        allowed: false,
        code: 'SUBAGENT_SESSION_MISMATCH',
        reason:
          `FlowGuard enforcement: reviewFindings.reviewedBy.sessionId ` +
          `("${submittedSessionId}") does not match the actual subagent session ` +
          `("${pending.subagentRecord.sessionId}"). ` +
          `The findings must come from the flowguard-reviewer subagent that was invoked.`,
      };
    }
  }

  // ── Level 4: Findings integrity — submitted must match captured ────────
  if (reviewFindings && pending.capturedFindings) {
    const submittedVerdict =
      typeof reviewFindings.overallVerdict === 'string' ? reviewFindings.overallVerdict : null;
    const submittedBlockingIssues = Array.isArray(reviewFindings.blockingIssues)
      ? reviewFindings.blockingIssues
      : null;

    // Verdict must match the actual subagent verdict
    if (submittedVerdict !== null && submittedVerdict !== pending.capturedFindings.overallVerdict) {
      return {
        allowed: false,
        code: 'SUBAGENT_FINDINGS_VERDICT_MISMATCH',
        reason:
          `FlowGuard enforcement: submitted reviewFindings.overallVerdict ` +
          `("${submittedVerdict}") does not match the actual subagent verdict ` +
          `("${pending.capturedFindings.overallVerdict}"). ` +
          `The findings must not be modified after the subagent produces them.`,
      };
    }

    // Blocking issues count must match
    if (
      submittedBlockingIssues !== null &&
      submittedBlockingIssues.length !== pending.capturedFindings.blockingIssuesCount
    ) {
      return {
        allowed: false,
        code: 'SUBAGENT_FINDINGS_ISSUES_MISMATCH',
        reason:
          `FlowGuard enforcement: submitted reviewFindings.blockingIssues count ` +
          `(${submittedBlockingIssues.length}) does not match the actual subagent count ` +
          `(${pending.capturedFindings.blockingIssuesCount}). ` +
          `The findings must not be modified after the subagent produces them.`,
      };
    }
  }

  return { allowed: true };
}

// ─── Plugin-Initiated Review Recording ───────────────────────────────────────

/**
 * Record a plugin-initiated review invocation on a pending review.
 *
 * When the plugin orchestrator invokes the reviewer subagent directly
 * (deterministic path), it bypasses the Task tool. This function updates
 * the enforcement state as if a Task call had been made, so that
 * subsequent L1/L2/L4 checks pass for the verdict submission.
 *
 * @param state - Session enforcement state (mutated in place)
 * @param toolName - Which tool's pending review to satisfy ('flowguard_plan' or 'flowguard_implement')
 * @param sessionId - The child session ID from the orchestrator
 * @param capturedFindings - The findings captured from the reviewer response
 * @param now - ISO 8601 timestamp
 * @returns true if a pending review was found and updated, false otherwise
 */
export function recordPluginReview(
  state: SessionEnforcementState,
  toolName: string,
  sessionId: string,
  capturedFindings: CapturedFindings | null,
  now: string,
): boolean {
  if (toolName !== TOOL_FLOWGUARD_PLAN && toolName !== TOOL_FLOWGUARD_IMPLEMENT) return false;

  const reviewTool = toolName as ReviewableTool;
  const pending = state.pendingReviews.get(reviewTool);
  if (!pending || pending.subagentCalled) return false;

  pending.subagentCalled = true;
  pending.subagentRecord = {
    sessionId,
    completedAt: now,
  };
  pending.capturedFindings = capturedFindings;
  return true;
}

// ─── Helpers (exported for testing) ──────────────────────────────────────────

/**
 * Extract content metadata (iteration, planVersion) from the
 * INDEPENDENT_REVIEW_REQUIRED message string.
 *
 * The FlowGuard tools embed these values in the `next` field:
 * - plan Mode A: "... iteration=0, (4) planVersion=3 ..."
 * - plan Mode B: "... iteration=2, (4) planVersion=4 ..."
 * - implement Mode A: "... iteration=1, (5) planVersion=3 ..."
 *
 * @returns ContentMeta or null if iteration cannot be extracted
 */
export function extractContentMeta(nextField: string): ContentMeta | null {
  const iterMatch = nextField.match(/iteration[=:\s]+(\d+)/i);
  if (!iterMatch) return null;

  const versionMatch = nextField.match(/planVersion[=:\s]+(\d+)/i);

  return {
    expectedIteration: parseInt(iterMatch[1]!, 10),
    expectedPlanVersion: versionMatch ? parseInt(versionMatch[1]!, 10) : null,
  };
}

/**
 * Extract key fields from the actual subagent response for integrity checking.
 *
 * The flowguard-reviewer subagent returns a JSON ReviewFindings object.
 * The Task tool may wrap this in additional text. We attempt both direct
 * JSON parse and regex-based extraction.
 *
 * @returns CapturedFindings or null if extraction fails
 */
export function extractCapturedFindings(taskResult: string): CapturedFindings | null {
  // Try direct JSON parse
  try {
    const parsed = JSON.parse(taskResult) as unknown;
    const result = extractFindingsFromObject(parsed);
    if (result) return result;
  } catch {
    // Not clean JSON — continue to regex extraction
  }

  // Try to find a JSON block containing overallVerdict in the response
  const jsonMatch = taskResult.match(/\{[^{}]*"overallVerdict"\s*:\s*"[^"]+"/);
  if (jsonMatch) {
    // Try to find the complete JSON object by finding the matching closing brace
    const startIdx = taskResult.indexOf(jsonMatch[0]);
    const candidate = extractJsonBlock(taskResult, startIdx);
    if (candidate) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        const result = extractFindingsFromObject(parsed);
        if (result) return result;
      } catch {
        // Parse failed — fall through
      }
    }
  }

  return null;
}

/**
 * Check whether a reviewer prompt contains a specific numeric value
 * associated with a keyword (e.g. "iteration", "version").
 *
 * Used in L3 prompt-context enforcement (`enforceBeforeVerdict` and
 * `enforceBeforeSubagentCall`) to verify the prompt was constructed
 * with the runtime's expected iteration/planVersion values, not stale
 * values from a previous turn.
 *
 * Matching rules:
 * - Case-insensitive keyword match.
 * - Up to 30 non-digit characters between keyword and number. This
 *   accommodates all formats currently produced by mandate templates
 *   (`iteration=0`, `Iteration: 0`, `iteration 0`) plus future XML
 *   wrappers (`<iteration>0</iteration>` — `>` is a single non-digit
 *   character) and JSON embeds (`"iteration": 0` — `": ` is 3 chars).
 * - The 30-char ceiling intentionally rejects long-distance "matches"
 *   where the number is unrelated to the keyword (e.g. an iteration
 *   keyword followed by a sentence and then an unrelated number).
 *
 * Word-boundary semantics:
 * - `\b` at the suffix prevents partial-number matches: expected=1
 *   does NOT match "iteration=12" because `1` is followed by digit
 *   `2` (no word boundary between two digits).
 * - The prefix is bounded by the keyword + a non-digit gap (`[^\d]`),
 *   so a number embedded inside another number cannot be mis-attributed
 *   (e.g. expected=1 against "iteration=21" — the `[^\d]` separator
 *   forbids the leading `2` to count as the gap).
 *
 * @param prompt - The full prompt text
 * @param keyword - The keyword to match near (e.g. "iteration", "version")
 * @param expected - The expected numeric value
 * @returns true if the prompt contains the keyword-number pair
 */
export function promptContainsValue(prompt: string, keyword: string, expected: number): boolean {
  // Match keyword followed by up to 30 non-digit chars then the expected number
  const pattern = new RegExp(`${keyword}[^\\d]{0,30}${expected}\\b`, 'i');
  return pattern.test(prompt);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Parse JSON safely, handling NextAction footer lines.
 * Returns null on parse failure.
 */
function safeParse(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    try {
      const firstLine = raw.split('\n')[0] ?? '';
      if (!firstLine.trim()) return null;
      return JSON.parse(firstLine) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

/**
 * Extract the subagent session ID from the Task tool response.
 *
 * The flowguard-reviewer subagent returns a JSON ReviewFindings object
 * with a reviewedBy.sessionId field. The Task tool wraps this in its
 * own response format. We attempt to extract it.
 *
 * Returns null if extraction fails (no fallback — strict for Level 2).
 */
function extractSubagentSessionId(taskResult: string): string | null {
  try {
    // Try direct JSON parse (subagent might return clean JSON)
    const parsed = JSON.parse(taskResult) as Record<string, unknown>;
    const direct = extractSessionIdFromObject(parsed);
    if (direct) return direct;
  } catch {
    // Not clean JSON — try to find JSON in the text
  }

  // Try to find embedded JSON blocks containing "reviewedBy"
  let searchFrom = 0;
  while (searchFrom < taskResult.length) {
    const markerIdx = taskResult.indexOf('"reviewedBy"', searchFrom);
    if (markerIdx < 0) break;

    const startIdx = taskResult.lastIndexOf('{', markerIdx);
    if (startIdx < 0) break;

    const candidate = extractJsonBlock(taskResult, startIdx);
    if (candidate) {
      try {
        const parsed = JSON.parse(candidate) as Record<string, unknown>;
        const extracted = extractSessionIdFromObject(parsed);
        if (extracted) return extracted;
      } catch {
        // Continue scanning for another candidate
      }
      // Ensure forward progress: advance past the marker if the candidate
      // ended before it (e.g., lastIndexOf found a { from a different block
      // that precedes the marker). Without this, the same marker is re-found
      // on the next iteration, causing an infinite loop.
      searchFrom = Math.max(startIdx + candidate.length, markerIdx + '"reviewedBy"'.length);
      continue;
    }

    searchFrom = markerIdx + '"reviewedBy"'.length;
  }

  return null;
}

function extractSessionIdFromObject(obj: Record<string, unknown>): string | null {
  const reviewedBy = obj.reviewedBy as Record<string, unknown> | undefined;
  if (typeof reviewedBy?.sessionId === 'string') {
    return reviewedBy.sessionId;
  }
  if (typeof obj.sessionId === 'string') {
    return obj.sessionId;
  }
  return null;
}

/**
 * Extract CapturedFindings fields from a parsed object.
 * Returns null if the object doesn't contain a valid overallVerdict.
 */
function extractFindingsFromObject(obj: unknown): CapturedFindings | null {
  if (!obj || typeof obj !== 'object') return null;

  const record = obj as Record<string, unknown>;
  const overallVerdict = typeof record.overallVerdict === 'string' ? record.overallVerdict : null;
  if (!overallVerdict) return null;

  const blockingIssues = Array.isArray(record.blockingIssues) ? record.blockingIssues : [];
  const reviewedBy = record.reviewedBy as Record<string, unknown> | undefined;
  const sessionId = typeof reviewedBy?.sessionId === 'string' ? reviewedBy.sessionId : null;

  return {
    overallVerdict,
    blockingIssuesCount: blockingIssues.length,
    sessionId,
  };
}

/**
 * Extract a complete JSON block starting from a given index.
 * Counts braces to find the matching closing brace.
 */
function extractJsonBlock(text: string, startIdx: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(startIdx, i + 1);
      }
    }
  }

  return null;
}
