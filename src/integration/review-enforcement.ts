/**
 * @module integration/review-enforcement
 * @description Runtime enforcement for independent review subagent invocation.
 *
 * Problem: FlowGuard tools return advisory `next` messages instructing the
 * primary agent to call the flowguard-reviewer subagent via the Task tool.
 * However, the primary agent could ignore this instruction and fabricate
 * ReviewFindings without actually invoking the subagent.
 *
 * Solution: This module observes the entire tool-call sequence via OpenCode's
 * plugin hook system (tool.execute.before/after) and enforces that:
 * 1. When a FlowGuard tool signals INDEPENDENT_REVIEW_REQUIRED, a Task call
 *    to flowguard-reviewer MUST occur before the next selfReviewVerdict.
 * 2. The submitted reviewFindings.reviewedBy.sessionId must match the actual
 *    subagent session ID from the Task call.
 *
 * Architecture:
 * - Pure logic module — no OpenCode/plugin dependencies, fully unit-testable.
 * - Plugin integration happens in plugin.ts (delegates to this module).
 * - Session-scoped state tracked per session ID.
 *
 * Enforcement levels:
 * - Level 1: Verify Task call to flowguard-reviewer was made (binary gate)
 * - Level 2: Verify reviewedBy.sessionId matches actual subagent session ID
 *
 * Conformance: Uses documented OpenCode plugin hooks (tool.execute.before/after)
 * per https://opencode.ai/docs/plugins
 *
 * @version v1
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Tools that can trigger independent review. */
export type ReviewableTool = 'flowguard_plan' | 'flowguard_implement';

/** Record of a completed subagent invocation. */
export interface SubagentRecord {
  /** Subagent session ID returned by the Task tool. */
  readonly sessionId: string;
  /** ISO 8601 timestamp when the Task call completed. */
  readonly completedAt: string;
}

/** Per-tool pending review state. */
export interface PendingReview {
  /** Which tool signaled the review requirement. */
  readonly tool: ReviewableTool;
  /** ISO 8601 timestamp when the requirement was signaled. */
  readonly requestedAt: string;
  /** Whether a Task call to flowguard-reviewer has been made. */
  subagentCalled: boolean;
  /** Record of the actual subagent call, if made. */
  subagentRecord: SubagentRecord | null;
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

// ─── Prefix constant ─────────────────────────────────────────────────────────

/** The prefix that FlowGuard tools use to signal subagent review is required. */
export const REVIEW_REQUIRED_PREFIX = 'INDEPENDENT_REVIEW_REQUIRED';

/** The subagent type name for the FlowGuard reviewer. */
export const REVIEWER_SUBAGENT_TYPE = 'flowguard-reviewer';

// ─── State factory ───────────────────────────────────────────────────────────

/** Create a fresh enforcement state for a session. */
export function createSessionState(): SessionEnforcementState {
  return { pendingReviews: new Map() };
}

// ─── Hook handlers (pure functions) ──────────────────────────────────────────

/**
 * Process a FlowGuard tool response (tool.execute.after).
 *
 * If the response `next` field starts with INDEPENDENT_REVIEW_REQUIRED,
 * registers a pending review for that tool.
 *
 * If the response is a Mode B result (selfReviewVerdict present in args),
 * clears the pending review for that tool.
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
  if (toolName !== 'flowguard_plan' && toolName !== 'flowguard_implement') return;

  const reviewTool = toolName as ReviewableTool;

  // Mode B: agent is submitting a verdict → clear pending review on success
  const hasSelfReviewVerdict = 'selfReviewVerdict' in args || 'reviewVerdict' in args;
  if (hasSelfReviewVerdict) {
    // Only clear if the call succeeded (no error in output)
    const parsed = safeParse(output);
    if (parsed && parsed.error !== true) {
      state.pendingReviews.delete(reviewTool);
    }
    return;
  }

  // Mode A: check if response signals review required
  const parsed = safeParse(output);
  if (!parsed) return;

  const next = typeof parsed.next === 'string' ? parsed.next : '';
  if (next.startsWith(REVIEW_REQUIRED_PREFIX)) {
    state.pendingReviews.set(reviewTool, {
      tool: reviewTool,
      requestedAt: now,
      subagentCalled: false,
      subagentRecord: null,
    });
  }
}

/**
 * Process a Task tool completion (tool.execute.after for 'task').
 *
 * If the Task call was to flowguard-reviewer, marks the pending review as
 * having a completed subagent call and records the subagent session ID.
 *
 * @param state - Session enforcement state (mutated in place)
 * @param args - Task tool arguments (expects subagent_type field)
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

  // Extract session ID from the task result if possible.
  // The Task tool returns the subagent's response. The subagent includes
  // reviewedBy.sessionId in its JSON output.
  const sessionId = extractSubagentSessionId(taskResult);

  const record: SubagentRecord = {
    sessionId: sessionId ?? `task-${now}`,
    completedAt: now,
  };

  // Mark ALL pending reviews as having a subagent call.
  // The subagent reviews the current state — both plan and implement
  // reviews are satisfied by a single subagent invocation if both are pending.
  for (const pending of state.pendingReviews.values()) {
    pending.subagentCalled = true;
    pending.subagentRecord = record;
  }
}

/**
 * Enforce subagent invocation before allowing a self-review verdict
 * (tool.execute.before for flowguard_plan/flowguard_implement).
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
): EnforcementResult {
  if (toolName !== 'flowguard_plan' && toolName !== 'flowguard_implement') {
    return { allowed: true };
  }

  const reviewTool = toolName as ReviewableTool;

  // Only enforce on Mode B calls (verdict submission)
  const hasSelfReviewVerdict = 'selfReviewVerdict' in args || 'reviewVerdict' in args;
  if (!hasSelfReviewVerdict) return { allowed: true };

  // Check if there's a pending review for this tool
  const pending = state.pendingReviews.get(reviewTool);
  if (!pending) return { allowed: true }; // No pending review = no enforcement

  // Enforce: subagent must have been called
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

  // Enforce: if reviewFindings provided, sessionId must match subagent session
  const reviewFindings = args.reviewFindings as Record<string, unknown> | undefined;
  if (reviewFindings && pending.subagentRecord) {
    const reviewedBy = reviewFindings.reviewedBy as Record<string, unknown> | undefined;
    const submittedSessionId =
      typeof reviewedBy?.sessionId === 'string' ? reviewedBy.sessionId : null;

    if (
      submittedSessionId &&
      pending.subagentRecord.sessionId !== `task-${pending.subagentRecord.completedAt}`
    ) {
      // We have a real subagent session ID (not the fallback)
      if (submittedSessionId !== pending.subagentRecord.sessionId) {
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
  }

  return { allowed: true };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse JSON safely, handling NextAction footer lines.
 * Returns null on parse failure.
 */
function safeParse(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      const firstLine = raw.split('\n')[0] ?? '';
      if (!firstLine.trim()) return null;
      return JSON.parse(firstLine);
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
 */
function extractSubagentSessionId(taskResult: string): string | null {
  try {
    // Try direct JSON parse (subagent might return clean JSON)
    const parsed = JSON.parse(taskResult);
    if (typeof parsed?.reviewedBy?.sessionId === 'string') {
      return parsed.reviewedBy.sessionId;
    }
  } catch {
    // Not clean JSON — try to find JSON in the text
  }

  // Try to find a JSON block in the response
  const jsonMatch = taskResult.match(
    /\{[\s\S]*"reviewedBy"\s*:\s*\{[\s\S]*"sessionId"\s*:\s*"([^"]+)"/,
  );
  if (jsonMatch?.[1]) {
    return jsonMatch[1];
  }

  return null;
}
