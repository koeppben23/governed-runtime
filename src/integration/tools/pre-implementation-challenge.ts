/**
 * @module integration/tools/pre-implementation-challenge
 * @description Canonical challenge classification for pre-implementation obligations
 * that carry no diff of their own (architecture ADRs and plans).
 *
 * Shared by all four pre-implementation flows:
 *  - Architecture Mode A (`architecture-submit`): the initial ADR submission.
 *  - Architecture Mode B (`architecture-review`): the non-converged ADR revision
 *    loop that creates the next iteration's obligation.
 *  - Plan initial (`plan` submission): the initial plan submission.
 *  - Plan revision (`plan-response`): the non-converged plan revision loop that
 *    creates the next iteration's obligation.
 *
 * @version v2
 */

import type { SessionState } from '../../state/schema.js';
import { readDiscovery } from '../../adapters/persistence-discovery.js';
import { discoveryRiskPaths } from '../discovery-risk-paths.js';

/**
 * Resolve the challenge-path classification for a pre-implementation obligation
 * (architecture ADR or plan).
 *
 * A pre-implementation artifact carries no diff of its own, so branch/PR diff
 * evidence is not naturally available — the historical resolver returned
 * `unavailable` here and hard-blocked the entire flow whenever a `challengePolicy`
 * was active (team/team-ci/regulated). This derives the classification from canonical
 * session evidence instead and NEVER dead-ends:
 *
 *  - changedFiles = caller-provided `targetPaths` (author hint and, in the review
 *    loop, the prior obligation's recovered paths) ∪ the repository's detected risk
 *    surfaces (`discoveryRiskPaths`), a deterministic, persisted source. The
 *    challenge COUNT is then floored by the author's `claimedTaskClass` inside
 *    `createReviewObligation` (max(computed, claimed)), so these paths can only
 *    raise the requirement, never lower it.
 *  - When no evidence exists (no targetPaths, no detected surfaces), the set is
 *    empty → TRIVIAL → count 0. That is a genuine "no detected risk" signal, not a
 *    block. In enforced modes the separate risk gate still requires a claim before
 *    the tool runs.
 *
 * Fail-closed sequencing note: an absent `challengePolicy` is normalized to the
 * canonical matrix for team/team-ci/regulated at snapshot load (finding A2), so
 * the `not_required` short-circuit here only applies to solo (no challenge policy)
 * and never bypasses enforced-mode challenge coverage.
 */
export async function resolvePreImplementationChallengeClassification(
  state: SessionState,
  wsDir: string,
  subagentEnabled: boolean,
  targetPaths?: readonly string[],
): Promise<{ kind: 'not_required' } | { kind: 'available'; changedFiles: readonly string[] }> {
  if (!subagentEnabled) return { kind: 'not_required' };
  if (!state.policySnapshot?.challengePolicy) return { kind: 'not_required' };
  const discovery = await readDiscovery(wsDir);
  const changedFiles = [...new Set([...(targetPaths ?? []), ...discoveryRiskPaths(discovery)])];
  return { kind: 'available', changedFiles };
}
