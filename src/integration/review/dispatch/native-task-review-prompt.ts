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
import {
  verifyFrozenMaterialForObligation,
  type FrozenMaterialVerificationResult,
  type FrozenReviewerContext,
} from '../../../state/review-continuation.js';
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
import {
  ADMITTED_SUBJECT_ANCHOR_KIND,
  type AdmittedSubjectAnchorKind,
} from '../../../state/evidence-review-subject.js';
import {
  buildReviewChallengeContract,
  type ReviewerChallengePromptContract,
} from '../obligations/challenge-contract.js';
import {
  buildReviewerProofContext,
  type ReviewerProofGraphAuthorities,
} from '../context/proof-context.js';
import type { PersistedState } from './native-task-review-types.js';
import {
  buildReviewerEvidenceDossier,
  MAX_CANONICAL_TASK_PROMPT_UTF8_BYTES,
} from '../context/reviewer-evidence-dossier.js';

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

/** Only plan frozen material already embeds the claim declarations section. */
function keepsDeclarationPreview(obligation: ReviewObligation): boolean {
  return obligation.obligationType !== 'plan';
}

/** The relation grammar renders only the anchor kind the review scope admits. */
function admittedAnchorKindOf(
  obligation: ReviewObligation,
): AdmittedSubjectAnchorKind | null | undefined {
  const scope = obligation.reviewSubjectScope;
  return scope !== undefined ? ADMITTED_SUBJECT_ANCHOR_KIND[scope.kind] : undefined;
}

/** Frozen reviewer context: the verified context or the raw frozen material. */
function frozenReviewerContextOf(
  material: Extract<FrozenMaterialVerificationResult, { readonly kind: 'ok' }>,
  obligation: ReviewObligation,
): FrozenReviewerContext | undefined {
  return (
    material.context ??
    (obligation.reviewMaterial ? { reviewMaterial: obligation.reviewMaterial } : undefined)
  );
}

function artifactScopeOf(
  obligation: ReviewObligation,
): Extract<ReviewObligation['reviewSubjectScope'], { readonly kind: 'artifact' }> | undefined {
  return obligation.reviewSubjectScope?.kind === 'artifact'
    ? obligation.reviewSubjectScope
    : undefined;
}

// eslint-disable-next-line max-params, max-lines-per-function, complexity -- prompt composition has one fail-closed boundary.
export function canonicalTaskPrompt(
  state: PersistedState,
  obligation: ReviewObligation,
  attempt: ReviewAttempt,
  proofGraphAuthorities: ReviewerProofGraphAuthorities,
  retryDiagnostics?: readonly PendingReviewRetryDiagnostic[],
  contextMode: 'baseline' | 'dossier' = 'baseline',
): string {
  const material = verifyFrozenMaterialForObligation(obligation, obligation.reviewMaterial);
  if (material.kind === 'blocked') {
    throw buildEnforcementError(material.code, material.reason);
  }
  const frozenReviewerContext = frozenReviewerContextOf(material, obligation);
  const artifactScope = artifactScopeOf(obligation);
  const observationRevisions = resolveObservationRevisions(obligation);
  const challengeContract = buildReviewChallengeContract(state, obligation);
  const advisoryResolutions = advisoryResolutionBindings(
    state,
    obligation,
    resolutionTargetIdsOf(challengeContract),
  );
  const admittedSubjectAnchorKind = admittedAnchorKindOf(obligation);
  const evidenceDossier =
    contextMode === 'dossier'
      ? buildReviewerEvidenceDossier({
          state,
          obligation,
          attempt,
          challenge: {
            requiredChallengeCount: challengeContract?.requiredChallengeCount ?? 0,
            ...(challengeContract?.requiredChallengeKind !== undefined
              ? { requiredChallengeKind: challengeContract.requiredChallengeKind }
              : {}),
            offeredEvidenceRefCount: challengeContract?.evidenceRefs?.length ?? 0,
            resolutionTargetCount: challengeContract?.resolutionTargets?.length ?? 0,
          },
        })
      : undefined;
  if (evidenceDossier?.kind === 'blocked') {
    throw buildEnforcementError(evidenceDossier.code, evidenceDossier.reason);
  }
  const prompt = renderReviewerTaskPrompt({
    iteration: obligation.iteration,
    planVersion: obligation.planVersion,
    obligationId: obligation.obligationId,
    mandateDigest: obligation.mandateDigest,
    criteriaVersion: obligation.criteriaVersion,
    subjectLabel: subjectLabel(obligation.obligationType),
    reviewType: reviewerPromptTypeForTask(obligation.obligationType),
    repositoryReview: observationRevisions.length > 0,
    challengeContract: challengeContract ?? undefined,
    proofContext: buildReviewerProofContext(state, proofGraphAuthorities, {
      includeDeclarationPreview: keepsDeclarationPreview(obligation),
    }),
    ...(advisoryResolutions.length > 0 ? { challengeResolutions: advisoryResolutions } : {}),
    ...(retryDiagnostics !== undefined && retryDiagnostics.length > 0 ? { retryDiagnostics } : {}),
    ...(admittedSubjectAnchorKind !== undefined ? { admittedSubjectAnchorKind } : {}),
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
    ...(contextMode === 'dossier' ? { contextMode: 'dossier' as const } : {}),
    ...(evidenceDossier?.kind === 'ok' ? { evidenceDossier: evidenceDossier.text } : {}),
  });
  if (
    contextMode === 'dossier' &&
    Buffer.byteLength(prompt, 'utf8') > MAX_CANONICAL_TASK_PROMPT_UTF8_BYTES
  ) {
    throw buildEnforcementError(
      'REVIEW_DOSSIER_BUDGET_EXCEEDED',
      `The canonical reviewer prompt is ${Buffer.byteLength(prompt, 'utf8')} UTF-8 bytes; the experimental limit is ${MAX_CANONICAL_TASK_PROMPT_UTF8_BYTES}.`,
    );
  }
  return prompt;
}
