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
 *   (surfaced as NOT_VERIFIED), never a pass-by-fallback;
 * - no recorded envelope (legacy Stryker JSON without `mutation-evidence.v1`) ->
 *   every result is `unavailable` with a reason describing the missing binding.
 *
 * Critical invariant (#762):
 * The binder MUST never substitute the current implementation digest or current
 * timestamp into a pre-existing mutation report. It MUST use the recorded
 * digest, command, and timestamps from the {@link RecordedMutationEvidence}
 * envelope that was persisted when the mutation run was executed.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import type { ProofProviderResult } from '../../state/proofgraph.js';
import type {
  MutationProfile,
  MutationProfileSummary,
  RecordedMutationEvidence,
} from './mutation-report.js';

/** Provider identity stamped on mutation results. */
export const MUTATION_PROVIDER_ID = 'semantic-mutation';
/** Provider version stamped on mutation results. */
export const MUTATION_PROVIDER_VERSION = 'semantic-mutation.v1';

/** A profile plus its evaluated verdict, or an explicit absence. */
export interface MutationEvaluation {
  readonly profile: MutationProfile;
  /** Undefined when no report was available at all (legacy). */
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
 *
 * When a valid envelope exists, the result carries the RECORDED implementation
 * digest in its binding and the RECORDED completedAt timestamp — never the
 * current session state's digest or the evaluation timestamp.
 */
function resolveMutationResult(
  claimId: string,
  profileId: string,
  evaluation: MutationEvaluation | undefined,
  envelope: RecordedMutationEvidence,
): ProofProviderResult {
  if (evaluation === undefined) {
    return unavailable(claimId, envelope.completedAt, `unknown mutation profile: ${profileId}`);
  }
  const summary = evaluation.summary;
  if (summary === undefined || !summary.covered) {
    return unavailable(
      claimId,
      envelope.completedAt,
      `no recorded mutation results for profile ${profileId}`,
    );
  }
  const clean = summary.survivorCount === 0;
  return {
    claimId,
    providerKind: 'fault_injection',
    providerId: MUTATION_PROVIDER_ID,
    providerVersion: envelope.providerVersion,
    input: { command: envelope.command },
    source: {
      location: `mutation-profile:${summary.profileId}`,
      stableId: summary.profileId,
    },
    binding: { kind: 'implementation', digest: envelope.implementationDigest },
    status: clean ? 'pass' : 'fail',
    resultDigest: envelope.reportDigest,
    executedAt: envelope.completedAt,
    detail: clean
      ? `${summary.killedCount} mutants detected, no survivors`
      : `${summary.survivorCount} surviving mutants (${summary.killedCount} detected)`,
  };
}

/**
 * Bind recorded mutation results to the claims referencing their profile.
 *
 * @param state          Session state (contract claims).
 * @param evaluations    Evaluated mutation profiles.
 * @param envelope       Recorded mutation evidence envelope, or `null` when no
 *                       envelope was persisted alongside the mutation report.
 *                       Without an envelope the report is an unbound legacy
 *                       artifact — every result is `unavailable`.
 * @param evaluatedAt    ISO-8601 timestamp used ONLY for `unavailable` results
 *                       that have no envelope to borrow a timestamp from.
 */
export function bindMutationEvidence(
  state: SessionState,
  evaluations: readonly MutationEvaluation[],
  envelope: RecordedMutationEvidence | null,
  evaluatedAt: string,
): ProofProviderResult[] {
  const byProfile = new Map(evaluations.map((e) => [e.profile.profileId, e]));
  const results: ProofProviderResult[] = [];
  const isLegacy = envelope === null;

  for (const claim of state.proofContract?.claims ?? []) {
    for (const ref of claim.evidenceRefs) {
      if (ref.kind !== 'mutation_profile') continue;
      if (isLegacy) {
        results.push(
          unavailable(
            claim.claimId,
            evaluatedAt,
            `unbound legacy mutation report: no ${'mutation-evidence.v1'} envelope was persisted with this report`,
          ),
        );
        continue;
      }
      results.push(
        resolveMutationResult(claim.claimId, ref.profileId, byProfile.get(ref.profileId), envelope),
      );
    }
  }
  return results;
}
