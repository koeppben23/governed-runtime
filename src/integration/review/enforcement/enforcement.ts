/**
 * @module integration/review-enforcement
 * @description Runtime enforcement for independently reviewed verdicts.
 *
 * Contains the state factory and hook handlers (pure functions) that require
 * a host-observed structured reviewer invocation before any FlowGuard verdict
 * submission is authorized.
 *
 * Four enforcement levels:
 * - L1 (Binary Gate): a verdict submission is blocked until a host-observed
 *   SDK reviewer invocation was recorded for the pending review.
 * - L2 (Session Identity): submitted `reviewedBy.sessionId` must match the
 *   child session recorded by the reviewer invocation.
 * - L3 (Capture Coherence): a captured reviewer record must be internally
 *   coherent (an `accept` verdict may not carry blocking issues).
 * - L4 (Findings Integrity): a submitted verdict and blocking-issue count must
 *   match the captured reviewer record exactly.
 *
 * Extracted modules (FG-REL-038):
 * - review-enforcement-types.ts — Types, interfaces, constants
 * - review-enforcement-extraction.ts — Review-signal helpers
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
  type CapturedFindings,
  type EnforcementResult,
  type PendingReviewTool,
  REVIEW_REQUIRED_PREFIX,
} from './types.js';
import { signalAttestationOf, readHostAttestationConstants } from './extraction.js';
import { buildPendingReview, type ReviewSignalBinding } from './pending-review.js';
import { validateReviewFindingsConsistency } from './findings-consistency.js';

import { TOOL_FLOWGUARD_REVIEW } from '../../tool-names.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
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

/** Process a FlowGuard tool response (tool.execute.after). */
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
  const hasSelfReviewVerdict =
    typeof args.reviewVerdict === 'string' && args.reviewVerdict.length > 0;
  if (hasSelfReviewVerdict && parsed.error !== true) {
    const verdictKey: PendingReviewTool = obligationTool ?? TOOL_FLOWGUARD_REVIEW;
    state.pendingReviews.delete(verdictKey);
  }
}

// eslint-disable-next-line complexity -- accepts established response projections at one boundary.
function reviewObligationIdFromSignal(
  parsed: NonNullable<ReturnType<typeof parseToolResult>>,
  isReviewContent: boolean,
): string | null {
  if (isReviewContent) {
    const attestation = parsed.requiredReviewAttestation;
    if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) return null;
    const obligationId = (attestation as Record<string, unknown>).toolObligationId;
    return typeof obligationId === 'string' ? obligationId : null;
  }
  const value = parsed.reviewObligation;
  const reviewInvocation = parsed.reviewInvocation;
  const source =
    reviewInvocation && typeof reviewInvocation === 'object' && !Array.isArray(reviewInvocation)
      ? reviewInvocation
      : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const obligationId = (source as Record<string, unknown>).obligationId;
  return typeof obligationId === 'string' ? obligationId : null;
}

function trackRequiredReview(
  state: SessionEnforcementState,
  context: NonNullable<ReturnType<typeof resolveReviewTrackingContext>>,
  parsed: NonNullable<ReturnType<typeof parseToolResult>>,
  now: string,
): void {
  const recordKey: PendingReviewTool = context.isReviewContent
    ? TOOL_FLOWGUARD_REVIEW
    : (context.signalOwner as PendingReviewTool);
  const next = typeof parsed.next === 'string' ? parsed.next : '';
  if (next.startsWith(REVIEW_REQUIRED_PREFIX) && (context.isReviewContent || context.signalOwner)) {
    const attemptId = typeof parsed.reviewAttemptId === 'string' ? parsed.reviewAttemptId : null;
    trackReviewRequired(state, recordKey, next, now, {
      attemptId,
      obligationId: reviewObligationIdFromSignal(parsed, context.isReviewContent),
      canonicalPromptAnchor: null,
      canonicalPrompt: null,
      canonicalPromptDigest: null,
      hostAttestationConstants: readHostAttestationConstants(signalAttestationOf(parsed)),
    });
  }
}

function checkPendingReview(
  state: SessionEnforcementState,
  reviewTool: ReviewableTool,
  sessionState: { reviewAssurance?: SessionState['reviewAssurance'] | null } | null | undefined,
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
        reason: `FlowGuard enforcement: recovered from session state — obligation ${pendingObligation.obligationId} is pending but no SDK reviewer invocation was recorded in the transient enforcement state.`,
      };
    }
    return { allowed: true };
  }
  return {
    allowed: false,
    code: 'REVIEW_ASSURANCE_STATE_UNAVAILABLE',
    reason:
      'Cannot verify review obligation fulfillment — enforcement state is unavailable and session state cannot be read. Re-hydrate the session or run /continue before submitting a verdict.',
  };
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

/** F12: assert the internal coherence of the captured review record. */
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
    policySnapshot?: object | null;
  } | null,
): EnforcementResult {
  const reviewTool = resolveReviewObligationTool(toolName);
  if (reviewTool === undefined) return { allowed: true };

  const reviewVerdictValue = args.reviewVerdict;
  const hasSelfReviewVerdict =
    typeof reviewVerdictValue === 'string' && reviewVerdictValue.length > 0;
  if (!hasSelfReviewVerdict) return { allowed: true };

  const pendingCheck = checkPendingReview(state, reviewTool, sessionState);
  if (pendingCheck) return pendingCheck;

  const pending = state.pendingReviews.get(reviewTool);
  if (!pending) return { allowed: true };

  if (!pending.subagentCalled) {
    return {
      allowed: false,
      code: 'SUBAGENT_REVIEW_NOT_INVOKED',
      reason: `FlowGuard enforcement: ${reviewTool} signaled INDEPENDENT_REVIEW_REQUIRED but no SDK reviewer invocation was recorded before the self-review verdict.`,
    };
  }

  if (
    sessionState?.reviewAssurance?.invocations.some(
      (invocation) => invocation.invocationMode === 'sdk_session_prompt',
    )
  )
    return { allowed: true };

  const findingsCheck = verifyFindingsIntegrity(
    pending,
    args.reviewFindings as Record<string, unknown> | undefined,
  );
  if (findingsCheck) return findingsCheck;

  return { allowed: true };
}

// ─── Plugin-Initiated Review Recording ───────────────────────────────────────

/** Record a plugin-initiated review invocation on a pending review. */
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
