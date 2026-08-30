import type { SessionState } from '../../state/schema.js';
import type { AdvisoryChallengeResolution } from './prompt-builders.js';

/** Advisory artifact metadata supplied to host-task reviewers. */
export function buildArtifactContext(state: SessionState): readonly string[] {
  const implementation = state.implementation;
  return [
    '## Artifact Context (advisory)',
    JSON.stringify({
      planVersion: state.plan?.current.planVersion ?? null,
      changedFiles: implementation?.changedFiles ?? [],
      verificationAttemptCount: state.validationAttempts.filter(
        (attempt) =>
          attempt.scope === 'implementation' &&
          attempt.implementationDigest === implementation?.digest,
      ).length,
      reviewedRevisionCount: state.plan?.history.length ?? 0,
    }),
  ];
}

/**
 * Advisory author-recorded implementation challenge resolutions for the current
 * implementation digest, projected for the host-task reviewer prompt. Empty when
 * no implementation or no matching resolutions exist — the renderer then omits
 * the advisory section, mirroring the SDK path.
 */
export function buildHostTaskChallengeResolutions(
  state: SessionState,
): ReadonlyArray<AdvisoryChallengeResolution> {
  const digest = state.implementation?.digest;
  if (!digest) return [];
  return state.challengeResolutions
    .filter((resolution) => resolution.implementationDigest === digest)
    .map(({ challengeId, implementationDigest, validationAttemptIds, resolvedAt }) => ({
      challengeId,
      implementationDigest,
      validationAttemptIds,
      resolvedAt,
    }));
}
