/**
 * @module integration/review/challenge-contract
 * @description Host-authored challenge contract projection for structured review.
 */

import type { ReviewObligation } from '../../state/evidence.js';
import { REVIEW_CHALLENGE_OUTCOMES } from '../../state/evidence.js';
import { indexMarkdownSections } from '../../shared/markdown-sections.js';
import type { SessionState } from '../../state/schema.js';

export interface ReviewerChallengePromptContract {
  readonly requiredChallengeCount: number;
  readonly requiredChallengeKind?:
    'design_challenge' | 'implementation_challenge' | 'content_challenge';
  readonly evidenceRefs?: readonly Record<string, unknown>[];
}

export function renderReviewChallengeContract(
  contract: ReviewerChallengePromptContract | undefined,
  obligationId: string,
): string[] {
  if (!contract || contract.requiredChallengeCount === 0) {
    return ['- Challenge requirement: exactly 0 challenges are required for this review.'];
  }
  const evidenceRefs = contract.evidenceRefs ?? [];
  const kind = contract.requiredChallengeKind;
  const challenge = {
    clientReference: 'c1',
    obligationId,
    scenario: '<falsification scenario>',
    claim: '<reviewed claim>',
    locations: ['<concrete file or artifact location>'],
    kind,
    evidenceRefs,
  };
  return [
    `- Challenge contract: return exactly ${contract.requiredChallengeCount} ${kind} challenge(s).`,
    '- When provided, clientReference MUST be fresh and unique (e.g. "c1", "c2"); use the exact obligationId below.',
    '- Copy evidenceRefs exactly from the contract below. Do not invent or alter a digest, sectionPath, or attemptId.',
    '- Omit challengeResolutionVerdicts unless the Task prompt explicitly supplies prior challenge IDs to resolve.',
    '- Required field: outcome. Select it yourself only after completing the falsification attempt; there is no default outcome.',
    ...(kind
      ? [
          `- Allowed ${kind} outcome values (exact strings, no others): ${REVIEW_CHALLENGE_OUTCOMES[
            kind
          ]
            .map((value) => `"${value}"`)
            .join(' | ')}.`,
        ]
      : []),
    `- Required challenge object shape: ${JSON.stringify(challenge)}`,
    ...(evidenceRefs.length === 0
      ? ['- No usable evidence reference was supplied; return unable_to_review.']
      : []),
  ];
}

function artifactEvidence(
  kind: 'plan' | 'adr',
  digest: string,
  markdown: string,
): Record<string, unknown>[] {
  return indexMarkdownSections(markdown).map((section) => ({
    kind: 'plan_adr_section',
    artifactKind: kind,
    artifactDigest: digest,
    sectionPath: section.sectionPath,
    excerptDigest: section.excerptDigest,
  }));
}

function evidenceFor(
  state: SessionState,
  obligation: ReviewObligation,
): Record<string, unknown>[] | undefined {
  if (obligation.obligationType === 'plan') {
    const scope = obligation.reviewSubjectScope;
    return scope.kind === 'artifact' && scope.artifact.kind === 'plan'
      ? artifactEvidence('plan', scope.artifact.digest, obligation.reviewMaterial.content)
      : undefined;
  }
  if (obligation.obligationType === 'architecture') {
    const scope = obligation.reviewSubjectScope;
    return scope.kind === 'artifact' && scope.artifact.kind === 'adr'
      ? artifactEvidence('adr', scope.artifact.digest, obligation.reviewMaterial.content)
      : undefined;
  }
  if (obligation.obligationType === 'implement') {
    const scope = obligation.reviewSubjectScope;
    if (scope.kind !== 'implementation') return undefined;
    const digest = scope.implementationDigest;
    if (digest !== obligation.subjectDigest) return undefined;
    const successful = state.validationAttempts.filter(
      (attempt) =>
        attempt.scope === 'implementation' &&
        attempt.implementationDigest === digest &&
        attempt.result.passed,
    );
    return successful.length === 0
      ? undefined
      : [
          { kind: 'implementation', implementationDigest: digest },
          ...successful.map((attempt) => ({
            kind: 'validation_attempt',
            attemptId: attempt.attemptId,
          })),
        ];
  }
  return contentEvidenceFor(obligation);
}

/**
 * Peer review subjects bind content challenges to the FROZEN review
 * subject digest — never `metadata.fingerprint` (workspace context) and never
 * mutable runtime state. Divergence between the obligation subject digest, the
 * frozen subject, and the frozen scope fails closed.
 */
function contentEvidenceFor(obligation: ReviewObligation): Record<string, unknown>[] | undefined {
  const scope = obligation.reviewSubjectScope;
  const subjectBound =
    scope.kind === 'content'
      ? scope.subjectDigest === obligation.subjectDigest
      : scope.kind === 'repository_change' &&
        obligation.reviewSubject?.subjectDigest === obligation.subjectDigest;
  return subjectBound ? [{ kind: 'content', digest: obligation.subjectDigest }] : undefined;
}

export function buildReviewChallengeContract(
  state: SessionState,
  obligation: ReviewObligation | null,
): ReviewerChallengePromptContract | undefined {
  if (!obligation) return undefined;
  const contract: ReviewerChallengePromptContract = {
    requiredChallengeCount: obligation.requiredChallengeCount,
    requiredChallengeKind: obligation.requiredChallengeKind,
  };
  if (obligation.requiredChallengeCount === 0) return contract;
  const evidenceRefs = evidenceFor(state, obligation);
  return evidenceRefs ? { ...contract, evidenceRefs } : contract;
}
