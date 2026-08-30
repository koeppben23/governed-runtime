import type { ReviewFindings } from './evidence.js';

type ChallengeResolutionBinding = {
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
    for (const challenge of findings.challenges ?? []) {
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
 * Open implementation challenges without author evidence bound to this exact
 * implementation digest. Author evidence remains advisory; it only makes a
 * challenge eligible for the next independent reviewer verdict.
 */
export function projectUnaddressedImplementationChallengeIds(
  findingsHistory: readonly ReviewFindings[] | undefined,
  challengeResolutions: readonly ChallengeResolutionBinding[],
  implementationDigest: string | undefined,
): readonly string[] {
  const resolvedForCurrentDigest = new Set(
    challengeResolutions
      .filter((resolution) => resolution.implementationDigest === implementationDigest)
      .map((resolution) => resolution.challengeId),
  );
  return projectOpenImplementationChallengeIds(findingsHistory).filter(
    (id) => !resolvedForCurrentDigest.has(id),
  );
}
