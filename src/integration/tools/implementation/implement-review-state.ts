/**
 * @module integration/tools/implementation/implement-review-state
 * @description Implementation-review finding resolution and review-state mutation.
 *
 * Extracted from `implement-review.ts` along the review-findings/state boundary:
 * open-challenge projection, host-captured findings resolution and validation,
 * and the append-only impl-review state transition.
 *
 * @version v1
 */

import type { SessionState } from '../../../state/schema.js';
import type { LoopVerdict, ReviewFindings } from '../../../state/evidence.js';
import { IntegrationInvariantError } from '../../errors.js';
import { formatBlocked, unableReviewDiagnostics } from '../../blocked-result.js';

import { resolveStructuredEffectiveFindings } from '../../review/validation/review-validation.js';
import { collectPreviouslyUsedChallengeIds } from '../../review/obligations/challenge-history.js';
import {
  consumeReviewObligation,
  findLatestObligation,
} from '../../review/obligations/assurance.js';
import { updateObligation } from '../../review/obligations/obligation-state.js';
import { buildInterruptedDispatchRearm } from '../../review/dispatch/durable-dispatch.js';
import { unsupersededStaleAttempts } from '../../review/dispatch/native-review-settlement.js';
import { ensureReviewAssurance, isOpenReviewObligation } from '../../../state/review-dispatch.js';
import { buildLatestImplementationReviewSummary } from './review-summary.js';
import { buildReviewChallengeContract } from '../../review/obligations/challenge-contract.js';
import { normalizeHostFindings, type ImplementRuntime } from './implement-shared.js';
import {
  projectImplementationChallengeResolutionRequirements,
  projectOpenImplementationChallengeIds,
} from '../../../state/implementation-review-findings.js';

export function findOpenImplObligation(state: SessionState) {
  const assuranceBase = ensureReviewAssurance(state.reviewAssurance);
  return (
    [...assuranceBase.obligations]
      .reverse()
      .find((item) => item.obligationType === 'implement' && isOpenReviewObligation(item)) ?? null
  );
}

/**
 * The challenges the NEXT independent reviewer MUST classify
 * (`resolved`/`still_failing`/`not_verified`): challenges that are OPEN across
 * the lifecycle AND for which the author HAS recorded a valid resolution against
 * the current implementation digest.
 *
 * #747: an author resolution binds the challenge to new evidence but does NOT
 * close it — closure authority belongs to the next reviewer. These ids are
 * therefore the ones that require an independent verdict, NOT ids to drop.
 */
export function computeTargetedResolutionChallengeIds(state: SessionState): readonly string[] {
  return resolutionRequirements(state).targetedResolutionIds;
}

/**
 * Open challenges with NO valid author resolution for the current digest. #747
 * forbids acceptance while any such challenge remains unaddressed: the author
 * must first record a resolution (bound to the current implementation digest and
 * a passing validation attempt) before an independent reviewer can close it. The
 * findings-consistency gate fails acceptance closed while this set is non-empty.
 */
export function computeUnaddressedPriorFailIds(state: SessionState): readonly string[] {
  return resolutionRequirements(state).unaddressedPriorFailIds;
}

/**
 * Reopen an implementation review that was blocked because the reviewer
 * accepted while a prior failing challenge had no author resolution.
 *
 * The block is recoverable by definition: the author records the missing
 * resolution, then a fresh reviewer must independently close the challenge.
 * Reopening mints exactly one durable re-arm attempt for the blocked obligation
 * and clears the capacity lock, so the next dispatch is authorized in the same
 * turn. Any other capacity code, an ambiguous spent lineage, or still-missing
 * resolutions leaves the blocked state untouched.
 */
export function reopenReviewAfterAuthorResolution(state: SessionState, now: string): SessionState {
  const assurance = ensureReviewAssurance(state.reviewAssurance);
  const lock = assurance.capacityLock;
  if (!lock || lock.code !== 'SUBAGENT_PRIOR_CHALLENGE_UNRESOLVED') return state;
  const obligation = assurance.obligations.find((item) => item.obligationId === lock.obligationId);
  if (!obligation || obligation.obligationType !== 'implement' || obligation.status !== 'blocked')
    return state;
  if (computeUnaddressedPriorFailIds(state).length > 0) return state;
  // An earlier retryable capture/rearm may have left historical stale attempts.
  // Only the one not superseded by a dispatch_rearm successor is the current
  // recovery candidate; counting history would dead-end the common A→B lineage.
  if (
    assurance.dispatches.some(
      (dispatch) =>
        dispatch.obligationId === obligation.obligationId &&
        dispatch.dispatchStatus === 'authorized',
    )
  )
    return state;
  const spent = unsupersededStaleAttempts(assurance, obligation.obligationId).filter((attempt) => {
    const dispatches = assurance.dispatches.filter(
      (dispatch) =>
        dispatch.attemptId === attempt.attemptId &&
        dispatch.obligationId === obligation.obligationId,
    );
    return dispatches.length === 1 && dispatches[0]?.dispatchStatus === 'outcome_unknown';
  });
  if (spent.length !== 1) return state;
  const spentAttempt = spent[0];
  if (!spentAttempt) return state;
  const pending = updateObligation(state, obligation.obligationId, (item) => ({
    ...item,
    status: 'pending',
    blockedCode: null,
  }));
  const rearm = buildInterruptedDispatchRearm(pending.reviewAssurance, spentAttempt, now);
  if (rearm.kind !== 'ok') return state;
  return {
    ...pending,
    reviewAssurance: { ...ensureReviewAssurance(rearm.assurance), capacityLock: null },
  };
}

function resolutionRequirements(state: SessionState) {
  return projectImplementationChallengeResolutionRequirements({
    findingsHistory: state.implReviewFindings,
    challengeResolutions: state.challengeResolutions,
    implementationDigest: state.implementation?.digest,
  });
}

/**
 * Whether `challengeId` is an OPEN implementation challenge across the lifecycle
 * (failing origin, latest independent verdict not `resolved`). Used by the
 * resolution-recording boundary so an author can re-resolve a challenge that a
 * later reviewer marked `still_failing`/`not_verified`, even though the original
 * `implementation_challenge` object is no longer in the latest `challenges[]`.
 */
export function isOpenImplementationChallenge(state: SessionState, challengeId: string): boolean {
  return projectOpenImplementationChallengeIds(state.implReviewFindings).includes(challengeId);
}

export function resolveImplementationFindings(
  input: ImplementRuntime,
  iteration: number,
  planVersion: number,
) {
  const pendingObligation = findOpenImplObligation(input.state);
  const challengeContract = buildReviewChallengeContract(input.state, pendingObligation);
  const resolved = resolveStructuredEffectiveFindings({
    pendingObligation,
    expected: { obligationType: 'implement', iteration, planVersion },
    input: {
      reviewerUnavailable: input.args.reviewerUnavailable,
      verdict: input.args.reviewVerdict,
    },
    state: {
      assurance: input.state.reviewAssurance,
      sessionId: input.context.sessionID,
      unresolvedImplementationChallengeIds: computeTargetedResolutionChallengeIds(input.state),
      unaddressedPriorFailIds: computeUnaddressedPriorFailIds(input.state),
      allowedChallengeEvidenceRefs: challengeContract?.evidenceRefs,
      previouslyUsedChallengeIds: collectPreviouslyUsedChallengeIds(input.state),
    },
  });
  return { pendingObligation, resolved };
}

export function validateEffectiveFindings(
  findings: ReviewFindings,
  submittedVerdict: LoopVerdict,
  obligationId: string,
): string | null {
  if (findings.overallVerdict === 'unable_to_review') {
    return formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', {
      obligationId,
      ...unableReviewDiagnostics(findings),
    });
  }
  if (findings.overallVerdict !== submittedVerdict) {
    return formatBlocked('SUBAGENT_FINDINGS_VERDICT_MISMATCH', {
      reviewVerdict: submittedVerdict,
      overallVerdict: findings.overallVerdict,
    });
  }
  return null;
}

export function appendImplReviewState(input: {
  runtime: ImplementRuntime;
  iteration: number;
  planVersion: number;
  effectiveFindings: ReviewFindings;
  evidenceInvocationId: string;
  obligationToConsume?: ReturnType<typeof findOpenImplObligation>;
}) {
  const {
    runtime,
    iteration,
    planVersion,
    effectiveFindings,
    evidenceInvocationId,
    obligationToConsume,
  } = input;
  const implementation = runtime.state.implementation;
  if (!implementation) {
    throw new IntegrationInvariantError(
      'IMPLEMENTATION_EVIDENCE_REQUIRED',
      'implementation review persistence requires implementation evidence',
    );
  }
  const assuranceBase = ensureReviewAssurance(runtime.state.reviewAssurance);
  const strictObligation = findLatestObligation(
    assuranceBase.obligations,
    'implement',
    iteration,
    planVersion,
  );
  const consumedObligation = obligationToConsume ?? strictObligation;
  const consumedAssurance = consumeReviewObligation(
    assuranceBase,
    consumedObligation,
    runtime.ctx.now(),
    evidenceInvocationId,
  );
  const existingFindings = runtime.state.implReviewFindings;
  const newReviewFindings = [...existingFindings, normalizeHostFindings(effectiveFindings)];
  const reviewedState: SessionState = {
    ...runtime.state,
    implReview: {
      iteration,
      reviewCycle: runtime.state.reviewCycles.implementation,
      maxIterations: runtime.maxImplementationReviewIterations,
      prevDigest: implementation.digest,
      currDigest: implementation.digest,
      revisionDelta: 'none',
      verdict: runtime.args.reviewVerdict as LoopVerdict,
      executedAt: runtime.ctx.now(),
    },
    implReviewFindings: newReviewFindings,
    reviewAssurance: {
      ...consumedAssurance,
    },
    error: null,
  };
  return { reviewedState, newReviewFindings };
}

export function addLatestImplementationReview(
  response: Record<string, unknown>,
  reviewFindings: ReviewFindings[],
): void {
  if (reviewFindings.length > 0) {
    response.latestImplementationReview = buildLatestImplementationReviewSummary(reviewFindings);
  }
}

/** Implementation digest of the revision a review decision is recorded against. */
export function requireImplementationDigest(state: SessionState): string {
  const digest = state.implementation?.digest;
  if (digest === undefined) {
    throw new IntegrationInvariantError(
      'IMPLEMENTATION_EVIDENCE_REQUIRED',
      'recording an implementation review decision requires implementation evidence',
    );
  }
  return digest;
}

export type ResolvedStructuredFindings = Extract<
  ReturnType<typeof resolveStructuredEffectiveFindings>,
  { readonly kind: 'resolved' }
>;
