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
import { type ReviewObligation } from '../../../state/evidence-review.js';
import {
  type SessionEnforcementState,
  type PendingReview,
  type CapturedFindings,
  type SubagentRecord,
  type TaskToolContext,
  type EnforcementResult,
  type PendingReviewTool,
  REVIEW_REQUIRED_PREFIX,
} from './types.js';
import {
  canonicalPromptAnchorOf,
  canonicalPromptDigestOf,
  canonicalPromptOf,
} from './prompt-contract.js';
import {
  extractCapturedFindings,
  resolveSubagentSessionId,
  promptContainsValue,
  detectStepExhaustion,
  signalAttestationOf,
  readHostAttestationConstants,
} from './extraction.js';
import { buildPendingReview, type ReviewSignalBinding } from './pending-review.js';
import { validateReviewFindingsConsistency } from './findings-consistency.js';
import { isPendingCaptureUsable, extractCaptureSchemaErrors } from './prepare-findings.js';
export { enforceBeforeSubagentCall } from './prompt-integrity.js';

import { REVIEWER_SUBAGENT_TYPE, TOOL_FLOWGUARD_REVIEW } from '../../tool-names.js';
import {
  obligationTypeForTool,
  resolveReviewObligationTool,
  reviewSignalOwner,
  type ReviewableTool,
} from '../obligation-tools.js';
import { parseToolResult } from '../../plugin-helpers.js';

// ─── State factory ───────────────────────────────────────────────────────────

/** Create a fresh enforcement state for a session. */
export function createSessionState(): SessionEnforcementState {
  return { pendingReviews: new Map(), executedTaskPrompts: new Map() };
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
function trackReviewRequired(
  state: SessionEnforcementState,
  reviewTool: PendingReviewTool,
  next: string,
  now: string,
  /** Identifiers the emitting tool published so the host can bind the reviewer. */
  binding: ReviewSignalBinding,
): void {
  const prior = state.pendingReviews.get(reviewTool);
  state.pendingReviews.set(reviewTool, buildPendingReview(reviewTool, next, now, binding, prior));
}

function trackContentAnalysis(state: SessionEnforcementState, now: string): void {
  state.pendingReviews.set(TOOL_FLOWGUARD_REVIEW, {
    tool: TOOL_FLOWGUARD_REVIEW,
    requestedAt: now,
    attemptId: null,
    obligationId: null,
    subagentCalled: false,
    subagentRecord: null,
    contentMeta: { expectedIteration: 1, expectedPlanVersion: 1 },
    canonicalPromptAnchor: null,
    canonicalPrompt: null,
    capturedFindings: null,
    retryCount: 0,
    hostAttestationConstants: null,
    enforcementFailure: null,
    lastSchemaErrors: null,
    repairPromptRequired: false,
    expectedRepairPromptDigest: null,
    expectedPromptDigest: null,
  });
}

function handleContentAnalysisFlag(
  state: SessionEnforcementState,
  parsed: NonNullable<ReturnType<typeof parseToolResult>>,
  toolName: string,
  now: string,
): void {
  const attestation = parsed.requiredReviewAttestation as Record<string, unknown> | undefined;
  if (
    parsed.error === true &&
    parsed.code === 'CONTENT_ANALYSIS_REQUIRED' &&
    attestation &&
    toolName === TOOL_FLOWGUARD_REVIEW
  ) {
    trackContentAnalysis(state, now);
  }
}

export function onFlowGuardToolAfter(
  state: SessionEnforcementState,
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  now: string,
): void {
  const reviewContext = resolveReviewTrackingContext(toolName);
  if (!reviewContext) return;

  const parsed = parseToolResult(output);
  if (!parsed) return;

  clearSubmittedReview(state, reviewContext.obligationTool, args, parsed);
  trackRequiredReview(state, reviewContext, parsed, now);
  handleContentAnalysisFlag(state, parsed, toolName, now);
}

function resolveReviewTrackingContext(toolName: string): {
  obligationTool: ReviewableTool | undefined;
  signalOwner: ReviewableTool | undefined;
  isReviewContent: boolean;
} | null {
  // The obligation-owning tool for a verdict submission. For
  // flowguard_review_implementation this resolves to flowguard_implement (the
  // tool that created the pending review); for plan/architecture/review it is
  // the tool itself.
  const obligationTool = resolveReviewObligationTool(toolName);
  const signalOwner = reviewSignalOwner(toolName);
  const isReviewContent = toolName === TOOL_FLOWGUARD_REVIEW;
  if (obligationTool === undefined && signalOwner === undefined && !isReviewContent) return null;
  return { obligationTool, signalOwner, isReviewContent };
}

function clearSubmittedReview(
  state: SessionEnforcementState,
  obligationTool: ReviewableTool | undefined,
  args: Record<string, unknown>,
  parsed: NonNullable<ReturnType<typeof parseToolResult>>,
): void {
  // Verdict submission clears the pending review on the obligation-owning key.
  const hasSelfReviewVerdict =
    typeof args.reviewVerdict === 'string' && args.reviewVerdict.length > 0;
  if (hasSelfReviewVerdict && parsed.error !== true) {
    const verdictKey: PendingReviewTool = obligationTool ?? TOOL_FLOWGUARD_REVIEW;
    state.pendingReviews.delete(verdictKey);
  }
}

function trackRequiredReview(
  state: SessionEnforcementState,
  context: NonNullable<ReturnType<typeof resolveReviewTrackingContext>>,
  parsed: NonNullable<ReturnType<typeof parseToolResult>>,
  now: string,
): void {
  // REVIEW_REQUIRED is emitted by the record/content tool itself, which owns its
  // pending-review key. A verdict-only tool never emits REVIEW_REQUIRED.
  const recordKey: PendingReviewTool = context.isReviewContent
    ? TOOL_FLOWGUARD_REVIEW
    : (context.signalOwner as PendingReviewTool);
  const next = typeof parsed.next === 'string' ? parsed.next : '';
  if (next.startsWith(REVIEW_REQUIRED_PREFIX) && (context.isReviewContent || context.signalOwner)) {
    const attemptId = typeof parsed.reviewAttemptId === 'string' ? parsed.reviewAttemptId : null;
    const obligationId =
      typeof parsed.reviewObligationId === 'string' ? parsed.reviewObligationId : null;
    trackReviewRequired(state, recordKey, next, now, {
      attemptId,
      obligationId,
      canonicalPromptAnchor: canonicalPromptAnchorOf(parsed),
      canonicalPrompt: canonicalPromptOf(parsed),
      canonicalPromptDigest: canonicalPromptDigestOf(parsed),
      hostAttestationConstants: readHostAttestationConstants(signalAttestationOf(parsed)),
    });
  }
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

  // Canonical three-tier session ID resolution (BUG-14), shared with the
  // output-injection path so injected/logged/persisted ids agree.
  const sessionId = resolveSubagentSessionId(context?.metadata, taskResult, context?.callID);

  // Capture actual findings from the subagent response
  const capturedFindings = extractCapturedFindings(taskResult);

  const terminationReason = detectStepExhaustion(taskResult)
    ? ('step_exhausted' as const)
    : undefined;

  const record: SubagentRecord = {
    sessionId,
    completedAt: now,
    ...(terminationReason ? { terminationReason } : {}),
  };

  // Match exactly ONE pending review obligation (P34 1:1 contract).
  const matched = matchPendingReview(state, args);
  if (matched) {
    applyCaptureToPending(matched, record, capturedFindings);
  }
}

/**
 * Apply the completed reviewer invocation to the matched pending review.
 *
 * Structural host-context defect first: a bindable obligation without the
 * host-issued attestation constants is NEVER a reviewer-output failure — a
 * reviewer invocation cannot repair it. No capture is kept, no schema errors
 * are computed (no raw-schema fallback), and the pending is excluded from
 * re-arm/repair from here on.
 */
function applyCaptureToPending(
  matched: PendingReview,
  record: SubagentRecord,
  capturedFindings: CapturedFindings | null,
): void {
  if (matched.obligationId != null && (matched.hostAttestationConstants ?? null) == null) {
    matched.subagentCalled = true;
    matched.subagentRecord = record;
    matched.enforcementFailure = 'host_attestation_constants_missing';
    matched.capturedFindings = null;
    matched.lastSchemaErrors = null;
    matched.repairPromptRequired = false;
    matched.expectedRepairPromptDigest = null;
    matched.expectedPromptDigest = null;
    return;
  }
  // Track retries: a re-invoke after a prior (unusable) capture is a retry.
  if (matched.subagentCalled) {
    matched.retryCount = (matched.retryCount ?? 0) + 1;
  }
  matched.subagentCalled = true;
  matched.subagentRecord = record;
  matched.capturedFindings = capturedFindings;
  matched.lastSchemaErrors = extractCaptureSchemaErrors(matched);
  // Enforce repair-prompt requirement: after schema-invalid output, a
  // fresh canonical repair prompt must be issued before the next reviewer.
  matched.repairPromptRequired = matched.lastSchemaErrors !== null;
  // Clear the expected digest — this repair cycle is consumed.
  matched.expectedRepairPromptDigest = null;
  matched.expectedPromptDigest = null;
}

/**
 * Whether a pending review already holds a usable capture — reviewer findings
 * that pass the shared host-normalization authority plus the canonical schema
 * gate (see prepare-findings.ts) and satisfy the canonical verdict coherence
 * rule applied by the verdict-time resolver.
 *
 * A capture that is absent (null), schema-invalid (e.g. the reviewer emitted
 * non-JSON, or mistyped a required field such as `majorRisks`) is NOT good: it
 * can never be bound into a parseable invocation, so the verdict submission
 * fails with HOST_TASK_FINDINGS_UNPARSEABLE. Treating such a capture as
 * "satisfied" is exactly what deadlocks the obligation — the pending review is
 * locked (subagentCalled=true) while its only capture is unusable, and a re-run's
 * evidence is rejected as duplicate_evidence against the corrupt capture.
 *
 * or internally incoherent (accept with blocking issues) is NOT usable. Returning
 * false keeps the review re-armable so a subsequent reviewer run can replace the
 * bad capture (new child session + new findings hash → no duplicate).
 *
 * This is a PURE query over the shared authority — it never mutates the pending
 * review. A structural host-context defect (enforcementFailure) is reported as
 * unusable here but is handled as an explicit, non-repairable blocker in
 * prompt-integrity.ts, never as a reviewer-output retry.
 */
function hasUsableCapture(pending: PendingReview): boolean {
  return isPendingCaptureUsable(pending);
}

/**
 * Match a Task call to exactly one pending review obligation.
 *
 * Matching strategy (P34 1:1 contract):
 * - 0 awaiting capture: null (no obligation to satisfy)
 * - 1 awaiting capture: that one (unambiguous — L3 already validated the prompt)
 * - >1 awaiting capture: match by contentMeta (iteration + planVersion from prompt)
 * - >1 awaiting capture, no contentMeta match: null (fail-closed, ambiguous)
 *
 * "Awaiting capture" includes a review that was already called but whose only
 * capture is unusable (see hasUsableCapture) — so a reviewer re-run replaces a
 * corrupt or incoherent capture instead of deadlocking the obligation.
 */
export function matchPendingReview(
  state: SessionEnforcementState,
  taskArgs: Record<string, unknown>,
): PendingReview | null {
  const awaitingCapture = [...state.pendingReviews.values()].filter(
    // A structural host-context defect (enforcementFailure) is NOT "awaiting
    // capture": it can never be repaired by another reviewer run, so such
    // pendings are excluded from matching, re-arm, and retry counting.
    (p) => (p.enforcementFailure ?? null) === null && (!p.subagentCalled || !hasUsableCapture(p)),
  );

  if (awaitingCapture.length === 0) return null;
  if (awaitingCapture.length === 1) {
    const candidate = awaitingCapture[0]!;
    if (candidate.subagentCalled && (candidate.retryCount ?? 0) >= 1) return null;
    return candidate;
  }

  // Multiple awaiting capture — match by contentMeta from prompt
  const prompt = typeof taskArgs.prompt === 'string' ? taskArgs.prompt : '';

  for (const pending of awaitingCapture) {
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
 *
 * Level 2/4 apply only to agent-attested findings (SDK / manual_attested). In
 * host_task_required mode findings are host-captured and agent-submitted findings
 * are ignored, so those checks are skipped (see enforceBeforeVerdict).
 */
function checkPendingReview(
  state: SessionEnforcementState,
  reviewTool: ReviewableTool,
  sessionState: { reviewAssurance?: SessionState['reviewAssurance'] | null } | null | undefined,
  strictEnforcement: boolean,
): EnforcementResult | null {
  const pending = state.pendingReviews.get(reviewTool);
  if (pending) return null;

  if (sessionState) {
    const obligations = sessionState.reviewAssurance?.obligations;
    if (!obligations || obligations.length === 0) return { allowed: true };
    const pendingObligation = obligations.find(
      (o) => o.status === 'pending' && o.obligationType === obligationTypeForTool(reviewTool),
    );
    if (pendingObligation) {
      return {
        allowed: false,
        code: 'SUBAGENT_REVIEW_NOT_INVOKED',
        reason: `FlowGuard enforcement: recovered from session state — obligation ${pendingObligation.obligationId} is pending but no subagent call was recorded in the transient enforcement state. A ${REVIEWER_SUBAGENT_TYPE} subagent call via the Task tool is required to fulfill this P35 obligation.`,
      };
    }
    return { allowed: true };
  }
  if (strictEnforcement) {
    return {
      allowed: false,
      code: 'REVIEW_ASSURANCE_STATE_UNAVAILABLE',
      reason:
        'Cannot verify review obligation fulfillment in strict mode — enforcement state is unavailable and session state cannot be read. Re-hydrate the session or run /continue before submitting a verdict.',
    };
  }
  return { allowed: true };
}

function checkSessionMismatch(
  pending: { subagentRecord?: { sessionId: string | null } | null },
  reviewFindings: Record<string, unknown>,
): EnforcementResult | null {
  const reviewedBy = reviewFindings.reviewedBy as Record<string, unknown> | undefined;
  const submittedSessionId =
    typeof reviewedBy?.sessionId === 'string' ? reviewedBy.sessionId : null;
  if (
    submittedSessionId &&
    pending.subagentRecord?.sessionId != null &&
    submittedSessionId !== pending.subagentRecord.sessionId
  ) {
    return {
      allowed: false,
      code: 'SUBAGENT_SESSION_MISMATCH',
      reason: `FlowGuard enforcement: reviewFindings.reviewedBy.sessionId ("${submittedSessionId}") does not match the actual subagent session ("${pending.subagentRecord.sessionId}"). The findings must come from the ${REVIEWER_SUBAGENT_TYPE} subagent that was invoked.`,
    };
  }
  return null;
}

function checkFindingsMismatch(
  pending: { capturedFindings?: { overallVerdict: string; blockingIssuesCount: number } | null },
  reviewFindings: Record<string, unknown>,
): EnforcementResult | null {
  const submittedVerdict =
    typeof reviewFindings.overallVerdict === 'string' ? reviewFindings.overallVerdict : null;
  const submittedBlockingIssues = Array.isArray(reviewFindings.blockingIssues)
    ? reviewFindings.blockingIssues
    : null;

  if (submittedVerdict !== null && submittedVerdict !== pending.capturedFindings!.overallVerdict) {
    return {
      allowed: false,
      code: 'SUBAGENT_FINDINGS_VERDICT_MISMATCH',
      reason: `FlowGuard enforcement: submitted reviewFindings.overallVerdict ("${submittedVerdict}") does not match the actual subagent verdict ("${pending.capturedFindings!.overallVerdict}"). The findings must not be modified after the subagent produces them.`,
    };
  }
  if (
    submittedBlockingIssues !== null &&
    submittedBlockingIssues.length !== pending.capturedFindings!.blockingIssuesCount
  ) {
    return {
      allowed: false,
      code: 'SUBAGENT_FINDINGS_ISSUES_MISMATCH',
      reason: `FlowGuard enforcement: submitted reviewFindings.blockingIssues count (${submittedBlockingIssues.length}) does not match the actual subagent count (${pending.capturedFindings!.blockingIssuesCount}). The findings must not be modified after the subagent produces them.`,
    };
  }
  return null;
}

/**
 * F12: assert the internal coherence of the captured review record.
 *
 * Semantically distinct from checkFindingsMismatch (which is anti-tampering
 * between submitted and captured findings). This validates the captured record
 * itself: an `accept` verdict must not carry blocking issues. Kept as its own
 * check so a later refactor of the mismatch logic cannot silently drop the
 * coherence invariant. Delegates to the canonical SSOT rule.
 */
function checkCapturedFindingsConsistency(captured: {
  overallVerdict: string;
  blockingIssuesCount: number;
}): EnforcementResult | null {
  const consistency = validateReviewFindingsConsistency({
    overallVerdict: captured.overallVerdict,
    blockingIssueCount: captured.blockingIssuesCount,
  });
  if (consistency.ok) return null;
  return {
    allowed: false,
    code: consistency.code,
    reason: `FlowGuard enforcement: overallVerdict "accept" is incoherent with ${consistency.details.blockingIssueCount} blocking issue(s). An accepted review must contain no blocking issues; return a non-accept verdict or reclassify the findings.`,
  };
}

function verifyFindingsIntegrity(
  pending: {
    subagentRecord?: { sessionId: string | null } | null;
    capturedFindings?: { overallVerdict: string; blockingIssuesCount: number } | null;
  },
  reviewFindings: Record<string, unknown> | undefined,
): EnforcementResult | null {
  if (!reviewFindings || !pending.subagentRecord) return null;
  const sessionIssue = checkSessionMismatch(pending, reviewFindings);
  if (sessionIssue) return sessionIssue;
  if (!pending.capturedFindings) return null;
  // Coherence of the captured record first, then anti-tampering vs submitted.
  const consistencyIssue = checkCapturedFindingsConsistency(pending.capturedFindings);
  if (consistencyIssue) return consistencyIssue;
  return checkFindingsMismatch(pending, reviewFindings);
}

export function enforceBeforeVerdict(
  state: SessionEnforcementState,
  toolName: string,
  args: Record<string, unknown>,
  sessionState?: {
    reviewAssurance?: SessionState['reviewAssurance'] | null;
    policySnapshot?: { reviewInvocationPolicy?: string } | null;
  } | null,
  strictEnforcement = false,
): EnforcementResult {
  // Resolve the obligation-owning tool. For flowguard_review_implementation the
  // verdict applies to the flowguard_implement obligation (issue #565); for
  // plan/architecture the verdict tool owns its own obligation (identity).
  const reviewTool = resolveReviewObligationTool(toolName);
  if (reviewTool === undefined) return { allowed: true };

  const reviewVerdictValue = args.reviewVerdict;
  const hasSelfReviewVerdict =
    typeof reviewVerdictValue === 'string' && reviewVerdictValue.length > 0;
  if (!hasSelfReviewVerdict) return { allowed: true };

  const pendingCheck = checkPendingReview(state, reviewTool, sessionState, strictEnforcement);
  if (pendingCheck) return pendingCheck;

  const pending = state.pendingReviews.get(reviewTool);
  if (!pending) return { allowed: true };

  if (!pending.subagentCalled) {
    return {
      allowed: false,
      code: 'SUBAGENT_REVIEW_NOT_INVOKED',
      reason: `FlowGuard enforcement: ${reviewTool} signaled INDEPENDENT_REVIEW_REQUIRED but no Task call to ${REVIEWER_SUBAGENT_TYPE} was detected. You MUST call the ${REVIEWER_SUBAGENT_TYPE} subagent via the Task tool before submitting a self-review verdict.`,
    };
  }

  // ── Level 2/4: AGENT-submitted findings integrity ──────────────────────
  // In host_task_required mode the findings are host-captured and bound, and the
  // tool layer (resolveHostTaskEffectiveFindings) ignores any agent-submitted
  // reviewFindings — verdict-only is expected. The agent cannot know the real
  // child session id, so enforcing reviewedBy.sessionId against it here is both
  // impossible to satisfy and meaningless: host capture is the integrity source,
  // and the verdict is still verified against captured evidence downstream. Skip
  // the agent-findings integrity checks so a (disobedient but harmless) findings
  // payload does not hard-block the verdict with SUBAGENT_SESSION_MISMATCH.
  const hostTaskMode =
    sessionState?.policySnapshot?.reviewInvocationPolicy === 'host_task_required';
  if (hostTaskMode) return { allowed: true };

  const findingsCheck = verifyFindingsIntegrity(
    pending,
    args.reviewFindings as Record<string, unknown> | undefined,
  );
  if (findingsCheck) return findingsCheck;

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
  const reviewTool = resolveReviewObligationTool(toolName);
  if (reviewTool === undefined) return false;
  const pending = state.pendingReviews.get(reviewTool);
  if (!pending || pending.subagentCalled) return false;

  pending.subagentCalled = true;
  pending.subagentRecord = {
    sessionId,
    completedAt: now,
  };
  // Same structural host-context rule as onTaskToolAfter: a bindable
  // obligation without host attestation constants is never repaired by a
  // reviewer capture — fail closed with the explicit marker.
  if (pending.obligationId != null && (pending.hostAttestationConstants ?? null) == null) {
    pending.enforcementFailure = 'host_attestation_constants_missing';
    pending.capturedFindings = null;
    pending.lastSchemaErrors = null;
    pending.repairPromptRequired = false;
    pending.expectedRepairPromptDigest = null;
    return true;
  }
  pending.capturedFindings = capturedFindings;
  return true;
}

/**
 * Pre-execution check: a flowguard-reviewer Task may only run when a pending
 * review obligation exists. This prevents wasted LLM time for reviewer Tasks
 * that would be blocked post-execution by handleHostTaskEvidence.
 *
 * If the session state is unavailable, only strict enforcement blocks —
 * non-strict modes allow the task to proceed rather than risking a
 * false-positive denial from a transient state read failure.
 *
 * @public unit-testable, no side effects
 */
export function enforceReviewerObligation(params: {
  obligations: ReadonlyArray<Pick<ReviewObligation, 'status'> & { obligationId?: string }>;
  invocations?: ReadonlyArray<{
    obligationId: string;
    capturedVerdict?: string;
    capturedRawFindings?: Record<string, unknown>;
  }>;
  reviewInvocationPolicy: string | undefined;
  maxIncoherentReviewerCaptureRetries?: number;
  strictEnforcement: boolean;
  stateAvailable: boolean;
}): EnforcementResult {
  if (!params.stateAvailable) {
    if (params.strictEnforcement) {
      return {
        allowed: false,
        code: 'STATE_UNAVAILABLE_FOR_REVIEWER_TASK',
        reason:
          'Session state could not be read. The flowguard-reviewer Task cannot run without verifiable state.',
      };
    }
    return { allowed: true };
  }

  const hasPending = params.obligations.some((o) => o.status === 'pending');
  if (params.reviewInvocationPolicy === 'host_task_required' && !hasPending) {
    return {
      allowed: false,
      code: 'REVIEWER_TASK_REQUIRES_PENDING_OBLIGATION',
      reason:
        'A flowguard-reviewer Task may only run when a pending review obligation exists. ' +
        'Run the relevant FlowGuard review tool (flowguard_plan, flowguard_implement, ' +
        'flowguard_architecture, or flowguard_review) first to create a pending review ' +
        'obligation, then start the reviewer Task.',
    };
  }

  const pendingObligationIds = new Set(
    params.obligations
      .filter((obligation) => obligation.status === 'pending' && obligation.obligationId)
      .map((obligation) => obligation.obligationId!),
  );
  const incoherentCaptureCount = (params.invocations ?? []).filter(
    (invocation) =>
      (pendingObligationIds.size === 0 || pendingObligationIds.has(invocation.obligationId)) &&
      invocation.capturedVerdict === 'accept' &&
      Array.isArray(invocation.capturedRawFindings?.blockingIssues) &&
      invocation.capturedRawFindings.blockingIssues.length > 0,
  ).length;
  const maxRetries = params.maxIncoherentReviewerCaptureRetries ?? 1;
  if (incoherentCaptureCount > maxRetries) {
    return {
      allowed: false,
      code: 'SUBAGENT_VERDICT_FINDINGS_INCOHERENT',
      reason:
        `Reviewer capture retry budget exhausted after ${incoherentCaptureCount} incoherent capture(s). ` +
        'Revise or re-submit the governed artifact to create a new review obligation; do not continue retrying this obligation.',
    };
  }

  return { allowed: true };
}
