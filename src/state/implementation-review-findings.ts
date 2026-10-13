import type { ReviewFindings } from './evidence.js';

export type ChallengeResolutionBinding = {
  readonly challengeId: string;
  readonly implementationDigest: string;
};

/**
 * Canonical lifecycle projection of implementation-challenge open-state (#747).
 * A challenge has a failing origin when an `implementation_challenge` reports
 * `fail` or `not_verified`; only a later independent `resolved` verdict closes it.
 * Append order determines the latest verdict because the schema has no explicit
 * cross-iteration challenge binding.
 */
export function projectOpenImplementationChallengeIds(
  findingsHistory: readonly ReviewFindings[] | undefined,
): readonly string[] {
  const failingOrigins = new Set<string>();
  const latestVerdicts = new Map<string, string>();
  for (const findings of findingsHistory ?? []) {
    for (const challenge of findings.challenges) {
      if (
        challenge.kind === 'implementation_challenge' &&
        (challenge.outcome === 'fail' || challenge.outcome === 'not_verified')
      ) {
        failingOrigins.add(challenge.challengeId);
      }
    }
    for (const verdict of findings.challengeResolutionVerdicts ?? []) {
      if (findings.overallVerdict !== 'unable_to_review' || verdict.verdict !== 'resolved') {
        latestVerdicts.set(verdict.challengeId, verdict.verdict);
      }
    }
  }
  return [...failingOrigins].filter((id) => latestVerdicts.get(id) !== 'resolved');
}

/**
 * Failing-origin details of every implementation challenge ever recorded in the
 * session history, keyed by first failing appearance. The scenario/claim text is
 * reviewer-authored data retained for the next reviewer's independent judgment;
 * it never carries verifier authority by itself.
 */
export interface ImplementationChallengeDetail {
  readonly challengeId: string;
  readonly scenario: string;
  readonly claim: string;
  readonly locations: readonly string[];
  readonly originOutcome: 'fail' | 'not_verified';
}

export function projectImplementationChallengeDetails(
  findingsHistory: readonly ReviewFindings[] | undefined,
): readonly ImplementationChallengeDetail[] {
  const details = new Map<string, ImplementationChallengeDetail>();
  for (const findings of findingsHistory ?? []) {
    for (const challenge of findings.challenges) {
      if (
        challenge.kind !== 'implementation_challenge' ||
        (challenge.outcome !== 'fail' && challenge.outcome !== 'not_verified') ||
        details.has(challenge.challengeId)
      ) {
        continue;
      }
      details.set(challenge.challengeId, {
        challengeId: challenge.challengeId,
        scenario: challenge.scenario,
        claim: challenge.claim,
        locations: [...challenge.locations],
        originOutcome: challenge.outcome,
      });
    }
  }
  return [...details.values()];
}

/**
 * The two disjoint sets every boundary of the #747 repair loop must agree on:
 *
 * - `targetedResolutionIds`: open challenges the author addressed with a valid
 *   resolution for the current digest. The next independent reviewer MUST judge
 *   each with exactly one resolution verdict; an author resolution never closes
 *   a challenge.
 * - `unaddressedPriorFailIds`: open challenges with no current-digest author
 *   resolution. Acceptance fails closed while any such challenge remains.
 *
 * Single source consumed by the native reviewer prompt construction, the native
 * capture validation, and the tool consumption boundary, so the reviewer never
 * receives a different contract than the one enforced when its findings arrive.
 */
export interface ImplementationChallengeResolutionRequirements {
  readonly targetedResolutionIds: readonly string[];
  readonly unaddressedPriorFailIds: readonly string[];
}

export function projectImplementationChallengeResolutionRequirements(input: {
  readonly findingsHistory: readonly ReviewFindings[] | undefined;
  readonly challengeResolutions: readonly ChallengeResolutionBinding[];
  readonly implementationDigest: string | undefined;
}): ImplementationChallengeResolutionRequirements {
  const resolvedForCurrentDigest = new Set(
    input.challengeResolutions
      .filter((resolution) => resolution.implementationDigest === input.implementationDigest)
      .map((resolution) => resolution.challengeId),
  );
  const open = projectOpenImplementationChallengeIds(input.findingsHistory);
  return {
    targetedResolutionIds: open.filter((id) => resolvedForCurrentDigest.has(id)),
    unaddressedPriorFailIds: open.filter((id) => !resolvedForCurrentDigest.has(id)),
  };
}

/**
 * Open implementation challenges without author evidence bound to this exact
 * implementation digest. Author evidence remains advisory; it only makes a
 * challenge eligible for the next independent reviewer verdict.
 */
export function projectUnaddressedImplementationChallengeIds(
  findingsHistory: readonly ReviewFindings[] | undefined,
  challengeResolutions: readonly ChallengeResolutionBinding[],
  implementationDigest: string | undefined,
): readonly string[] {
  return projectImplementationChallengeResolutionRequirements({
    findingsHistory,
    challengeResolutions,
    implementationDigest,
  }).unaddressedPriorFailIds;
}
