/**
 * @module integration/review/validation/challenge-consistency-input
 * @description Shared input projection for the canonical challenge consistency authority.
 */

import type { ReviewFindings, ReviewObligation } from '../../../state/evidence.js';
import type { ChallengeConsistencyInput } from '../enforcement/challenge-consistency.js';

export interface ChallengeConsistencyInputSource {
  readonly findings: ReviewFindings;
  readonly obligation: ReviewObligation | null;
  readonly challenges?: ReviewFindings['challenges'];
  readonly expectedObligationId?: string;
  readonly allowedEvidenceRefs?: readonly unknown[];
  readonly unresolvedImplementationChallengeIds?: readonly string[];
  readonly unaddressedPriorFailIds?: readonly string[];
  readonly previouslyUsedChallengeIds?: readonly string[];
}

/** Project findings and frozen obligation data into the challenge authority input. */
export function buildChallengeConsistencyInput(
  source: ChallengeConsistencyInputSource,
): ChallengeConsistencyInput {
  const { findings, obligation } = source;
  return {
    overallVerdict: findings.overallVerdict,
    requiredChallengeCount: obligation?.requiredChallengeCount ?? 0,
    requiredChallengeKind: obligation?.requiredChallengeKind ?? 'implementation_challenge',
    challenges: source.challenges ?? findings.challenges,
    ...(source.expectedObligationId !== undefined
      ? { expectedObligationId: source.expectedObligationId }
      : {}),
    ...(source.allowedEvidenceRefs !== undefined
      ? { allowedEvidenceRefs: source.allowedEvidenceRefs }
      : {}),
    ...(findings.challengeResolutionVerdicts !== undefined
      ? { resolutionVerdicts: findings.challengeResolutionVerdicts }
      : {}),
    ...(source.unresolvedImplementationChallengeIds !== undefined
      ? { unresolvedImplementationChallengeIds: source.unresolvedImplementationChallengeIds }
      : {}),
    ...(source.unaddressedPriorFailIds !== undefined
      ? { unaddressedPriorFailIds: source.unaddressedPriorFailIds }
      : {}),
    ...(source.previouslyUsedChallengeIds !== undefined
      ? { previouslyUsedChallengeIds: source.previouslyUsedChallengeIds }
      : {}),
  };
}
