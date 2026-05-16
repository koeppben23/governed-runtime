/**
 * @module integration/review-enforcement
 * @description Runtime enforcement for independent review subagent invocation.
 *
 * Contains the state factory and hook handlers (pure functions) that enforce
 * four levels of review integrity:
 *
 * - Level 1 (Binary Gate): A Task call to flowguard-reviewer MUST occur
 *   before any verdict submission.
 * - Level 2 (Session ID): Submitted sessionId must match actual subagent session.
 * - Level 3 (Prompt Integrity): Task call prompt must contain expected context.
 * - Level 4 (Findings Integrity): Submitted findings must match actual response.
 *
 * Extracted modules (FG-REL-038):
 * - review-enforcement-types.ts — Types, interfaces, constants
 * - review-enforcement-extraction.ts — Pure parsing/extraction helpers
 * - review-evidence-binding.ts — Host-task evidence binding
 *
 * Architecture:
 * - Pure logic module — no OpenCode/plugin dependencies, fully unit-testable.
 * - Plugin integration happens in plugin.ts (delegates to this module).
 * - Session-scoped state tracked per session ID.
 *
 * @version v4
 */

import type { SessionState } from '../../../state/schema.js';
import {
  type SessionEnforcementState,
  type PendingReview,
  type CapturedFindings,
  type SubagentRecord,
  type TaskToolContext,
  type EnforcementResult,
  type PendingReviewTool,
  REVIEW_REQUIRED_PREFIX,
  MIN_SUBAGENT_PROMPT_LENGTH,
} from './types.js';
import {
  extractContentMeta,
  extractCapturedFindings,
  extractSubagentSessionId,
  resolveSessionIdFromMetadata,
  promptContainsValue,
} from './extraction.js';

import { REVIEWER_SUBAGENT_TYPE, TOOL_FLOWGUARD_REVIEW } from '../../tool-names.js';
import {
  isReviewableTool,
  obligationTypeForTool,
  type ReviewableTool,
} from '../obligation-tools.js';
import { parseToolResult } from '../../plugin-helpers.js';

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
  const isStandaloneReviewTool = toolName === TOOL_FLOWGUARD_REVIEW;
  if (!isReviewableTool(toolName) && !isStandaloneReviewTool) return;

  const reviewTool: PendingReviewTool = toolName;
  const parsed = parseToolResult(output);
  if (!parsed) return;

  // Mode B: agent is submitting a verdict → clear pending review on success.
  // BUG-21: Use value-based checks — the `in` operator returns true for keys
  // with null values (LLMs may send explicit nulls for absent optional fields).
  const hasSelfReviewVerdict =
    (typeof args.reviewVerdict === 'string' && args.reviewVerdict.length > 0) ||
    (typeof args.reviewVerdict === 'string' && args.reviewVerdict.length > 0);
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

  const requiredReviewAttestation = parsed.requiredReviewAttestation as
    | Record<string, unknown>
    | undefined;
  if (
    parsed.error === true &&
    parsed.code === 'CONTENT_ANALYSIS_REQUIRED' &&
    requiredReviewAttestation &&
    isStandaloneReviewTool
  ) {
    state.pendingReviews.set(TOOL_FLOWGUARD_REVIEW, {
      tool: TOOL_FLOWGUARD_REVIEW,
      requestedAt: now,
      subagentCalled: false,
      subagentRecord: null,
      contentMeta: { expectedIteration: 1, expectedPlanVersion: 1 },
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
 * Session ID resolution (BUG-14 fix — three-tiered):
 *
 * Tier 1: Hook metadata — `context.metadata.sessionID` from the task tool runtime.
 * Tier 2: Text extraction — parse `reviewedBy.sessionId` from the reviewer's JSON output.
 * Tier 3: Synthetic — `derived:call:${context.callID}`. Guaranteed unique per invocation.
 *
 * @param state - Session enforcement state (mutated in place)
 * @param args - Task tool arguments (expects subagent_type and prompt fields)
 * @param taskResult - Raw task result string (subagent response)
 * @param now - ISO 8601 timestamp
 * @param context - Optional hook context for tiered session ID resolution
 */
export function onTaskToolAfter(
  state: SessionEnforcementState,
  args: Record<string, unknown>,
  taskResult: string,
  now: string,
  context?: TaskToolContext,
): void {
  const subagentType = typeof args.subagent_type === 'string' ? args.subagent_type : '';
  if (subagentType !== REVIEWER_SUBAGENT_TYPE) return;

  // Tiered session ID resolution (BUG-14 fix):
  // Tier 1: Hook metadata — authoritative from task tool runtime
  let sessionId = resolveSessionIdFromMetadata(context?.metadata);
  // Tier 2: Text extraction — parse from reviewer's JSON output
  if (!sessionId) sessionId = extractSubagentSessionId(taskResult);
  // Tier 3: Synthetic from callID — guaranteed unique for deduplication
  if (!sessionId && context?.callID) sessionId = `derived:call:${context.callID}`;

  // Capture actual findings from the subagent response
  const capturedFindings = extractCapturedFindings(taskResult);

  const record: SubagentRecord = {
    sessionId,
    completedAt: now,
  };

  // Match exactly ONE pending review obligation (P34 1:1 contract).
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
 * - Level 4: Findings integrity — submitted must match captured
 */
export function enforceBeforeVerdict(
  state: SessionEnforcementState,
  toolName: string,
  args: Record<string, unknown>,
  sessionState?: { reviewAssurance?: SessionState['reviewAssurance'] | null } | null,
  strictEnforcement = false,
): EnforcementResult {
  if (!isReviewableTool(toolName)) {
    return { allowed: true };
  }

  const reviewTool: ReviewableTool = toolName;

  // Only enforce on Mode B calls (verdict submission).
  // BUG-21: Use value-based checks — the `in` operator returns true for keys
  // with null values (DeepSeek R1 sends explicit nulls for optional fields).
  const selfReviewValue = args.reviewVerdict;
  const reviewVerdictValue = args.reviewVerdict;
  const hasSelfReviewVerdict =
    (typeof selfReviewValue === 'string' && selfReviewValue.length > 0) ||
    (typeof reviewVerdictValue === 'string' && reviewVerdictValue.length > 0);
  if (!hasSelfReviewVerdict) return { allowed: true };

  // Check if there's a pending review for this tool
  const pending = state.pendingReviews.get(reviewTool);
  if (!pending) {
    // BUG-21 Fix B: Separate "state is readable" from "has obligations".
    if (sessionState) {
      const obligations = sessionState.reviewAssurance?.obligations;
      if (!obligations || obligations.length === 0) {
        // Session state is readable but no review obligations exist yet — allowed
        return { allowed: true };
      }
      // P35 Recovery: Reconstruct from session-state.json when transient cache miss
      const pendingObligation = obligations.find(
        (o) => o.status === 'pending' && o.obligationType === obligationTypeForTool(reviewTool),
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
    // Session state is unreadable (null/undefined) → fail-closed in strict mode
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
          `The findings must come from the ${REVIEWER_SUBAGENT_TYPE} subagent that was invoked.`,
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
 * @param toolName - Which tool's pending review to satisfy
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
  if (!isReviewableTool(toolName)) return false;

  const reviewTool: ReviewableTool = toolName;
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
