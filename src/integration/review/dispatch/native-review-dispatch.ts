/** Native V2 release authority only. Capture, evidence and recovery are not authorized here. */
import { buildEnforcementError } from '../../blocked-result.js';
import { hashText } from '../../../shared/hashing.js';
import { findBindableAttempt } from '../../../state/review-continuation.js';
import { ensureReviewAssurance } from '../../../state/review-dispatch.js';
import type { SessionState } from '../../../state/schema.js';
import type { SessionEnforcementState } from '../types.js';
import { isCurrentReviewGeneration } from '../obligations/assurance.js';
import { updateAttemptStatus } from '../obligations/attempt-lifecycle.js';
import type { ReviewerProofGraphAuthorities } from '../context/proof-context.js';
import { canonicalTaskPrompt } from './native-task-review-prompt.js';
import {
  persistAuthorizedReviewDispatch,
  type DispatchLedgerWriteDeps,
} from './durable-dispatch.js';

function denied(reason: string): never {
  throw buildEnforcementError('REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE', reason);
}

function assertReleaseAvailable(state: SessionState, attemptId: string): void {
  const assurance = ensureReviewAssurance(state.reviewAssurance);
  if (assurance.dispatches.some((item) => item.dispatchStatus !== 'completed'))
    denied('An earlier reviewer release remains quarantined; recovery is not verified.');
  if (assurance.capacityLock || assurance.dispatches.some((item) => item.attemptId === attemptId))
    denied('This review attempt cannot be released again or through a capacity lock.');
}

function pendingAttempt(state: SessionState, enforcement: SessionEnforcementState) {
  const pending = [...enforcement.pendingReviews.values()].filter(
    (item) => item.obligationId !== null && item.attemptId !== null,
  );
  if (pending.length !== 1) return denied('A unique pending review operation is required.');
  const assurance = ensureReviewAssurance(state.reviewAssurance);
  const obligation = assurance.obligations.find(
    (item) => item.obligationId === pending[0]?.obligationId,
  );
  const attempt = obligation && findBindableAttempt(assurance, obligation.obligationId);
  if (
    !obligation ||
    obligation.status !== 'pending' ||
    !isCurrentReviewGeneration(obligation) ||
    !attempt ||
    attempt.attemptId !== pending[0]?.attemptId
  )
    return denied('The pending operation is not the exact current unbound review attempt.');
  // No recovery is enabled by the dispatch port. An earlier unresolved native
  // release fences even a newly minted attempt or another obligation.
  assertReleaseAvailable(state, attempt.attemptId);
  return { obligation, attempt, retryDiagnostics: pending[0]?.retryDiagnostics };
}

export interface NativeReviewStateAuthority {
  readonly parentSessionId: string;
  readonly policyDigest: string;
  readonly worktreeRoot: string;
}

function assertStateScope(state: SessionState, authority: NativeReviewStateAuthority): void {
  if (
    state.binding.hostSessionId !== authority.parentSessionId ||
    state.binding.worktree !== authority.worktreeRoot ||
    state.policySnapshot.hash !== authority.policyDigest ||
    state.error
  )
    denied('Review state no longer matches its exact ACTIVE parent/worktree/policy.');
}

export async function authorizeNativeReviewDispatch(input: {
  readonly deps: DispatchLedgerWriteDeps;
  readonly sessDir: string;
  readonly state: SessionState;
  readonly authority: NativeReviewStateAuthority;
  readonly enforcement: SessionEnforcementState;
  readonly hostCallId: string;
  readonly proof: ReviewerProofGraphAuthorities;
}): Promise<string> {
  const { deps, sessDir, state, authority, enforcement, hostCallId, proof } = input;
  assertStateScope(state, authority);
  const { obligation, attempt, retryDiagnostics } = pendingAttempt(state, enforcement);
  const prompt = canonicalTaskPrompt(state, obligation, attempt, proof, retryDiagnostics);
  let mutated = false;
  await persistAuthorizedReviewDispatch(
    {
      updateReviewAssurance: (dir, update) =>
        deps.updateReviewAssurance(dir, (fresh, now) => {
          assertStateScope(fresh, authority);
          const current = pendingAttempt(fresh, enforcement);
          if (
            current.obligation.obligationId !== obligation.obligationId ||
            current.attempt.attemptId !== attempt.attemptId ||
            canonicalTaskPrompt(
              fresh,
              current.obligation,
              current.attempt,
              proof,
              current.retryDiagnostics,
            ) !== prompt
          )
            return denied(
              'Review authority or frozen prompt changed before durable authorization.',
            );
          const next = update(fresh, now);
          mutated = true;
          return next;
        }),
    },
    sessDir,
    {
      obligationId: obligation.obligationId,
      attemptId: attempt.attemptId,
      hostCallId,
      canonicalPromptDigest: hashText(prompt),
      authorizedAt: new Date().toISOString(),
    },
  );
  if (!mutated) return denied('No durable review authorization was written.');
  return prompt;
}

/** Exact ledger lineage, never the latest attempt or host completion text. */
function only<T>(items: readonly T[]): T {
  const value = items[0];
  if (items.length !== 1 || value === undefined)
    return denied('Review lineage is missing or ambiguous.');
  return value;
}

export function nativeReviewDispatchLineage(
  state: SessionState,
  authority: NativeReviewStateAuthority,
  hostCallId: string,
  childSessionId?: string,
) {
  assertStateScope(state, authority);
  const assurance = ensureReviewAssurance(state.reviewAssurance);
  const matches = assurance.dispatches.filter((item) => item.hostCallId === hostCallId);
  const dispatch = only(matches);
  const attempt = only(assurance.attempts.filter((item) => item.attemptId === dispatch.attemptId));
  const obligation = only(
    assurance.obligations.filter((item) => item.obligationId === dispatch.obligationId),
  );
  if (
    dispatch.dispatchStatus !== 'authorized' ||
    attempt.status !== 'created' ||
    obligation.status !== 'pending' ||
    attempt.obligationId !== obligation.obligationId ||
    !isCurrentReviewGeneration(obligation) ||
    assurance.capacityLock ||
    (childSessionId !== undefined && attempt.childSessionId !== childSessionId)
  )
    return denied('No exact current authorized dispatch/attempt/obligation/child lineage exists.');
  return { dispatch, attempt, obligation };
}

export async function bindNativeReviewChild(input: {
  readonly deps: DispatchLedgerWriteDeps;
  readonly sessDir: string;
  readonly authority: NativeReviewStateAuthority;
  readonly hostCallId: string;
  readonly childSessionId: string;
}): Promise<void> {
  let mutated = false;
  await input.deps.updateReviewAssurance(input.sessDir, (state, now) => {
    const { attempt } = nativeReviewDispatchLineage(state, input.authority, input.hostCallId);
    if (
      input.childSessionId === input.authority.parentSessionId ||
      (attempt.childSessionId !== undefined && attempt.childSessionId !== input.childSessionId) ||
      state.reviewAssurance?.attempts.some(
        (item) =>
          item.attemptId !== attempt.attemptId && item.childSessionId === input.childSessionId,
      )
    )
      return denied('A reviewer child cannot be shared, replaced or equal its parent.');
    mutated = true;
    return {
      ...state,
      reviewAssurance: updateAttemptStatus(
        ensureReviewAssurance(state.reviewAssurance),
        attempt.attemptId,
        'created',
        now,
        { childSessionId: input.childSessionId },
      ),
    };
  });
  if (!mutated) denied('The exact native child was not durably bound.');
}
