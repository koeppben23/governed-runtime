/**
 * @module integration/review/enforcement/durable-dispatch
 * @description Durable reviewer Task dispatch ledger operations.
 *
 * P1 requires every reviewer Task dispatch to be recorded durably BEFORE the
 * host releases it, and every observed After to close the matching ledger
 * entry — so a crash/restart between Before and After can never be mistaken
 * for "never dispatched". This module owns the host-facing persistence for
 * that ledger:
 *
 *   - `persistAuthorizedDispatch` — write an `authorized` entry before the
 *     host may execute a reviewer Task.
 *   - `rearmInterruptedReviewerDispatch` — Before-without-After recovery that
 *     supersedes the interrupted attempt (stale + outcome_unknown) and mints a
 *     fresh append-only attempt on the SAME obligation.
 *   - `markReviewerDispatchCompleted` — After observed the host Task: close the
 *     `authorized` entry as `completed`.
 *
 * Every write runs through the canonical locked assurance update so the ledger
 * and attempt state cannot diverge under concurrency.
 *
 * @version v1
 */

import { randomUUID } from 'node:crypto';
import { readState } from '../adapters/persistence.js';
import { writeStateWithAuditOperations } from './tools/audit-outbox.js';
import { buildEnforcementError } from './plugin-helpers.js';
import { authorizeTaskLifecycleRearm } from './review/reissue-authority.js';
import { createAttemptForExistingObligation } from './review/assurance.js';
import {
  appendReviewDispatch,
  completeReviewDispatch,
  markDispatchOutcomeUnknown,
} from '../state/review-continuation.js';
import type { DispatchResolution } from './review/enforcement/execution-provenance.js';
import type { ExecutedTaskPrompt, SessionEnforcementState } from './review/enforcement/types.js';
import type { ReviewAttempt, ReviewDispatchRecord } from '../state/evidence-review.js';
import type { SessionState } from '../state/schema.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';

/**
 * Persist the dispatch ledger entry for a reviewer Task BEFORE the host
 * releases it. Uses the SAME locked write authority as the re-arm so the
 * ledger and the attempt state can never diverge under concurrency.
 */
export async function persistAuthorizedDispatch(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  prompt: ExecutedTaskPrompt,
): Promise<void> {
  const sessDir = runtime.ws.getSessionDir(sessionId);
  if (!sessDir) {
    throw buildEnforcementError(
      'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
      'reviewer dispatch persistence requires a resolved session directory',
    );
  }
  const state = await readState(sessDir);
  if (!state) {
    throw buildEnforcementError(
      'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
      'reviewer dispatch persistence requires durable session state',
    );
  }
  const record: ReviewDispatchRecord = {
    dispatchId: randomUUID(),
    attemptId: prompt.attemptId,
    obligationId: prompt.obligationId,
    hostCallId: prompt.callId,
    canonicalPromptDigest: prompt.canonicalPromptDigest,
    dispatchAuthorizedAt: prompt.createdAt,
    dispatchStatus: 'authorized',
  };
  await writeStateWithAuditOperations(sessDir, {
    ...state,
    reviewAssurance: appendReviewDispatch(state.reviewAssurance, record),
  });
}

/**
 * Before-without-After recovery for reviewer Task dispatches. A phantom
 * in-flight execution record means a prior Before registered a dispatch but no
 * After ever consumed it (host crash, transport failure, missing
 * infrastructure). Recovery is DURABLE and append-only:
 *
 *   1. the spent attempt is authorized for a task-lifecycle re-arm
 *      (`authorizeTaskLifecycleRearm` — settled obligations are refused);
 *   2. a NEW attempt is minted on the SAME obligation and persisted
 *      (`createAttemptForExistingObligation` stales the predecessor, so a late
 *      completion of the old attempt can never fulfill the obligation);
 *   3. the spent attempt's dispatch records are durably marked
 *      `outcome_unknown`, the phantom transient record is removed, and the
 *      pending review is re-bound to the new attempt; the host call receives a
 *      NEW call ID.
 *
 * Fails closed on any missing authority: no silent re-dispatch of a spent
 * attempt, no second dispatch without a durable new attempt.
 */
export async function rearmInterruptedReviewerDispatch(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  eState: SessionEnforcementState,
  inFlight: Extract<DispatchResolution, { readonly kind: 'in_flight' }>,
): Promise<
  | { readonly kind: 'ok'; readonly assurance: SessionState['reviewAssurance'] }
  | { readonly kind: 'blocked'; readonly code?: string; readonly reason: string }
> {
  const sessDir = runtime.ws.getSessionDir(sessionId);
  if (!sessDir) {
    return {
      kind: 'blocked',
      reason: 'reviewer dispatch recovery requires a resolved session directory',
    };
  }
  const state = await readState(sessDir);
  const assurance = state?.reviewAssurance;
  if (!assurance) {
    return { kind: 'blocked', reason: 'reviewer dispatch recovery requires durable assurance' };
  }
  const spent = assurance.attempts.find((attempt) => attempt.attemptId === inFlight.attemptId);
  if (!spent) {
    return { kind: 'blocked', reason: 'interrupted reviewer attempt is absent from assurance' };
  }
  const rearmed = buildInterruptedDispatchRearm(assurance, spent, new Date().toISOString());
  if (rearmed.kind === 'blocked') {
    return { kind: 'blocked', reason: rearmed.reason };
  }
  await writeStateWithAuditOperations(sessDir, {
    ...state,
    reviewAssurance: rearmed.assurance,
  });
  for (const [key, record] of eState.executedTaskPrompts) {
    if (record.obligationId === spent.obligationId && record.attemptId === spent.attemptId) {
      eState.executedTaskPrompts.delete(key);
    }
  }
  for (const [tool, pending] of eState.pendingReviews) {
    if (pending.obligationId === spent.obligationId && pending.attemptId === spent.attemptId) {
      eState.pendingReviews.set(tool, { ...pending, attemptId: rearmed.attempt.attemptId });
    }
  }
  return { kind: 'ok', assurance: rearmed.assurance };
}

/**
 * Pure, tool-route-friendly composition of the reviewer dispatch re-arm. Unlike
 * `rearmInterruptedReviewerDispatch`, it takes an in-memory assurance + spent
 * attempt (not a plugin runtime / transient enforcement state) and performs NO
 * write — the caller persists the resulting assurance with its own write
 * authority. This is the shared authority so the plugin Task gate and the
 * `/plan`/`/architecture` re-invocation routes cannot drift.
 *
 * Fails closed: a settled obligation is refused with `rearm_obligation_settled`.
 */
export type InterruptedDispatchRearm =
  | {
      readonly kind: 'ok';
      readonly assurance: SessionState['reviewAssurance'];
      readonly attempt: ReviewAttempt;
    }
  | { readonly kind: 'blocked'; readonly reason: string };

export function buildInterruptedDispatchRearm(
  assurance: SessionState['reviewAssurance'] | undefined,
  spent: ReviewAttempt,
  now: string,
): InterruptedDispatchRearm {
  const authorization = authorizeTaskLifecycleRearm(assurance!, spent);
  if (authorization.kind === 'blocked') {
    return { kind: 'blocked', reason: authorization.reason };
  }
  const minted = createAttemptForExistingObligation(
    assurance,
    authorization.obligation,
    undefined,
    now,
    {
      origin: authorization.origin,
      repositoryDiscovery: spent.repositoryDiscovery,
    },
  );
  return {
    kind: 'ok',
    assurance: markDispatchOutcomeUnknown(minted.assurance, spent.attemptId),
    attempt: minted.attempt,
  };
}

/**
 * Close the durable dispatch ledger entry for a host call whose After was
 * observed. Runs inside the canonical assurance update transaction so the
 * ledger and attempt state cannot diverge under concurrency. A stuck
 * `authorized` entry is fail-closed: it only ever forces a fresh append-only
 * re-arm, never a duplicate bind.
 */
export async function markReviewerDispatchCompleted(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  hostCallId: string,
  completedAt: string,
): Promise<void> {
  const sessDir = runtime.ws.getSessionDir(sessionId);
  if (!sessDir) return;
  await runtime.ws.updateReviewAssurance(sessDir, (state) => ({
    ...state,
    reviewAssurance: completeReviewDispatch(state.reviewAssurance, hostCallId, completedAt),
  }));
}
