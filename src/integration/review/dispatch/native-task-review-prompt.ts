/**
 * @module integration/review/native-task-review-prompt
 * @description Canonical reviewer Task prompt construction for the native
 *              reviewer transport.
 *
 * The prompt is host-owned: it renders the frozen material, the reviewer
 * criteria, the challenge contract, Discovery context, and the bounded
 * retry diagnostics of a rejected prior capture. The parent agent's Task
 * arguments are replaced with this result at the before-hook.
 *
 * @version v1
 */

import { buildEnforcementError } from '../../blocked-result.js';
import type {
  ReviewAttempt,
  ReviewObligation,
  ReviewObligationType,
} from '../../../state/evidence.js';
import { verifyFrozenMaterialForObligation } from '../../../state/review-continuation.js';
import { renderReviewerTaskPrompt } from '../prompting/prompt-builders.js';
import { reviewerPromptTypeForTask } from './reviewer-task-type.js';
import { renderArtifactAnchorContract } from '../context/frozen-reviewer-context.js';
import { resolveObservationRevisions } from '../../../state/evidence-review-authority.js';
import { buildReviewChallengeContract } from '../obligations/challenge-contract.js';
import {
  buildReviewerProofContext,
  type ReviewerProofGraphAuthorities,
} from '../context/proof-context.js';
import type { PersistedState } from './native-task-review-types.js';

function subjectLabel(type: ReviewObligationType): string {
  switch (type) {
    case 'plan':
      return 'the frozen plan and ticket context';
    case 'architecture':
      return 'the frozen architecture decision and ticket context';
    case 'implement':
      return 'the frozen implementation change and approved plan context';
    case 'review':
      return 'the frozen peer-review content';
  }
}

export function canonicalTaskPrompt(
  state: PersistedState,
  obligation: ReviewObligation,
  attempt: ReviewAttempt,
  proofGraphAuthorities: ReviewerProofGraphAuthorities,
  retryDiagnostics?: readonly string[],
): string {
  const material = verifyFrozenMaterialForObligation(obligation, obligation.reviewMaterial);
  if (material.kind === 'blocked') {
    throw buildEnforcementError(material.code, material.reason);
  }
  const frozenReviewerContext =
    material.context ??
    (obligation.reviewMaterial ? { reviewMaterial: obligation.reviewMaterial } : undefined);
  const artifactScope =
    obligation.reviewSubjectScope?.kind === 'artifact' ? obligation.reviewSubjectScope : undefined;
  const observationRevisions = resolveObservationRevisions(obligation);
  return renderReviewerTaskPrompt({
    iteration: obligation.iteration,
    planVersion: obligation.planVersion,
    obligationId: obligation.obligationId,
    mandateDigest: obligation.mandateDigest,
    criteriaVersion: obligation.criteriaVersion,
    subjectLabel: subjectLabel(obligation.obligationType),
    reviewType: reviewerPromptTypeForTask(obligation.obligationType),
    repositoryReview: observationRevisions.length > 0,
    challengeContract: buildReviewChallengeContract(state, obligation) ?? undefined,
    proofContext: buildReviewerProofContext(state, proofGraphAuthorities),
    ...(retryDiagnostics !== undefined && retryDiagnostics.length > 0
      ? { retrySchemaErrors: retryDiagnostics }
      : {}),
    frozenReviewerContext,
    artifactAnchorContract: artifactScope ? renderArtifactAnchorContract(artifactScope) : undefined,
    repositoryDiscoverySnapshot:
      attempt.repositoryDiscovery.kind === 'repository'
        ? attempt.repositoryDiscovery.snapshot
        : null,
    observationCapability: attempt.observationCapability,
    observationRevisions,
  });
}
