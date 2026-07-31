/**
 * @module audit/proofgraph/mutation-binder
 * @description Bind session-state mutation evidence records to declared claims.
 *
 * Pure: it reads `MutationAttempt` records from `state.mutationAttempts` and
 * maps them onto claims that reference the attempt via a `MutationAttemptRef`.
 * It never runs a mutation tool and never reads the filesystem.
 *
 * Evidence semantics:
 * - A referenced `MutationAttempt` with no surviving mutants → `pass`;
 * - A referenced attempt with surviving mutants → `fail`;
 * - A referenced attempt that does not exist → `unavailable` (never fallback);
 * - A `MutationProfileRef` pointing to a profile without a recorded attempt →
 *   `unavailable` (stays NOT_VERIFIED).
 *
 * Critical invariant (#762):
 * The binder uses the RECORDED implementation digest and completedAt timestamp
 * from the `MutationAttempt`, never the current session-state digest or evaluation
 * timestamp.
 *
 * @version v2 — reads from session-state MutationAttempt[]
 */

import type { SessionState } from '../../state/schema.js';
import type { MutationAttempt } from '../../state/evidence-mutation.js';
import type { ProofProviderResult } from '../../state/proofgraph.js';

/** Provider identity stamped on mutation results. */
export const MUTATION_PROVIDER_ID = 'semantic-mutation';
/** Provider version stamped on mutation results. */
export const MUTATION_PROVIDER_VERSION = 'semantic-mutation.v1';

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
 * Resolve one `mutation_attempt` reference into a provider result.
 */
function resolveFromAttempt(
  claimId: string,
  attempt: MutationAttempt,
  survivorCount: number,
  killedCount: number,
): ProofProviderResult {
  const clean = survivorCount === 0;
  return {
    claimId,
    providerKind: 'fault_injection',
    providerId: MUTATION_PROVIDER_ID,
    providerVersion: attempt.providerVersion,
    input: { command: attempt.command },
    source: { location: `mutation-attempt:${attempt.attemptId}`, stableId: attempt.attemptId },
    binding: { kind: 'implementation', digest: attempt.implementationDigest },
    status: clean ? 'pass' : 'fail',
    resultDigest: attempt.projectionDigest,
    executedAt: attempt.completedAt,
    detail: clean
      ? `${killedCount} mutants detected, no survivors`
      : `${survivorCount} surviving mutants (${killedCount} detected)`,
  };
}

/**
 * Bind session-state mutation attempts to the claims that reference them.
 *
 * @param state         Session state (claims + mutationAttempts).
 * @param profileVerdicts  Profile-level survivor/killed counts computed from the report
 *                         that the attempt references. Passed in because the binder is pure
 *                         and doesn't load reports.
 * @param evaluatedAt   ISO-8601 timestamp used only for `unavailable` results.
 */
export function bindMutationEvidence(
  state: SessionState,
  profileVerdicts: Readonly<
    Map<
      string,
      { readonly survivorCount: number; readonly killedCount: number; readonly covered: boolean }
    >
  >,
  evaluatedAt: string,
): ProofProviderResult[] {
  const attemptsById = new Map(state.mutationAttempts.map((a) => [a.attemptId, a]));
  const results: ProofProviderResult[] = [];

  for (const claim of state.proofContract?.claims ?? []) {
    for (const ref of claim.evidenceRefs) {
      if (ref.kind === 'mutation_attempt') {
        const attempt = attemptsById.get(ref.attemptId);
        if (attempt === undefined) {
          results.push(
            unavailable(
              claim.claimId,
              evaluatedAt,
              `referenced mutation attempt ${ref.attemptId} not found in session state`,
            ),
          );
          continue;
        }
        // Look up the verdict for each profile the attempt covers.
        // If no verdict is available, report unavailable.
        const verdict = profileVerdicts.get(ref.attemptId);
        if (verdict === undefined || !verdict.covered) {
          results.push(
            unavailable(
              claim.claimId,
              evaluatedAt,
              `mutation attempt ${ref.attemptId} has no recorded profile verdicts`,
            ),
          );
          continue;
        }
        results.push(
          resolveFromAttempt(claim.claimId, attempt, verdict.survivorCount, verdict.killedCount),
        );
      }
      if (ref.kind === 'mutation_profile') {
        // A profile reference without a concrete attempt: stay unavailable.
        // Claims should reference concrete attempts (via flowguard_record_mutation_evidence).
        results.push(
          unavailable(
            claim.claimId,
            evaluatedAt,
            `mutation profile ${ref.profileId} referenced but no concrete MutationAttempt recorded; use flowguard_record_mutation_evidence`,
          ),
        );
      }
    }
  }
  return results;
}
