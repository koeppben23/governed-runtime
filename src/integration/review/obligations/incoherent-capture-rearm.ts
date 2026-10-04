/**
 * @module integration/review/incoherent-capture-rearm
 * @description Bounded automatic re-arm for F12 incoherent reviewer captures.
 *
 * F12 (`SUBAGENT_VERDICT_FINDINGS_INCOHERENT`, reason `consistency_invalid`) is
 * a structurally incoherent but COMPLETE host release: the reviewer captured
 * findings, the attempt bound, the invocation persisted, and the durable
 * dispatch completed. Unlike the transport-recovery re-arm, nothing is unknown
 * about the host call — the review authority is intact and a fresh reviewer
 * attempt on the SAME frozen obligation can plausibly produce coherent
 * findings.
 *
 * The re-arm keeps the complete evidence record: the predecessor attempt is
 * rejected under the consistency-invalid marker (its completedAt set
 * automatically), its completed dispatch and invocation stay verbatim, and a
 * fresh append-only attempt is minted on the same obligation, which returns to
 * `pending` with cleared settlement lineage. Every re-arm draws on TWO explicit
 * caps:
 *
 *   priorF12Failures < maxIncoherentReviewerCaptureRetries
 *   usedRearms       < obligation.maxReviewerAttempts
 *
 * `priorF12Failures` is counted on the PRE-mutation state, so the default cap
 * of 1 allows exactly one retry, 0 blocks the first, and a second F12 always
 * blocks. Both caps are distinct authorities; there is deliberately no inline
 * min arithmetic.
 *
 * @version v1
 */

import type {
  ReviewAssuranceState,
  ReviewAttempt,
  ReviewInvocationEvidence,
  ReviewObligation,
} from '../../../state/evidence.js';
import { ensureReviewAssurance } from '../../../state/review-dispatch.js';
import { countReviewAttempts } from '../../../state/review-continuation.js';
import { createAttemptForExistingObligation, updateAttemptStatus } from './attempt-lifecycle.js';

export interface IncoherentCaptureRearmInput {
  readonly assurance: ReviewAssuranceState | undefined;
  readonly obligationId: string;
  /**
   * Exact F12 proof identity from the structured resolution. The authority
   * only re-arms the very invocation/attempt the resolver identified as
   * incoherent — never an arbitrary bound obligation.
   */
  readonly incoherentInvocationId: string;
  readonly incoherentAttemptId: string;
  readonly maxIncoherentReviewerCaptureRetries: number;
  readonly now: string;
}

export type IncoherentCaptureRearmAuthorization =
  { readonly kind: 'authorized' } | { readonly kind: 'blocked'; readonly reason: string };

export type IncoherentCaptureRearmResult =
  | {
      readonly kind: 'rearmed';
      readonly assurance: ReviewAssuranceState;
      readonly attempt: ReviewAttempt;
      readonly obligationId: string;
    }
  | { readonly kind: 'blocked'; readonly reason: string };

interface RearmTarget {
  readonly obligation: ReviewObligation;
  readonly invocation: ReviewInvocationEvidence;
  readonly attempt: ReviewAttempt;
}

type RearmTargetResolution =
  | { readonly kind: 'ok'; readonly target: RearmTarget }
  | { readonly kind: 'blocked'; readonly reason: string };

function blocked(reason: string): { readonly kind: 'blocked'; readonly reason: string } {
  return { kind: 'blocked', reason };
}

/**
 * Resolve the exact released attempt an F12 re-arm may replace. Every
 * mismatch fails closed: the obligation must be fulfilled, its canonical
 * invocation must resolve, and that invocation's attempt must be the BOUND
 * attempt whose child session it completed.
 */
function resolveRearmTarget(input: IncoherentCaptureRearmInput): RearmTargetResolution {
  const base = ensureReviewAssurance(input.assurance);
  const obligation = base.obligations.find((item) => item.obligationId === input.obligationId);
  if (!obligation) return blocked('incoherent_rearm_obligation_not_found');
  if (obligation.status !== 'fulfilled') {
    return blocked('incoherent_rearm_obligation_not_fulfilled');
  }
  if (obligation.invocationId === null) {
    return blocked('incoherent_rearm_invocation_missing');
  }
  // The F12 proof must match the canonical obligation linkage exactly. A
  // mismatched or stale proof never authorizes a re-arm.
  if (obligation.invocationId !== input.incoherentInvocationId) {
    return blocked('incoherent_rearm_proof_mismatch');
  }
  const invocation = base.invocations.find((item) => item.invocationId === obligation.invocationId);
  if (!invocation) return blocked('incoherent_rearm_invocation_missing');
  if (invocation.attemptId !== input.incoherentAttemptId) {
    return blocked('incoherent_rearm_proof_mismatch');
  }
  const attempt = base.attempts.find((item) => item.attemptId === invocation.attemptId);
  if (!attempt) return blocked('incoherent_rearm_attempt_missing');
  if (attempt.status !== 'bound') return blocked('incoherent_rearm_attempt_not_bound');
  if (attempt.childSessionId !== invocation.childSessionId) {
    return blocked('incoherent_rearm_binding_mismatch');
  }
  return { kind: 'ok', target: { obligation, invocation, attempt } };
}

function priorF12Failures(base: ReviewAssuranceState, obligationId: string): number {
  return base.attempts.filter(
    (attempt) =>
      attempt.obligationId === obligationId &&
      attempt.status === 'rejected' &&
      attempt.rejectionReason === 'consistency_invalid',
  ).length;
}

function authorizeResolvedTarget(
  base: ReviewAssuranceState,
  target: RearmTarget,
  input: IncoherentCaptureRearmInput,
): IncoherentCaptureRearmAuthorization {
  const failures = priorF12Failures(base, target.obligation.obligationId);
  const rearms = countReviewAttempts(base, target.obligation.obligationId);
  const allow =
    failures < input.maxIncoherentReviewerCaptureRetries &&
    rearms < target.obligation.maxReviewerAttempts;
  if (allow) return { kind: 'authorized' };
  if (failures >= input.maxIncoherentReviewerCaptureRetries) {
    return blocked(
      `incoherent reviewer capture retry budget exhausted (${String(failures)}/${String(input.maxIncoherentReviewerCaptureRetries)})`,
    );
  }
  return blocked(
    `reviewer re-arm budget exhausted (${String(rearms)}/${String(target.obligation.maxReviewerAttempts)})`,
  );
}

/**
 * Decide whether one exact F12 release may be re-armed. Pure: reads only the
 * persisted assurance state and never mutates it. Fail-closed on every
 * identity, lifecycle, or budget mismatch.
 */
export function authorizeIncoherentCaptureRearm(
  input: IncoherentCaptureRearmInput,
): IncoherentCaptureRearmAuthorization {
  const base = ensureReviewAssurance(input.assurance);
  const target = resolveRearmTarget(input);
  if (target.kind === 'blocked') return target;
  return authorizeResolvedTarget(base, target.target, input);
}

/**
 * Build the F12 re-arm as ONE in-memory assurance mutation. The caller
 * persists the returned assurance atomically inside its existing transaction.
 *
 * A1: rejected with `consistency_invalid` (completedAt set automatically).
 * A1 dispatch: unchanged (the completed release stays complete).
 * Invocation: unchanged (the rejected-attempt linkage remains coherent).
 * Obligation: pending, with cleared invocation/settlement lineage.
 * A2: a fresh attempt on the same obligation with origin
 *     `dispatch_rearm`/`spent` and the predecessor's Discovery context.
 *
 * The release outcome stays KNOWN: no dispatch is ever converted to an unknown
 * outcome.
 */
export function buildIncoherentCaptureRearm(
  input: IncoherentCaptureRearmInput,
): IncoherentCaptureRearmResult {
  const base = ensureReviewAssurance(input.assurance);
  const resolved = resolveRearmTarget(input);
  if (resolved.kind === 'blocked') return resolved;
  const authorization = authorizeResolvedTarget(base, resolved.target, input);
  if (authorization.kind === 'blocked') return authorization;
  const { obligation, attempt } = resolved.target;

  const rejected = updateAttemptStatus(base, attempt.attemptId, 'rejected', input.now, {
    rejectionReason: 'consistency_invalid',
  });
  const resetObligation: ReviewObligation = {
    ...obligation,
    status: 'pending',
    invocationId: null,
    fulfilledAt: null,
    consumedAt: null,
    blockedCode: null,
  };
  const resetAssurance: ReviewAssuranceState = {
    ...rejected,
    obligations: rejected.obligations.map((item) =>
      item.obligationId === obligation.obligationId ? resetObligation : item,
    ),
  };
  const minted = createAttemptForExistingObligation(
    resetAssurance,
    resetObligation,
    undefined,
    input.now,
    {
      origin: {
        kind: 'dispatch_rearm',
        predecessorAttemptId: attempt.attemptId,
        triggerReason: 'spent',
      },
      repositoryDiscovery: attempt.repositoryDiscovery,
    },
  );
  return {
    kind: 'rearmed',
    assurance: minted.assurance,
    attempt: minted.attempt,
    obligationId: obligation.obligationId,
  };
}
