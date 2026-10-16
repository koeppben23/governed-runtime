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
import {
  renderReviewerTaskPrompt,
  type AdvisoryChallengeResolution,
} from '../prompting/prompt-builders.js';
import type { PendingReviewRetryDiagnostic } from '../types.js';
import { reviewerPromptTypeForTask } from './reviewer-task-type.js';
import { renderArtifactAnchorContract } from '../context/frozen-reviewer-context.js';
import { buildImplementationAnchorContractLines } from '../evidence/anchor-contract-lines.js';
import { resolveRepositoryObservationAccess } from '../observations/observation-access.js';
import { resolveObservationRevisions } from '../../../state/evidence-review-authority.js';
import { ADMITTED_SUBJECT_ANCHOR_KIND } from '../../../state/evidence-review-subject.js';
import {
  buildReviewChallengeContract,
  type ReviewerChallengePromptContract,
} from '../obligations/challenge-contract.js';
import {
  buildReviewerProofContext,
  type ReviewerProofGraphAuthorities,
} from '../context/proof-context.js';
import type { PersistedState } from './native-task-review-types.js';

function resolutionTargetIdsOf(
  contract: ReviewerChallengePromptContract | undefined,
): ReadonlySet<string> {
  return new Set(contract?.resolutionTargets?.map((target) => target.challengeId) ?? []);
}

/**
 * The author's advisory resolution bindings are rendered only for the exact
 * targets the challenge contract requires verdicts for. They are provenance
 * hints, not acceptance evidence (the previous reviewer output is untrusted
 * data).
 */
function advisoryResolutionBindings(
  state: PersistedState,
  obligation: ReviewObligation,
  resolutionTargetIds: ReadonlySet<string>,
): readonly AdvisoryChallengeResolution[] {
  if (obligation.obligationType !== 'implement') return [];
  return state.challengeResolutions
    .filter((resolution) => resolutionTargetIds.has(resolution.challengeId))
    .map((resolution) => ({
      challengeId: resolution.challengeId,
      implementationDigest: resolution.implementationDigest,
      validationAttemptIds: [...resolution.validationAttemptIds],
      resolvedAt: resolution.resolvedAt,
    }));
}

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
  retryDiagnostics?: readonly PendingReviewRetryDiagnostic[],
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
  const challengeContract = buildReviewChallengeContract(state, obligation);
  const advisoryResolutions = advisoryResolutionBindings(
    state,
    obligation,
    resolutionTargetIdsOf(challengeContract),
  );
  const reviewSubjectScope = obligation.reviewSubjectScope;
  return renderReviewerTaskPrompt({
    iteration: obligation.iteration,
    planVersion: obligation.planVersion,
    obligationId: obligation.obligationId,
    mandateDigest: obligation.mandateDigest,
    criteriaVersion: obligation.criteriaVersion,
    subjectLabel: subjectLabel(obligation.obligationType),
    reviewType: reviewerPromptTypeForTask(obligation.obligationType),
    repositoryReview: observationRevisions.length > 0,
    challengeContract: challengeContract ?? undefined,
    proofContext: buildReviewerProofContext(state, proofGraphAuthorities),
    ...(advisoryResolutions.length > 0 ? { challengeResolutions: advisoryResolutions } : {}),
    ...(retryDiagnostics !== undefined && retryDiagnostics.length > 0 ? { retryDiagnostics } : {}),
    // The relation grammar renders only the subject-anchor kind this review
    // scope admits, so its example can never contradict the scope binder.
    ...(reviewSubjectScope !== undefined
      ? { admittedSubjectAnchorKind: ADMITTED_SUBJECT_ANCHOR_KIND[reviewSubjectScope.kind] }
      : {}),
    frozenReviewerContext,
    artifactAnchorContract: artifactScope ? renderArtifactAnchorContract(artifactScope) : undefined,
    // Implementation reviews receive the SAME host-enforced anchor contract the
    // binder validates (kind "implementation" + exact digest); the evidence rule
    // derives from the authority enforcement uses.
    implementationAnchorContract: buildImplementationAnchorContractLines(
      obligation,
      resolveRepositoryObservationAccess(obligation, attempt),
    ),
    repositoryDiscoverySnapshot:
      attempt.repositoryDiscovery.kind === 'repository'
        ? attempt.repositoryDiscovery.snapshot
        : null,
    observationCapability: attempt.observationCapability,
    observationRevisions,
  });
}
