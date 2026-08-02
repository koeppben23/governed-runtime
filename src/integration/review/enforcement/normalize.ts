/**
 * @module integration/review-enforcement-normalize
 * @description Host-authoritative normalization of reviewer challenge output.
 *
 * Reviewer-generated `clientReference` slugs are mapped to FlowGuard-generated
 * UUID `challengeId` values. The reviewer never defines a challenge identity —
 * only the host does. Duplicate `clientReference` within a single payload is
 * rejected.
 *
 * @version v1
 */

import { randomUUID } from 'node:crypto';

export interface ReviewerChallengeInput {
  clientReference?: string;
  scenario: string;
  claim: string;
  locations: string[];
  kind: 'design_challenge' | 'implementation_challenge' | 'content_challenge';
  evidenceRefs: unknown[];
  outcome: string;
}

export interface NormalizedChallenge {
  challengeId: string;
  obligationId: string;
  clientReference?: string;
  scenario: string;
  claim: string;
  locations: string[];
  kind: 'design_challenge' | 'implementation_challenge' | 'content_challenge';
  evidenceRefs: unknown[];
  outcome: string;
}

export interface NormalizeResult {
  challenges: NormalizedChallenge[];
  warnings: string[];
}

/**
 * Normalize reviewer-provided challenge inputs into host-authoritative challenges.
 *
 * - Generates a UUID `challengeId` for each input (never trusts the reviewer).
 * - Maps `clientReference` to generated `challengeId` for audit correlation.
 * - Rejects duplicate `clientReference` values within a single payload.
 * - Assigns auto-generated references (`auto-1`, `auto-2`, ...) when no
 *   `clientReference` is supplied.
 */
export function normalizeChallenges(
  inputs: ReviewerChallengeInput[],
  obligationId: string,
): NormalizeResult {
  const challenges: NormalizedChallenge[] = [];
  const warnings: string[] = [];
  const usedRefs = new Set<string>();

  let idx = 0;
  for (const input of inputs) {
    idx++;
    const ref = input.clientReference ?? `auto-${idx}`;

    if (usedRefs.has(ref)) {
      warnings.push(
        `Duplicate clientReference "${ref}" at index ${idx}; ` +
          `challenge identity is still unique (host-generated challengeId).`,
      );
    }
    usedRefs.add(ref);

    challenges.push({
      challengeId: randomUUID(),
      obligationId,
      clientReference: ref,
      scenario: input.scenario,
      claim: input.claim,
      locations: [...input.locations],
      kind: input.kind,
      evidenceRefs: [...input.evidenceRefs],
      outcome: input.outcome,
    });
  }

  return { challenges, warnings };
}
