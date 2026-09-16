/**
 * @module integration/review/enforcement/durable-dispatch
 * @description Durable reviewer dispatch ledger operations.
 *
 * Every reviewer invocation must be recorded durably BEFORE the host releases
 * it, and every observed completion must close the matching ledger entry — so a
 * crash/restart between authorization and completion can never be mistaken for
 * "never dispatched".
 *
 * @version v3
 */

import { randomUUID } from 'node:crypto';
import { buildEnforcementError } from './plugin-helpers.js';
import { authorizeDispatchRearm } from './review/reissue-authority.js';
import { createAttemptForExistingObligation } from './review/assurance.js';
import {
  abandonReviewDispatch,
  appendReviewDispatch,
  ensureReviewAssurance,
  markDispatchOutcomeUnknown,
} from '../state/review-continuation.js';
import type { ReviewAttempt, ReviewDispatchRecord } from '../state/evidence-review.js';
import type { SessionState } from '../state/schema.js';

export const REVIEW_DISPATCH_PERSISTENCE_FAILED = 'REVIEW_DISPATCH_PERSISTENCE_FAILED' as const;

export interface DispatchLedgerWriteDeps {
  readonly updateReviewAssurance: (
    sessDir: string,
    update: (state: SessionState, now: string) => SessionState,
  ) => Promise<void>;
}

export interface AuthorizedSdkDispatchInput {
  readonly attemptId: string;
  readonly obligationId: string;
  readonly childSessionId: string;
  readonly canonicalPromptDigest: string;
  readonly authorizedAt: string;
}

function resolveExistingDispatchForCall(
  existingForCall: readonly ReviewDispatchRecord[],
  input: AuthorizedSdkDispatchInput,
): 'append' | 'retry' | 'conflict' {
  if (existingForCall.length === 0) return 'append';
  const [existing] = existingForCall;
  const exactRetry =
    existingForCall.length === 1 &&
    existing !== undefined &&
    existing.attemptId === input.attemptId &&
    existing.obligationId === input.obligationId &&
    existing.canonicalPromptDigest === input.canonicalPromptDigest &&
    existing.dispatchStatus === 'authorized';
  return exactRetry ? 'retry' : 'conflict';
}

function assertDispatchAuthorizable(
  assurance: ReturnType<typeof ensureReviewAssurance>,
  input: AuthorizedSdkDispatchInput,
): void {
  const obligation = assurance.obligations.find((item) => item.obligationId === input.obligationId);
  const attempt = assurance.attempts.find((item) => item.attemptId === input.attemptId);
  if (
    obligation?.status === 'pending' &&
    attempt !== undefined &&
    attempt.obligationId === obligation.obligationId &&
    attempt.status === 'created' &&
    attempt.childSessionId === undefined
  ) {
    return;
  }
  throw buildEnforcementError(
    REVIEW_DISPATCH_PERSISTENCE_FAILED,
    'the reviewer dispatch requires a pending obligation with a created, unbound attempt',
  );
}

export async function persistAuthorizedSdkDispatch(
  deps: DispatchLedgerWriteDeps,
  sessDir: string,
  input: AuthorizedSdkDispatchInput,
): Promise<void> {
  await deps.updateReviewAssurance(sessDir, (state) => {
    const assurance = ensureReviewAssurance(state.reviewAssurance);
    assertDispatchAuthorizable(assurance, input);

    const existingForCall = (assurance.dispatches ?? []).filter(
      (record) => record.hostCallId === input.childSessionId,
    );
    const disposition = resolveExistingDispatchForCall(existingForCall, input);
    if (disposition === 'conflict') {
      throw buildEnforcementError(
        REVIEW_DISPATCH_PERSISTENCE_FAILED,
        'the host call ID is already bound to a different dispatch authorization',
      );
    }
    if (disposition === 'retry') return state;

    const record: ReviewDispatchRecord = {
      dispatchId: randomUUID(),
      attemptId: input.attemptId,
      obligationId: input.obligationId,
      hostCallId: input.childSessionId,
      canonicalPromptDigest: input.canonicalPromptDigest,
      dispatchAuthorizedAt: input.authorizedAt,
      dispatchStatus: 'authorized',
    };
    return {
      ...state,
      reviewAssurance: appendReviewDispatch(assurance, record),
    };
  });
}

export async function abandonSdkDispatch(
  deps: DispatchLedgerWriteDeps,
  sessDir: string,
  childSessionId: string,
): Promise<void> {
  await deps.updateReviewAssurance(sessDir, (state) => {
    const assurance = ensureReviewAssurance(state.reviewAssurance);
    return {
      ...state,
      reviewAssurance: abandonReviewDispatch(assurance, childSessionId),
    };
  });
}

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
  const authorization = authorizeDispatchRearm(assurance!, spent);
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
 * A reviewer may execute successfully while its candidate findings fail the
 * frozen pre-bind contract (scope/repository evidence/provenance). That is a
 * failed REVIEW ATTEMPT, not a new artifact revision and not a terminally
 * blocked review obligation.
 *
 * Re-arm the exact pending obligation under the same dispatch-recovery budget.
 * The rejected dispatch is durably classified outcome_unknown and the previous
 * created attempt becomes stale as the fresh attempt is minted. A late result
 * from the rejected child therefore cannot satisfy the successor attempt.
 */
export async function rearmRejectedSdkFindings(
  deps: DispatchLedgerWriteDeps,
  sessDir: string,
  spentAttemptId: string,
): Promise<{ readonly kind: 'ok'; readonly attemptId: string } | { readonly kind: 'blocked'; readonly reason: string }> {
  let result:
    | { readonly kind: 'ok'; readonly attemptId: string }
    | { readonly kind: 'blocked'; readonly reason: string } = {
    kind: 'blocked',
    reason: 'reviewer attempt not found',
  };

  await deps.updateReviewAssurance(sessDir, (state, now) => {
    const assurance = ensureReviewAssurance(state.reviewAssurance);
    const spent = assurance.attempts.find((attempt) => attempt.attemptId === spentAttemptId);
    if (!spent) {
      result = { kind: 'blocked', reason: 'reviewer attempt not found' };
      return state;
    }
    const rearmed = buildInterruptedDispatchRearm(assurance, spent, now);
    if (rearmed.kind === 'blocked') {
      result = rearmed;
      return state;
    }
    result = { kind: 'ok', attemptId: rearmed.attempt.attemptId };
    return { ...state, reviewAssurance: rearmed.assurance };
  });

  return result;
}
