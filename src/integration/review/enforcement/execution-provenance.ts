import { createHash } from 'node:crypto';
import type { ReviewAssuranceState } from '../../../state/evidence.js';
import { findBindableAttempt } from '../attempt-lifecycle.js';
import { isPendingCaptureUsable } from './prepare-findings.js';
import type { ExecutedTaskPrompt, PendingReview, SessionEnforcementState } from './types.js';

export type DispatchResolution =
  | { readonly kind: 'ready'; readonly prompt: ExecutedTaskPrompt }
  | {
      readonly kind: 'in_flight';
      readonly obligationId: string;
      readonly attemptId: string;
    }
  | { readonly kind: 'blocked'; readonly reason: string };

/**
 * Select one executable review solely from host state and create its ephemeral
 * before/after transport record. Model-provided Task arguments are diagnostic only.
 */
export function registerExecutedTaskPrompt(
  enforcement: SessionEnforcementState,
  assurance: ReviewAssuranceState | undefined,
  callId: string,
  modelPrompt: unknown,
  now: string,
): DispatchResolution {
  if (!callId) {
    return { kind: 'blocked', reason: 'reviewer Task requires a non-empty host call ID' };
  }
  if (enforcement.executedTaskPrompts.has(callId)) {
    return { kind: 'blocked', reason: 'host call ID already has an execution record' };
  }
  const candidates = [...enforcement.pendingReviews.values()].filter(isExecutablePending);
  if (candidates.length !== 1) {
    return {
      kind: 'blocked',
      reason: `expected exactly one executable pending review, found ${candidates.length}`,
    };
  }
  const pending = candidates[0]!;
  const obligation = assurance?.obligations.find(
    (item) => item.obligationId === pending.obligationId,
  );
  if (!obligation || obligation.status !== 'pending') {
    return { kind: 'blocked', reason: 'pending obligation is absent or no longer pending' };
  }
  const attempt = findBindableAttempt(assurance, obligation.obligationId);
  if (!attempt || attempt.attemptId !== pending.attemptId) {
    return {
      kind: 'blocked',
      reason: 'pending attempt is absent, superseded, or not bindable',
    };
  }
  if (hasInFlightAttempt(enforcement, obligation.obligationId, attempt.attemptId)) {
    return {
      kind: 'in_flight',
      obligationId: obligation.obligationId,
      attemptId: attempt.attemptId,
    };
  }
  const canonicalPrompt = pending.canonicalPrompt!;
  const canonicalPromptDigest = digest(canonicalPrompt);
  if (canonicalPromptDigest !== pending.expectedPromptDigest) {
    return {
      kind: 'blocked',
      reason: 'stored canonical prompt bytes do not match their expected digest',
    };
  }
  const prompt: ExecutedTaskPrompt = {
    callId,
    obligationId: obligation.obligationId,
    attemptId: attempt.attemptId,
    canonicalPrompt,
    canonicalPromptDigest,
    modelPromptDigest: typeof modelPrompt === 'string' ? digest(modelPrompt) : null,
    createdAt: now,
  };
  enforcement.executedTaskPrompts.set(callId, prompt);
  return { kind: 'ready', prompt };
}

function hasInFlightAttempt(
  enforcement: SessionEnforcementState,
  obligationId: string,
  attemptId: string,
): boolean {
  return [...enforcement.executedTaskPrompts.values()].some(
    (record) => record.obligationId === obligationId && record.attemptId === attemptId,
  );
}

/** Atomically consume the host-owned Task execution record. */
export function takeExecutedTaskPrompt(
  enforcement: SessionEnforcementState,
  callId: string | undefined,
): ExecutedTaskPrompt | null {
  if (!callId) return null;
  const records = enforcement.executedTaskPrompts;
  const prompt = records.get(callId) ?? null;
  if (prompt) records.delete(callId);
  return prompt;
}

function isExecutablePending(pending: PendingReview): boolean {
  return (
    pending.enforcementFailure == null &&
    pending.obligationId !== null &&
    pending.attemptId !== null &&
    pending.canonicalPrompt !== null &&
    pending.expectedPromptDigest !== null &&
    (!pending.subagentCalled || !isPendingCaptureUsable(pending)) &&
    (!pending.subagentCalled || pending.retryCount < 1)
  );
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
