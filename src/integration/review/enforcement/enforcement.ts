/**
 * @module integration/review-enforcement
 * @description Runtime enforcement for independently reviewed verdicts.
 *
 * Contains the state factory and hook handlers (pure functions) that require
 * a host-observed structured reviewer invocation before any FlowGuard verdict
 * submission is authorized.
 *
 * Review verdict enforcement applies four integrity checks:
 * - L1 (Binary Gate): a verdict submission is blocked until a host-observed
 *   visible native Task reviewer invocation with structured same-child findings
 *   was recorded for the pending review. This module owns the transient signal
 *   tracking and the L1 gate.
 * - L2 (Session Identity): the evidence participant identity must match the
 *   child session of the host-observed reviewer invocation.
 * - L3 (Capture Coherence): the host-captured reviewer record must be
 *   internally coherent (an `accept` verdict may not carry blocking issues).
 * - L4 (Findings Integrity): the submitted verdict and findings hash must
 *   match the host-captured invocation evidence exactly.
 *
 * L2-L4 are enforced on the host-observed structured evidence path
 * (review-validation-structured-evidence.ts and the shared consistency
 * authorities); this module never captures reviewer output itself.
 *
 * Extracted modules (FG-REL-038):
 * - review-enforcement-types.ts — Types, interfaces, constants
 * - review-enforcement-pending-review.ts — Pending-review construction
 *
 * Architecture:
 * - Pure logic module — no OpenCode/plugin dependencies, fully unit-testable.
 * - Plugin integration happens in plugin.ts (delegates to this module).
 * - Session-scoped state tracked per session ID.
 *
 * @version v6
 */

import type { SessionState } from '../../../state/schema.js';
import {
  type SessionEnforcementState,
  type EnforcementResult,
  type PendingReviewTool,
} from './types.js';
import { isReviewDispatchRequired } from '../dispatch-signal.js';
import { buildPendingReview, type ReviewSignalBinding } from './pending-review.js';

import {
  obligationTypeForTool,
  resolveReviewObligationTool,
  reviewSignalOwner,
  type ReviewableTool,
} from '../obligation-tools.js';
import { parseToolResult } from '../../plugin-helpers.js';
import { TOOL_FLOWGUARD_REVIEW } from '../../tool-names.js';
import { isTerminalPhase } from '../../../machine/topology.js';

// ─── State factory ───────────────────────────────────────────────────────────

/** Create a fresh enforcement state for a session. */
export function createSessionState(): SessionEnforcementState {
  return { pendingReviews: new Map() };
}

// ─── Hook handlers (pure functions) ──────────────────────────────────────────

/**
 * Outcome of tracking one FlowGuard tool response.
 *
 * `nonconforming` means the response projects a review requirement without the
 * full obligation/attempt binding the host must authorize. Callers fail closed
 * on this result and never register a pending review for it.
 */
export type ReviewTrackingResult =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'nonconforming';
      readonly code: 'REVIEW_ATTEMPT_UNAVAILABLE';
      readonly reason: string;
      readonly obligationId: string | null;
    };

function nonconforming(obligationId: string | null, reason: string): ReviewTrackingResult {
  return { kind: 'nonconforming', code: 'REVIEW_ATTEMPT_UNAVAILABLE', reason, obligationId };
}

function trackReviewRequired(
  state: SessionEnforcementState,
  reviewTool: PendingReviewTool,
  now: string,
  /** Identifiers the emitting tool published so the host can bind the reviewer. */
  binding: ReviewSignalBinding,
): void {
  state.pendingReviews.set(reviewTool, buildPendingReview(reviewTool, now, binding));
}

export function onFlowGuardToolAfter(
  state: SessionEnforcementState,
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  now: string,
): ReviewTrackingResult {
  const reviewContext = resolveReviewTrackingContext(toolName);
  if (!reviewContext) return { kind: 'ok' };

  const parsed = parseToolResult(output);
  if (!parsed) return { kind: 'ok' };

  clearSubmittedReview(state, reviewContext.obligationTool, args, parsed);
  return trackRequiredReview(state, reviewContext, parsed, now);
}

function resolveReviewTrackingContext(toolName: string): {
  obligationTool: ReviewableTool | undefined;
  signalOwner: ReviewableTool | undefined;
} | null {
  const obligationTool = resolveReviewObligationTool(toolName);
  const signalOwner = reviewSignalOwner(toolName);
  if (obligationTool === undefined && signalOwner === undefined) return null;
  return { obligationTool, signalOwner };
}

function clearSubmittedReview(
  state: SessionEnforcementState,
  obligationTool: ReviewableTool | undefined,
  args: Record<string, unknown>,
  parsed: NonNullable<ReturnType<typeof parseToolResult>>,
): void {
  const hasSelfReviewVerdict =
    typeof args.reviewVerdict === 'string' && args.reviewVerdict.length > 0;
  const completedPeerReview =
    obligationTool === TOOL_FLOWGUARD_REVIEW &&
    typeof args.reviewObligationId === 'string' &&
    typeof parsed.phase === 'string' &&
    isTerminalPhase(parsed.phase);
  if ((hasSelfReviewVerdict || completedPeerReview) && parsed.error !== true) {
    if (obligationTool) state.pendingReviews.delete(obligationTool);
  }
}

function reviewObligationIdFromSignal(
  parsed: NonNullable<ReturnType<typeof parseToolResult>>,
): string | null {
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
): ReviewTrackingResult {
  const recordKey = context.signalOwner;
  if (!isReviewDispatchRequired(parsed) || !recordKey) {
    return { kind: 'ok' };
  }
  const obligationId = reviewObligationIdFromSignal(parsed);
  const attemptId = typeof parsed.reviewAttemptId === 'string' ? parsed.reviewAttemptId : null;
  if (!obligationId || !attemptId) {
    return nonconforming(
      obligationId,
      'a review dispatch requirement must project both its obligation id and the exact reviewer attempt id',
    );
  }
  trackReviewRequired(state, recordKey, now, { attemptId, obligationId });
  return { kind: 'ok' };
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
        reason: `FlowGuard enforcement: recovered from session state — obligation ${pendingObligation.obligationId} is pending but no visible native reviewer invocation was recorded in the transient enforcement state.`,
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

  // L1 binds to the SPECIFIC pending review, not to the mere existence of any
  // invocation: the recorded invocation must be the visible native Task
  // transport, belong to the exact pending obligation/attempt, and expose a
  // navigable host transcript.
  if (pending.obligationId === null) {
    return {
      allowed: false,
      code: 'SUBAGENT_REVIEW_NOT_INVOKED',
      reason: `FlowGuard enforcement: ${reviewTool} signaled a review requirement without an obligation identity; the reviewer invocation cannot be bound to the pending review.`,
    };
  }
  const bound = sessionState?.reviewAssurance?.invocations.some(
    (invocation) =>
      invocation.invocationMode === 'native_task_structured_followup' &&
      invocation.hostVisible === true &&
      invocation.transcriptNavigable === true &&
      invocation.obligationId === pending.obligationId &&
      invocation.attemptId === pending.attemptId,
  );
  if (bound) return { allowed: true };

  return {
    allowed: false,
    code: 'SUBAGENT_REVIEW_NOT_INVOKED',
    reason: `FlowGuard enforcement: obligation ${pending.obligationId} signaled a review requirement but no visible, navigable, host-observed structured reviewer invocation is bound to it before the verdict.`,
  };
}
