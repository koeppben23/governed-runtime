/**
 * @module integration/review/durable-dispatch
 * @description Transport-neutral durable reviewer dispatch ledger operations.
 *
 * Every reviewer invocation must be recorded durably BEFORE the host releases
 * it, and every observed completion must close the matching ledger entry — so a
 * crash/restart between authorization and completion can never be mistaken for
 * "never dispatched".
 *
 * @version v4
 */

import { randomUUID } from 'node:crypto';
import { buildEnforcementError } from '../../blocked-result.js';

import { authorizeDispatchRearm } from '../obligations/reissue-authority.js';
import {
  createAttemptForExistingObligation,
  updateAttemptStatus,
} from '../obligations/attempt-lifecycle.js';
import {
  abandonReviewDispatch,
  appendReviewDispatch,
  ensureReviewAssurance,
  markDispatchOutcomeUnknown,
} from '../../../state/review-dispatch.js';
import type { ReviewAttempt, ReviewDispatchRecord } from '../../../state/evidence-review.js';
import type { SessionState } from '../../../state/schema.js';

const REVIEW_DISPATCH_PERSISTENCE_FAILED = 'REVIEW_DISPATCH_PERSISTENCE_FAILED' as const;

export interface DispatchLedgerWriteDeps {
  readonly updateReviewAssurance: (
    sessDir: string,
    update: (state: SessionState, now: string) => SessionState,
  ) => Promise<void>;
}

export interface AuthorizedReviewDispatchInput {
  readonly attemptId: string;
  readonly obligationId: string;
  /**
   * Host call identity carried by the durable release. Native Task releases are
   * authorized under the Task call ID and rebound to the exact child session ID
   * when evidence binds.
   */
  readonly hostCallId: string;
  readonly canonicalPromptDigest: string;
  readonly authorizedAt: string;
}

function resolveExistingDispatchForCall(
  existingForCall: readonly ReviewDispatchRecord[],
  input: AuthorizedReviewDispatchInput,
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
  input: AuthorizedReviewDispatchInput,
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

/** Persist an exact reviewer host release before the host may execute it. */
export async function persistAuthorizedReviewDispatch(
  deps: DispatchLedgerWriteDeps,
  sessDir: string,
  input: AuthorizedReviewDispatchInput,
): Promise<void> {
  await deps.updateReviewAssurance(sessDir, (state) => {
    const assurance = ensureReviewAssurance(state.reviewAssurance);
    assertDispatchAuthorizable(assurance, input);

    const existingForCall = (assurance.dispatches ?? []).filter(
      (record) => record.hostCallId === input.hostCallId,
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
      hostCallId: input.hostCallId,
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
 * Resolve a concluded host call without bound evidence as outcome_unknown and
 * mark the exact released attempt stale in the SAME durable mutation.
 *
 * Exact lineage is mandatory: the host call must resolve to exactly ONE
 * `authorized` dispatch record, and that record's attempt must be exactly ONE
 * `created` attempt for the obligation. Anything else is a no-op (the caller
 * still fails the review closed); there is no best-effort fallback to another
 * attempt or an obligation-wide stale.
 */
export async function abandonReviewDispatchByHostCall(
  deps: DispatchLedgerWriteDeps,
  sessDir: string,
  hostCallId: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  await deps.updateReviewAssurance(sessDir, (state) => {
    const assurance = ensureReviewAssurance(state.reviewAssurance);
    const authorized = (assurance.dispatches ?? []).filter(
      (record) => record.hostCallId === hostCallId && record.dispatchStatus === 'authorized',
    );
    if (authorized.length !== 1) return state;
    const record = authorized[0];
    if (record === undefined) return state;
    const attempt = (assurance.attempts ?? []).find(
      (candidate) => candidate.attemptId === record.attemptId,
    );
    if (attempt === undefined || attempt.status !== 'created') return state;

    const abandoned = {
      ...state,
      reviewAssurance: abandonReviewDispatch(assurance, hostCallId),
    };
    return {
      ...abandoned,
      reviewAssurance: updateAttemptStatus(
        ensureReviewAssurance(abandoned.reviewAssurance),
        attempt.attemptId,
        'stale',
        now,
      ),
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
  const authorization = authorizeDispatchRearm(ensureReviewAssurance(assurance), spent);
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
