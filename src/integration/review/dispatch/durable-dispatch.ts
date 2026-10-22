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

import {
  authorizeDispatchRearm,
  type DispatchRearmBlockCause,
} from '../obligations/reissue-authority.js';
import { blockObligation } from '../obligations/obligation-state.js';
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
import type {
  ReviewAttempt,
  ReviewDispatchRecord,
  ReviewObligation,
} from '../../../state/evidence-review.js';
import type { SessionState } from '../../../state/schema.js';
import type { SemanticAuditIntent } from '../../audit-outbox.js';
import type { PendingReviewRetryDiagnostic } from '../types.js';
import { captureClosureAuditDiagnostics } from './capture-retry.js';

const REVIEW_DISPATCH_PERSISTENCE_FAILED = 'REVIEW_DISPATCH_PERSISTENCE_FAILED' as const;

export interface DispatchLedgerWriteDeps {
  readonly updateReviewAssurance: (
    sessDir: string,
    update: (state: SessionState, now: string) => SessionState,
    semanticIntents?: (state: SessionState, now: string) => readonly SemanticAuditIntent[],
  ) => Promise<void>;
}

/** Bounded capture-failure facts carried into the budget-exhausted closure audit. */
export interface CaptureClosureAuditInput {
  readonly code: string;
  readonly diagnostics: readonly PendingReviewRetryDiagnostic[];
  /**
   * Child session that produced the failed capture, when the native Task
   * release already bound it. It is written to the staled attempt in the SAME
   * mutation that abandons the dispatch, so the discarded reviewer transcript
   * stays attributable. It never authorizes evidence on its own.
   */
  readonly childSessionId?: string;
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
    assurance.capacityLock == null &&
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

    const authorizedForAttempt = (assurance.dispatches ?? []).filter(
      (record) => record.attemptId === input.attemptId && record.dispatchStatus === 'authorized',
    );
    if (authorizedForAttempt.length > 0) {
      throw buildEnforcementError(
        REVIEW_DISPATCH_PERSISTENCE_FAILED,
        'the reviewer attempt already has an authorized dispatch release',
      );
    }

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

export type AbandonAndBlockOutcome =
  | { readonly kind: 'blocked'; readonly obligationId: string; readonly code: string }
  | {
      readonly kind: 'terminal';
      readonly obligationId: string;
      readonly status: 'completed' | 'blocked';
    }
  | {
      readonly kind: 'unresolved';
      readonly code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN';
      readonly reason: string;
    };

export interface ExecutionClosureIdentity {
  readonly childSessionId?: string;
  readonly dispatchId?: string;
  readonly attemptId?: string;
  readonly obligationId?: string;
}

/** Resolve only recorded execution identities, including a dispatch rebound to its child. */
export function resolveExecutionDispatch(
  assurance: ReturnType<typeof ensureReviewAssurance>,
  hostCallId: string,
  identity: ExecutionClosureIdentity,
): ReviewDispatchRecord | undefined {
  const matches = assurance.dispatches.filter((record) => {
    if (identity.dispatchId !== undefined && record.dispatchId !== identity.dispatchId)
      return false;
    if (identity.attemptId !== undefined && record.attemptId !== identity.attemptId) return false;
    if (identity.obligationId !== undefined && record.obligationId !== identity.obligationId)
      return false;
    return (
      identity.dispatchId !== undefined ||
      record.hostCallId === hostCallId ||
      (identity.childSessionId !== undefined && record.hostCallId === identity.childSessionId)
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** Terminal evidence must belong to this exact dispatch, attempt and child. */
export function executionDispatchIsTerminal(
  assurance: ReturnType<typeof ensureReviewAssurance>,
  record: ReviewDispatchRecord,
  childSessionId?: string,
): boolean {
  const attempt = assurance.attempts.find((item) => item.attemptId === record.attemptId);
  if (!attempt || attempt.obligationId !== record.obligationId) return false;
  if (
    childSessionId !== undefined &&
    attempt.childSessionId !== undefined &&
    attempt.childSessionId !== childSessionId
  )
    return false;
  if (record.dispatchStatus === 'outcome_unknown') return attempt.status === 'stale';
  return (
    record.dispatchStatus === 'completed' &&
    attempt.status === 'bound' &&
    assurance.invocations.some(
      (item) =>
        item.attemptId === attempt.attemptId &&
        item.obligationId === record.obligationId &&
        item.childSessionId === attempt.childSessionId,
    )
  );
}

function canCloseExecution(
  attempt: ReviewAttempt,
  obligation: ReviewObligation,
  child?: string,
): boolean {
  return (
    (obligation.status === 'pending' || obligation.status === 'blocked') &&
    (attempt.status === 'created' || attempt.status === 'stale') &&
    (!child || !attempt.childSessionId || attempt.childSessionId === child)
  );
}

function hasTerminalBlock(
  assurance: ReturnType<typeof ensureReviewAssurance>,
  record: ReviewDispatchRecord,
  obligation: ReviewObligation,
  attempt: ReviewAttempt,
): boolean {
  return (
    obligation.status === 'blocked' &&
    record.dispatchStatus === 'outcome_unknown' &&
    attempt.status === 'stale' &&
    assurance.capacityLock != null
  );
}

function blockedExecutionState(
  state: SessionState,
  record: ReviewDispatchRecord,
  options: ExecutionClosureIdentity,
  code: string,
  now: string,
): SessionState {
  const assurance = ensureReviewAssurance(state.reviewAssurance);
  const staled = bindStaleChildSession(
    updateAttemptStatus(
      abandonReviewDispatch(assurance, record.hostCallId),
      record.attemptId,
      'stale',
      now,
    ),
    record.attemptId,
    options.childSessionId,
  );
  const blocked = blockObligation({ ...state, reviewAssurance: staled }, record.obligationId, code);
  return {
    ...blocked,
    reviewAssurance: {
      ...ensureReviewAssurance(blocked.reviewAssurance),
      capacityLock: assurance.capacityLock ?? {
        code,
        obligationId: record.obligationId,
        createdAt: now,
      },
    },
  };
}

/**
 * Close one exact authorized host release and block its obligation in a single
 * durable mutation. This is the terminal capacity path: the attempt is staled,
 * the dispatch becomes outcome_unknown, the obligation is blocked with the
 * original code, and a persistent capacity lock prevents another review in the
 * same parent turn.
 *
 * Exact lineage is mandatory. Completed invocations are immutable. Repeated
 * blocked closures retain their lock without emitting another audit intent.
 */
export async function abandonAndBlockByHostCall(
  deps: DispatchLedgerWriteDeps,
  sessDir: string,
  hostCallId: string,
  code: string,
  options: ExecutionClosureIdentity & { readonly now?: string } = {},
): Promise<AbandonAndBlockOutcome> {
  const now = options.now ?? new Date().toISOString();
  let outcome: AbandonAndBlockOutcome = {
    kind: 'unresolved',
    code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    reason: 'No unique unfinished execution lineage could be proven.',
  };
  let audit = false;
  await deps.updateReviewAssurance(
    sessDir,
    (state) => {
      const assurance = ensureReviewAssurance(state.reviewAssurance);
      const record = resolveExecutionDispatch(assurance, hostCallId, options);
      if (!record) return state;
      const attempt = (assurance.attempts ?? []).find(
        (candidate) => candidate.attemptId === record.attemptId,
      );
      const obligation = assurance.obligations.find(
        (item) => item.obligationId === record.obligationId,
      );
      if (!attempt || !obligation || attempt.obligationId !== obligation.obligationId) return state;
      if (record.dispatchStatus === 'completed') {
        if (executionDispatchIsTerminal(assurance, record, options.childSessionId)) {
          outcome = {
            kind: 'terminal',
            status: 'completed',
            obligationId: obligation.obligationId,
          };
        }
        return state;
      }
      if (!canCloseExecution(attempt, obligation, options.childSessionId)) return state;
      if (hasTerminalBlock(assurance, record, obligation, attempt)) {
        outcome = { kind: 'terminal', status: 'blocked', obligationId: obligation.obligationId };
        return state;
      }
      const blockedCode = obligation.blockedCode ?? code;

      audit = obligation.status !== 'blocked';
      outcome = { kind: 'blocked', obligationId: attempt.obligationId, code: blockedCode };
      return blockedExecutionState(state, record, options, blockedCode, now);
    },
    (state) =>
      audit && outcome.kind === 'blocked'
        ? [
            {
              phase: state.phase,
              event: 'review:obligation_blocked',
              occurredAt: now,
              detail: { obligationId: outcome.obligationId, code: outcome.code },
            },
          ]
        : [],
  );
  return outcome;
}

export type AbandonAndRearmOutcome =
  | { readonly kind: 'rearmed'; readonly attempt: ReviewAttempt; readonly obligationId: string }
  | {
      readonly kind: 'blocked';
      readonly reason: string;
      readonly cause: DispatchRearmBlockCause;
      readonly obligationId: string;
    }
  | { readonly kind: 'noop' };

/**
 * Abandon one exact authorized host release and re-arm a fresh reviewer attempt
 * on the same frozen obligation in ONE durable mutation.
 *
 * Exact lineage is mandatory: exactly ONE `authorized` dispatch for the host
 * call and exactly the `created` attempt it points to. Anything else is a no-op
 * and the caller still fails the review closed. The re-arm budget is the
 * existing obligation `maxReviewerAttempts` (via `authorizeDispatchRearm`).
 *
 * When the re-arm is refused, the abandon+stale mutation is still persisted so
 * the spent attempt can never be re-released; only the fresh attempt mint is
 * skipped. A budget-exhausted refusal additionally binds a semantic
 * `review:obligation_blocked` audit intent to that same mutation, so the audit
 * trail records the closure with the bounded capture diagnostics — but only
 * when the resulting state actually carries the blocked obligation.
 */
export async function abandonAndRearmByHostCall(
  deps: DispatchLedgerWriteDeps,
  sessDir: string,
  hostCallId: string,
  now: string = new Date().toISOString(),
  captureFailure?: CaptureClosureAuditInput,
): Promise<AbandonAndRearmOutcome> {
  let outcome: AbandonAndRearmOutcome = { kind: 'noop' };
  await deps.updateReviewAssurance(
    sessDir,
    (state) => {
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

      const staled = bindStaleChildSession(
        updateAttemptStatus(
          abandonReviewDispatch(assurance, hostCallId),
          attempt.attemptId,
          'stale',
          now,
        ),
        attempt.attemptId,
        captureFailure?.childSessionId,
      );
      const spent = (staled.attempts ?? []).find(
        (candidate) => candidate.attemptId === attempt.attemptId,
      );
      if (spent === undefined) return state;

      const rearm = buildInterruptedDispatchRearm(staled, spent, now);
      if (rearm.kind === 'blocked') {
        outcome = {
          kind: 'blocked',
          reason: rearm.reason,
          cause: rearm.cause,
          obligationId: attempt.obligationId,
        };
        // The attempt budget is exhausted: the obligation is unrecoverable in
        // place. Close it deterministically so the next originating command can
        // mint a fresh obligation instead of dead-ending on a pending one.
        if (rearm.cause === 'budget_exhausted') {
          return blockObligation(
            { ...state, reviewAssurance: staled },
            attempt.obligationId,
            'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
          );
        }
        return { ...state, reviewAssurance: staled };
      }
      outcome = {
        kind: 'rearmed',
        attempt: rearm.attempt,
        obligationId: rearm.attempt.obligationId,
      };
      return { ...state, reviewAssurance: rearm.assurance };
    },
    closureAuditIntents(() => outcome, captureFailure, now),
  );
  return outcome;
}

/**
 * Persist the failing child session on the attempt that this exact host call is
 * staling. The mutation never overwrites a different already-bound child (that
 * would rewrite provenance); it only fills the lineage gap the retry left.
 */
function bindStaleChildSession(
  assurance: ReturnType<typeof ensureReviewAssurance>,
  attemptId: string,
  childSessionId: string | undefined,
): ReturnType<typeof ensureReviewAssurance> {
  if (childSessionId === undefined) return assurance;
  return {
    ...assurance,
    attempts: (assurance.attempts ?? []).map((candidate) =>
      candidate.attemptId === attemptId && candidate.childSessionId === undefined
        ? { ...candidate, childSessionId }
        : candidate,
    ),
  };
}

/**
 * Semantic audit intent for the budget-exhausted closure, evaluated against the
 * state produced by the SAME mutation. It is emitted only when that mutation
 * set a blocked/budget-exhausted outcome AND the resulting state carries the
 * blocked obligation; a no-op (repeated host call, missing lineage) never sets
 * a blocked outcome and stays silent, so the closure is never reported twice.
 */
function closureAuditIntents(
  currentOutcome: () => AbandonAndRearmOutcome,
  captureFailure: CaptureClosureAuditInput | undefined,
  now: string,
): (state: SessionState) => readonly SemanticAuditIntent[] {
  return (state) => {
    const outcome = currentOutcome();
    if (outcome.kind !== 'blocked' || outcome.cause !== 'budget_exhausted') return [];
    const obligationId = outcome.obligationId;
    const obligation = ensureReviewAssurance(state.reviewAssurance).obligations.find(
      (item) => item.obligationId === obligationId,
    );
    if (!obligation || obligation.status !== 'blocked') return [];
    return [
      {
        phase: state.phase,
        event: 'review:obligation_blocked',
        occurredAt: now,
        detail: {
          obligationId,
          blockedCode: obligation.blockedCode ?? 'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
          ...(captureFailure !== undefined
            ? {
                captureCode: captureFailure.code,
                diagnostics: captureClosureAuditDiagnostics(captureFailure.diagnostics),
              }
            : {}),
        },
      },
    ];
  };
}

export type InterruptedDispatchRearm =
  | {
      readonly kind: 'ok';
      readonly assurance: SessionState['reviewAssurance'];
      readonly attempt: ReviewAttempt;
    }
  | { readonly kind: 'blocked'; readonly reason: string; readonly cause: DispatchRearmBlockCause };

export function buildInterruptedDispatchRearm(
  assurance: SessionState['reviewAssurance'] | undefined,
  spent: ReviewAttempt,
  now: string,
): InterruptedDispatchRearm {
  const authorization = authorizeDispatchRearm(ensureReviewAssurance(assurance), spent);
  if (authorization.kind === 'blocked') {
    return { kind: 'blocked', reason: authorization.reason, cause: authorization.cause };
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
