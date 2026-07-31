/**
 * @module audit/proofgraph/mutation-binder
 * @description Bind recorded mutation profile results to declared claims.
 *
 * Pure: it receives already-summarized mutation verdicts and maps them onto the
 * claims that opted in via a `mutation_profile` evidence reference. It never
 * runs a mutation tool and never reads the filesystem.
 *
 * Evidence semantics:
 * - surviving mutants  -> `fail` (the claim's tests did not detect the change);
 * - none surviving     -> `pass`;
 * - profile not covered by the report, or no report at all -> `unavailable`
 *   (surfaced as NOT_VERIFIED), never a pass-by-fallback.
 *
 * Mutation evidence binds to the current implementation digest, so it becomes
 * STALE as soon as the implementation changes.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import type { ProofProviderResult } from '../../state/proofgraph.js';
import type { MutationProfile, MutationProfileSummary } from './mutation-report.js';

/** Provider identity stamped on mutation results. */
export const MUTATION_PROVIDER_ID = 'semantic-mutation';
/** Provider version stamped on mutation results. */
export const MUTATION_PROVIDER_VERSION = 'semantic-mutation.v1';

/** A profile plus its evaluated verdict, or an explicit absence. */
export interface MutationEvaluation {
  readonly profile: MutationProfile;
  /** Undefined when no report was available at all. */
  readonly summary?: MutationProfileSummary;
}

function unavailable(claimId: string, evaluatedAt: string, reason: string): ProofProviderResult {
  return {
    claimId,
    providerKind: 'fault_injection',
    providerId: MUTATION_PROVIDER_ID,
    providerVersion: MUTATION_PROVIDER_VERSION,
    input: {},
    status: 'unavailable',
    executedAt: evaluatedAt,
    detail: reason,
  };
}

/**
 * Resolve one claim's mutation profile reference into a provider result.
 * Every unresolved condition yields explicit `unavailable` evidence.
 */
function resolveMutationResult(
  claimId: string,
  profileId: string,
  evaluation: MutationEvaluation | undefined,
  implementationDigest: string | undefined,
  evaluatedAt: string,
): ProofProviderResult {
  if (evaluation === undefined) {
    return unavailable(claimId, evaluatedAt, `unknown mutation profile: ${profileId}`);
  }
  const summary = evaluation.summary;
  if (summary === undefined || !summary.covered) {
    return unavailable(
      claimId,
      evaluatedAt,
      `no recorded mutation results for profile ${profileId}`,
    );
  }
  if (implementationDigest === undefined) {
    return unavailable(
      claimId,
      evaluatedAt,
      'no implementation revision to bind mutation evidence to',
    );
  }
  const clean = summary.survivorCount === 0;
  return {
    claimId,
    providerKind: 'fault_injection',
    providerId: MUTATION_PROVIDER_ID,
    providerVersion: MUTATION_PROVIDER_VERSION,
    input: { command: evaluation.profile.command },
    source: { location: `mutation-profile:${summary.profileId}`, stableId: summary.profileId },
    binding: { kind: 'implementation', digest: implementationDigest },
    status: clean ? 'pass' : 'fail',
    resultDigest: summary.resultDigest,
    executedAt: evaluatedAt,
    detail: clean
      ? `${summary.killedCount} mutants detected, no survivors`
      : `${summary.survivorCount} surviving mutants (${summary.killedCount} detected)`,
  };
}

/**
 * Bind recorded mutation results to the claims referencing their profile.
 *
 * @param state       Session state (contract claims + implementation digest).
 * @param evaluations Evaluated mutation profiles.
 * @param evaluatedAt ISO-8601 timestamp used for `unavailable` results.
 */
export function bindMutationEvidence(
  state: SessionState,
  evaluations: readonly MutationEvaluation[],
  evaluatedAt: string,
): ProofProviderResult[] {
  const byProfile = new Map(evaluations.map((e) => [e.profile.profileId, e]));
  const implementationDigest = state.implementation?.digest;
  const results: ProofProviderResult[] = [];

  for (const claim of state.proofContract?.claims ?? []) {
    for (const ref of claim.evidenceRefs) {
      if (ref.kind !== 'mutation_profile') continue;
      results.push(
        resolveMutationResult(
          claim.claimId,
          ref.profileId,
          byProfile.get(ref.profileId),
          implementationDigest,
          evaluatedAt,
        ),
      );
    }
  }
  return results;
}
