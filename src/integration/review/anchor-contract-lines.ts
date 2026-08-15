/**
 * @module integration/review/anchor-contract-lines
 * @description Host-enforced subject anchor contract lines rendered into the
 *              reviewer prompt, keyed by obligation type and subject scope.
 *
 * Extracted from host-task-policy.ts along the anchor-contract boundary to
 * keep both modules within the file-size budget. Pure renderers only.
 *
 * The implementation contract's evidence rule derives from the SAME authority
 * enforcement uses (`resolveRepositoryObservationAccess`): with an
 * authoritative attempt-bound capability, repository evidenceLocations remain
 * admissible; without it they MUST be empty. Implementation scope and
 * repository observation are orthogonal — no scope-kind heuristic decides
 * evidence availability.
 *
 * @version v1
 */

import type { ReviewObligation } from '../../state/evidence.js';
import { renderArtifactAnchorContract } from './frozen-reviewer-context.js';
import type { RepositoryObservationAccess } from './observation-access.js';

export function buildArtifactAnchorContractLines(
  obligation: ReviewObligation | null,
): readonly string[] {
  if (
    !obligation ||
    (obligation.obligationType !== 'plan' && obligation.obligationType !== 'architecture') ||
    obligation.reviewSubjectScope?.kind !== 'artifact'
  ) {
    return [];
  }
  return renderArtifactAnchorContract(obligation.reviewSubjectScope);
}

export function buildImplementationAnchorContractLines(
  obligation: ReviewObligation | null,
  observationAccess: RepositoryObservationAccess | null,
): readonly string[] {
  if (
    !obligation ||
    obligation.obligationType !== 'implement' ||
    obligation.reviewSubjectScope?.kind !== 'implementation'
  ) {
    return [];
  }
  const digest = obligation.reviewSubjectScope.implementationDigest;
  const evidenceRule =
    observationAccess?.available === true
      ? 'evidenceLocations are admissible ONLY when their frozen bytes were obtained through flowguard_observe_repository during this review attempt.'
      : 'evidenceLocations MUST be []. Do not convert working-tree reads into repository evidence.';
  return [
    '## Implementation Subject Anchor Contract (host-enforced)',
    'The review subject is the recorded implementation. The host binder enforces this exact contract:',
    '- subjectAnchors MUST use kind "implementation"',
    `- implementationDigest MUST be "${digest}"`,
    '- Repository paths are evidenceLocations only — never subjectAnchors.',
    evidenceRule,
  ];
}
