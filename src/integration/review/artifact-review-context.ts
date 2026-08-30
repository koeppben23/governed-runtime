import type { SessionState } from '../../state/schema.js';

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
