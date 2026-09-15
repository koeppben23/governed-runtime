/**
 * @module integration/review/enforcement/durable-dispatch
 * @description Durable reviewer dispatch ledger operations.
 *
 * Every reviewer invocation must be recorded durably BEFORE the host releases
 * it, and every observed completion must close the matching ledger entry — so a
 * crash/restart between authorization and completion can never be mistaken for
 * "never dispatched". This module owns the host-facing persistence for that
 * ledger:
 *
 *   - `persistAuthorizedSdkDispatch` — write an `authorized` entry after the
 *     reviewer child session exists and before `session.prompt` is released.
 *   - `abandonSdkDispatch` — classify a host call that concluded without bound
 *     evidence as `outcome_unknown` (transport failure, timeout, contract
 *     violation, rejected findings).
 *   - `buildInterruptedDispatchRearm` — recovery for an attempt whose durable
 *     ledger still reports an unresolved `authorized` outcome: the spent
 *     attempt is superseded and a fresh append-only attempt is minted on the
 *     SAME obligation.
 *
 * Every write runs through the canonical locked assurance update so the ledger
 * and attempt state cannot diverge under concurrency.
 *
 * @version v2
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

/** Reason code emitted when the durable dispatch could not be persisted. */
export const REVIEW_DISPATCH_PERSISTENCE_FAILED = 'REVIEW_DISPATCH_PERSISTENCE_FAILED' as const;

/** Minimal write authority required to persist the dispatch ledger. */
export interface DispatchLedgerWriteDeps {
  readonly updateReviewAssurance: (
    sessDir: string,
    update: (state: SessionState, now: string) => SessionState,
  ) => Promise<void>;
}

export interface AuthorizedSdkDispatchInput {
  readonly attemptId: string;
  readonly obligationId: string;
  /** The host-observed child session that is about to receive the prompt. */
  readonly childSessionId: string;
  /** Canonical digest of the exact prompt released to the host. */
  readonly canonicalPromptDigest: string;
  /** Host-observed time at which the prompt may be released. */
  readonly authorizedAt: string;
}

/**
 * A host call ID may only be treated as an idempotent retry when the existing
 * ledger entry represents EXACTLY this authorization. Any other collision
 * (different attempt, obligation, or prompt digest, or an already-resolved
 * status) fails closed: no host release without a durable authorization for
 * exactly that release.
 */
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

/** Require a pending obligation with a created, unbound attempt for the release. */
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

/**
 * Persist the durable dispatch entry for a reviewer child session BEFORE the
 * host may release the prompt. Fails closed: a missing obligation, a
 * non-`created` attempt, or an already-bound attempt aborts the reviewer
 * invocation instead of prompting without a ledger entry.
 */
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

/**
 * Classify a concluded host call without bound evidence as `outcome_unknown`.
 * The ledger stays append-only: the record is never removed, only resolved.
 * A persistence failure here leaves the entry `authorized`, which the next
 * command resolves as an interrupted dispatch — fail-closed either way.
 */
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

/**
 * Pure, tool-route-friendly composition of the reviewer dispatch re-arm. It
 * takes an in-memory assurance + spent attempt (not a plugin runtime) and
 * performs NO write — the caller persists the resulting assurance with its own
 * write authority. This is the shared authority so the interrupted-dispatch
 * routes cannot drift.
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
