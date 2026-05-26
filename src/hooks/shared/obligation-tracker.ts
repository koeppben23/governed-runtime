/**
 * @module hooks/shared/obligation-tracker
 * @description Review obligation escalation tracking for PostToolUse hooks.
 *
 * When a review obligation is pending, FlowGuard escalates warnings if the LLM
 * continues making mutating tool calls without invoking the reviewer.
 * This is a Gap 4 mitigation: since out-of-process hooks cannot spawn subagents,
 * we surface escalating audit warnings to create post-hoc detection evidence.
 *
 * Escalation levels:
 * - none: no pending obligations, or non-mutating tool
 * - info: pending obligation exists, mutating tool used (first few calls)
 * - warn: obligation pending for extended duration (>60s of elapsed time)
 * - critical: obligation pending for >180s — session may be stalled
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/251 (Gap 4)
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import type { ReviewObligation } from '../../state/evidence.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type EscalationLevel = 'none' | 'info' | 'warn' | 'critical';

export interface ObligationEscalation {
  readonly level: EscalationLevel;
  readonly pendingCount: number;
  readonly oldestPendingAge: number; // seconds since oldest pending obligation created
  readonly message: string | null;
}

export function unresolvedBlockingObligations(state: SessionState): ReviewObligation[] {
  return (state.reviewAssurance?.obligations ?? []).filter(
    (ob) => ob.status !== 'consumed' && ob.consumedAt == null,
  );
}

// ─── Thresholds ──────────────────────────────────────────────────────────────

/** Seconds after obligation creation before INFO→WARN escalation. */
const WARN_THRESHOLD_SECONDS = 60;

/** Seconds after obligation creation before WARN→CRITICAL escalation. */
const CRITICAL_THRESHOLD_SECONDS = 180;

// ─── Escalation Logic ────────────────────────────────────────────────────────

/**
 * Evaluate review obligation escalation for a PostToolUse event.
 *
 * @param state - Current session state (from session-resolver).
 * @param isMutatingTool - Whether the completed tool call was mutating.
 * @param now - Current ISO timestamp (injectable for testing).
 * @returns Escalation assessment with level and advisory message.
 */
export function assessObligationEscalation(
  state: SessionState,
  isMutatingTool: boolean,
  now: string = new Date().toISOString(),
): ObligationEscalation {
  const pending = unresolvedBlockingObligations(state);

  if (pending.length === 0) {
    return { level: 'none', pendingCount: 0, oldestPendingAge: 0, message: null };
  }

  // Non-mutating tool calls don't escalate (only mutating calls matter).
  if (!isMutatingTool) {
    return { level: 'none', pendingCount: pending.length, oldestPendingAge: 0, message: null };
  }

  // Compute age of oldest pending obligation.
  const nowMs = new Date(now).getTime();
  const ages = pending.map((ob) => (nowMs - new Date(ob.createdAt).getTime()) / 1000);
  const oldestAge = Math.max(...ages);

  if (oldestAge >= CRITICAL_THRESHOLD_SECONDS) {
    return {
      level: 'critical',
      pendingCount: pending.length,
      oldestPendingAge: Math.round(oldestAge),
      message:
        `CRITICAL: ${pending.length} review obligation(s) pending for ${Math.round(oldestAge)}s. ` +
        `Session may be stalled — LLM has not invoked the reviewer. ` +
        `Use flowguard_decision for manual approval or invoke the reviewer subagent.`,
    };
  }

  if (oldestAge >= WARN_THRESHOLD_SECONDS) {
    return {
      level: 'warn',
      pendingCount: pending.length,
      oldestPendingAge: Math.round(oldestAge),
      message:
        `WARN: ${pending.length} review obligation(s) pending for ${Math.round(oldestAge)}s. ` +
        `Invoke the reviewer subagent to fulfill the obligation before continuing.`,
    };
  }

  return {
    level: 'info',
    pendingCount: pending.length,
    oldestPendingAge: Math.round(oldestAge),
    message:
      `INFO: ${pending.length} review obligation(s) pending. ` +
      `Reviewer invocation expected before further mutating operations.`,
  };
}
