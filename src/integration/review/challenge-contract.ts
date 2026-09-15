/**
 * @module integration/review/challenge-contract
 * @description Host-authored challenge contract projection for structured review.
 */

import type { SessionState } from '../../state/schema.js';
import type { ReviewObligation } from '../../state/evidence.js';
import { REVIEW_CHALLENGE_OUTCOMES } from '../../state/evidence.js';
import { indexMarkdownSections } from '../../shared/markdown-sections.js';

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
    const plan = state.plan?.current;
    return plan ? artifactEvidence('plan', plan.digest, plan.body) : undefined;
  }
  if (obligation.obligationType === 'architecture') {
    const adr = state.architecture;
    return adr ? artifactEvidence('adr', adr.digest, adr.adrText) : undefined;
  }
  if (obligation.obligationType === 'implement') {
    const digest = state.implementation?.digest;
    if (!digest) return undefined;
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
  const digest = obligation.metadata?.fingerprint;
  return typeof digest === 'string' ? [{ kind: 'content', digest }] : undefined;
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
