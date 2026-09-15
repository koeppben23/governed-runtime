/**
 * @module integration/review/challenge-contract
 * @description Host-authored challenge contract projection for structured review.
 */

import type { SessionState } from '../../state/schema.js';
import type { ReviewObligation } from '../../state/evidence.js';
import { indexMarkdownSections } from '../../shared/markdown-sections.js';
import type { ReviewerChallengePromptContract } from './prompt-builders.js';

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
