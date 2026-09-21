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

import { getAdapterLogger } from '../../../logging/adapter-logger.js';
import type { SessionState } from '../../../state/schema.js';
import type { LoopVerdict, ReviewFindings } from '../../../state/evidence.js';
import { IntegrationInvariantError } from '../../errors.js';
import { formatBlocked } from '../../blocked-result.js';

import { resolveStructuredEffectiveFindings } from '../../review/validation/review-validation.js';
import { collectPreviouslyUsedChallengeIds } from '../../review/obligations/challenge-history.js';
import {
  consumeReviewObligation,
  ensureReviewAssurance,
  findLatestObligation,
} from '../../review/obligations/assurance.js';
import { buildLatestImplementationReviewSummary } from './review-summary.js';
import { buildReviewChallengeContract } from '../../review/obligations/challenge-contract.js';
import { normalizeHostFindings, type ImplementRuntime } from './implement-shared.js';
import {
  projectOpenImplementationChallengeIds,
  projectUnaddressedImplementationChallengeIds,
} from '../../../state/implementation-review-findings.js';

export function findPendingImplObligation(state: SessionState) {
  const assuranceBase = ensureReviewAssurance(state.reviewAssurance);
  return (
    [...assuranceBase.obligations]
      .reverse()
      .find(
        (item) =>
          item.obligationType === 'implement' &&
          item.status !== 'consumed' &&
          item.consumedAt == null,
      ) ?? null
  );
}

/** Challenge ids the author has recorded a resolution for against the CURRENT digest. */
function resolvedForCurrentDigestIds(state: SessionState): ReadonlySet<string> {
  return new Set(
    state.challengeResolutions
      .filter((resolution) => resolution.implementationDigest === state.implementation?.digest)
      .map((resolution) => resolution.challengeId),
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
  const open = projectOpenImplementationChallengeIds(state.implReviewFindings);
  const resolvedIds = resolvedForCurrentDigestIds(state);
  return open.filter((id) => resolvedIds.has(id));
}

/**
 * Open challenges with NO valid author resolution for the current digest. #747
 * forbids acceptance while any such challenge remains unaddressed: the author
 * must first record a resolution (bound to the current implementation digest and
 * a passing validation attempt) before an independent reviewer can close it. The
 * findings-consistency gate fails acceptance closed while this set is non-empty.
 */
export function computeUnaddressedPriorFailIds(state: SessionState): readonly string[] {
  return projectUnaddressedImplementationChallengeIds(
    state.implReviewFindings,
    state.challengeResolutions,
    state.implementation?.digest,
  );
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
  const pendingObligation = findPendingImplObligation(input.state);
  const challengeContract = buildReviewChallengeContract(input.state, pendingObligation);
  const resolved = resolveStructuredEffectiveFindings({
    pendingObligation,
    logger: getAdapterLogger(),
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
    return formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', { obligationId });
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
  obligationToConsume?: ReturnType<typeof findPendingImplObligation>;
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
  const existingFindings = runtime.state.implReviewFindings ?? [];
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
    implReviewFindings: newReviewFindings.length > 0 ? newReviewFindings : undefined,
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
