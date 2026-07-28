import type { ReviewFindings } from '../../state/evidence.js';
import type { SessionState } from '../../state/schema.js';

/** Collect challenge identities already persisted in this session's review history. */
export function collectPreviouslyUsedChallengeIds(state: SessionState): readonly string[] {
  const ids = new Set<string>();
  const histories: readonly (readonly ReviewFindings[] | undefined)[] = [
    state.plan?.reviewFindings,
    state.architecture?.reviewFindings,
    state.implReviewFindings,
  ];
  for (const findingsHistory of histories) {
    for (const findings of findingsHistory ?? []) {
      for (const challenge of findings.challenges ?? []) {
        ids.add(challenge.challengeId);
      }
    }
  }
  return [...ids];
}
