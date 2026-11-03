/**
 * @module integration/review/native-review-settlement
 * @description Recovery of a reviewer execution whose outcome is unknown.
 *
 * A reviewer interrupted during capture leaves its obligation blocked with
 * `REVIEWER_EXECUTION_OUTCOME_UNKNOWN` and a capacity lock. Caller text never
 * lifts that state. It is reopened only when all three facts are proven:
 *
 * 1. a later user turn: the parent history contains a user message after the
 *    assistant message that released the failed reviewer;
 * 2. host settlement: the stale reviewer child was interrupted without resume,
 *    the host wait returned, and two consecutive history reads are identical and
 *    end in an idle boundary - the child is not executing;
 * 3. an exact durable lineage: one stale attempt, one `outcome_unknown`
 *    dispatch, no evidence and no successor attempt.
 *
 * The reopen is one durable mutation (obligation pending, lock cleared) with an
 * audit intent. It mints no attempt: the typed `retry_transport` path then
 * re-arms a fresh attempt within the frozen budget. The historical attempt,
 * dispatch and child are kept verbatim.
 */

import { buildEnforcementError } from '../../blocked-result.js';
import { canonicalJsonStringify } from '../../../shared/canonical-json.js';
import { readHostCallIdentity } from '../../../state/host-identity.js';
import type {
  ReviewAttempt,
  ReviewDispatchRecord,
  ReviewObligation,
  ReviewObligationType,
} from '../../../state/evidence.js';
import { ensureReviewAssurance } from '../../../state/review-dispatch.js';
import type { SessionState } from '../../../state/schema.js';
import type { SemanticAuditIntent } from '../../audit-outbox.js';
import { updateObligation } from '../obligations/obligation-state.js';

const UNKNOWN = 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN';

/** Host operations the settlement proof needs; supplied by the host adapter composition. */
export interface SettlementHost {
  context(sessionID: string): Promise<readonly unknown[]>;
  interrupt(sessionID: string): Promise<unknown>;
  wait(sessionID: string): Promise<void>;
}

export interface UnknownOutcomeTarget {
  readonly obligation: ReviewObligation;
  readonly attempt: ReviewAttempt & { readonly childSessionId: string };
  readonly dispatch: ReviewDispatchRecord;
}

type Row = Record<string, unknown>;
function row(value: unknown): Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}

type Assurance = ReturnType<typeof ensureReviewAssurance>;

/** The obligation blocked by an unknown-outcome capacity lock of the requested family. */
function lockedObligation(
  assurance: Assurance,
  obligationType: ReviewObligationType,
): ReviewObligation | null {
  const lock = assurance.capacityLock;
  if (!lock || lock.code !== UNKNOWN) return null;
  const obligation = assurance.obligations.find((item) => item.obligationId === lock.obligationId);
  return obligation?.obligationType === obligationType &&
    obligation.status === 'blocked' &&
    obligation.blockedCode === UNKNOWN
    ? obligation
    : null;
}

/** Stale, evidence-free attempts of the obligation that no re-arm has superseded. */
function unsupersededStaleAttempts(assurance: Assurance, obligationId: string): ReviewAttempt[] {
  return assurance.attempts.filter(
    (attempt) =>
      attempt.obligationId === obligationId &&
      attempt.status === 'stale' &&
      !assurance.invocations.some((item) => item.attemptId === attempt.attemptId) &&
      !assurance.attempts.some(
        (successor) =>
          successor.origin.kind === 'dispatch_rearm' &&
          successor.origin.predecessorAttemptId === attempt.attemptId,
      ),
  );
}

/**
 * The exact recoverable lineage behind an unknown-outcome capacity lock of the
 * requested obligation family, or null when the lock is absent, of another kind
 * or not exactly provable (the existing capacity gate then refuses).
 */
export function unknownOutcomeTarget(
  state: SessionState,
  obligationType: ReviewObligationType,
): UnknownOutcomeTarget | null {
  const assurance = ensureReviewAssurance(state.reviewAssurance);
  const obligation = lockedObligation(assurance, obligationType);
  if (!obligation) return null;
  const dispatches = assurance.dispatches.filter(
    (item) => item.obligationId === obligation.obligationId,
  );
  if (dispatches.some((item) => item.dispatchStatus === 'authorized')) return null;
  const candidates = unsupersededStaleAttempts(assurance, obligation.obligationId);
  const [attempt] = candidates;
  if (candidates.length !== 1 || attempt?.childSessionId === undefined) return null;
  const released = dispatches.filter((item) => item.attemptId === attempt.attemptId);
  const [dispatch] = released;
  if (released.length !== 1 || dispatch?.dispatchStatus !== 'outcome_unknown') return null;
  return {
    obligation,
    attempt: { ...attempt, childSessionId: attempt.childSessionId },
    dispatch,
  };
}

/** A user message follows the parent assistant message that released the failed reviewer. */
export function assertLaterUserTurn(
  parentHistory: readonly unknown[],
  dispatch: ReviewDispatchRecord,
): void {
  const identity = readHostCallIdentity(dispatch.hostCallId);
  const released = identity
    ? parentHistory.findIndex(
        (entry) => row(entry).type === 'assistant' && row(entry).id === identity.messageId,
      )
    : -1;
  if (
    released < 0 ||
    !parentHistory.slice(released + 1).some((entry) => row(entry).type === 'user')
  )
    throw buildEnforcementError(
      'REVIEW_CAPACITY_REQUIRES_NEW_USER_COMMAND',
      'An unknown reviewer outcome is recovered only in a later user turn after the failed release.',
    );
}

/** Interrupt without resume, wait, and prove a stable idle boundary of the stale child. */
export async function proveChildSettled(
  host: SettlementHost,
  childSessionId: string,
): Promise<void> {
  await host.interrupt(childSessionId);
  await host.wait(childSessionId);
  const first = await host.context(childSessionId);
  const second = await host.context(childSessionId);
  const last = row(first.at(-1));
  if (
    first.length === 0 ||
    canonicalJsonStringify(first) !== canonicalJsonStringify(second) ||
    last.type !== 'idle' ||
    last.outcome === 'running'
  )
    throw buildEnforcementError(
      UNKNOWN,
      'The stale reviewer child has no stable idle boundary; its execution may continue.',
    );
}

/** Pure reopen transition for the exact proven lineage; fails closed if it changed. */
export function reopenUnknownOutcome(
  state: SessionState,
  expected: UnknownOutcomeTarget,
): SessionState {
  const current = unknownOutcomeTarget(state, expected.obligation.obligationType);
  if (
    !current ||
    current.obligation.obligationId !== expected.obligation.obligationId ||
    current.attempt.attemptId !== expected.attempt.attemptId ||
    current.dispatch.hostCallId !== expected.dispatch.hostCallId
  )
    throw buildEnforcementError(
      UNKNOWN,
      'The unknown-outcome lineage changed during settlement; nothing was reopened.',
    );
  const reopened = updateObligation(state, expected.obligation.obligationId, (item) => ({
    ...item,
    status: 'pending',
    blockedCode: null,
  }));
  return {
    ...reopened,
    reviewAssurance: { ...ensureReviewAssurance(reopened.reviewAssurance), capacityLock: null },
  };
}

export function reopenAuditIntents(target: UnknownOutcomeTarget) {
  return (state: SessionState, occurredAt: string): readonly SemanticAuditIntent[] => [
    {
      phase: state.phase,
      event: 'review:obligation_reopened',
      occurredAt,
      detail: {
        obligationId: target.obligation.obligationId,
        attemptId: target.attempt.attemptId,
        childSessionId: target.attempt.childSessionId,
        priorBlockedCode: UNKNOWN,
        settlement: 'later_user_turn+host_interrupt_idle',
      },
    },
  ];
}
