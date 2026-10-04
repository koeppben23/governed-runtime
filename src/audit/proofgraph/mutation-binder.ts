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
 * - A referenced attempt whose report failed digest verification → `unavailable`;
 * - A `MutationProfileRef` pointing to a profile without a recorded attempt →
 *   `unavailable` (stays NOT_VERIFIED).
 *
 * Critical invariants (#762):
 * - The binder uses the RECORDED implementation digest and completedAt timestamp
 *   from the `MutationAttempt`, never the current session-state digest or
 *   evaluation timestamp.
 * - Verdicts are accepted only for (attempt, profile) pairs whose report was
 *   re-verified against BOTH recorded digests, so a verdict can never be paired
 *   with the digest of a different artifact.
 *
 * @version v3 — profile-scoped, digest-verified verdicts
 */

import type { SessionState } from '../../state/schema.js';
import type { MutationAttempt } from '../../state/evidence-mutation.js';
import type { ProofProviderResult } from '../../state/proofgraph.js';

/** Verdict for one (attempt, profile) pair, derived from a digest-verified report. */
export interface VerifiedProfileVerdict {
  readonly survivorCount: number;
  readonly killedCount: number;
  readonly covered: boolean;
}

/** Provider identity stamped on mutation results. */
export const MUTATION_PROVIDER_ID = 'semantic-mutation';
/** Provider version stamped on mutation results. */
export const MUTATION_PROVIDER_VERSION = 'semantic-mutation.v1';

/**
 * Authority coupling invariant: mutation evidence attestation and declaration
 * satisfiability must remain linked.
 *
 * Today all mutation evidence carries `external_self_reported` attestation,
 * and `hasProvingMutationProvider()` in the provider registry returns `false`.
 * The claim-contract boundary rejects `mutationProfile` declarations because
 * no proving provider exists.
 *
 * When a FlowGuard-executed mutation provider is added, THREE things must
 * change together — never independently:
 *
 * 1. The execution pipeline produces `flowguard_executed` evidence.
 * 2. This binder derives `attestation` from the execution authority of the
 *    actual attempt, not a hardcoded string.
 * 3. `hasProvingMutationProvider()` reflects the new capability from the
 *    same registry metadata.
 *
 * A future `trusted: true` profile flag that is not linked to the binder's
 * attestation path would create a parallel authority: the declaration
 * boundary would accept the claim, but the evaluator would still filter
 * the evidence as `external_self_reported`, leaving the contract permanently
 * unsatisfiable.
 */

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
    attestation: 'external_self_reported',
  };
}

/**
 * Resolve one `mutation_attempt` reference into a provider result.
 *
 * Precedence:
 * 1. Non-zero exit code → `error` (the mutation run did not complete normally;
 *    surviving mutants were NOT proven absent).
 * 2. No evaluated mutants (covered=false) → already handled by caller as
 *    `unavailable`.
 * 3. survivors > 0 → `fail`.
 * 4. survivors === 0 → `pass`.
 */
function resolveFromAttempt(
  claimId: string,
  attempt: MutationAttempt,
  profileId: string,
  survivorCount: number,
  killedCount: number,
): ProofProviderResult {
  if (attempt.exitCode !== 0) {
    return {
      claimId,
      providerKind: 'fault_injection',
      providerId: MUTATION_PROVIDER_ID,
      providerVersion: attempt.providerVersion,
      input: { command: attempt.command },
      source: {
        location: `mutation-attempt:${attempt.attemptId}`,
        stableId: `${attempt.attemptId}:${profileId}`,
      },
      binding: { kind: 'implementation', digest: attempt.implementationDigest },
      status: 'error',
      resultDigest: attempt.projectionDigest,
      executedAt: attempt.completedAt,
      detail: `mutation command exited with code ${attempt.exitCode}; no valid verdict`,
      attestation: 'external_self_reported',
    };
  }
  const clean = survivorCount === 0;
  return {
    claimId,
    providerKind: 'fault_injection',
    providerId: MUTATION_PROVIDER_ID,
    providerVersion: attempt.providerVersion,
    input: { command: attempt.command },
    source: {
      location: `mutation-attempt:${attempt.attemptId}`,
      stableId: `${attempt.attemptId}:${profileId}`,
    },
    binding: { kind: 'implementation', digest: attempt.implementationDigest },
    status: clean ? 'pass' : 'fail',
    resultDigest: attempt.projectionDigest,
    executedAt: attempt.completedAt,
    detail: clean
      ? `${profileId}: ${killedCount} mutants detected, no survivors`
      : `${profileId}: ${survivorCount} surviving mutants (${killedCount} detected)`,
    attestation: 'external_self_reported',
  };
}

/**
 * Bind session-state mutation attempts to the claims that reference them.
 *
 * @param state           Session state (claims + mutationAttempts).
 * @param verifiedVerdicts Per-attempt, per-profile verdicts derived ONLY from
 *                         reports whose recorded artifact AND projection digests
 *                         were re-verified against the attempt. Computed by the
 *                         caller because this module is pure and reads no files.
 * @param evaluatedAt     ISO-8601 timestamp used only for `unavailable` results.
 */
export function bindMutationEvidence(
  state: SessionState,
  verifiedVerdicts: ReadonlyMap<string, ReadonlyMap<string, VerifiedProfileVerdict>>,
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
        // Absent => the attempt's report is missing or its recorded digests no
        // longer match the artifact on disk. Never fall back to another report.
        const verdict = verifiedVerdicts.get(ref.attemptId)?.get(ref.profileId);
        if (verdict === undefined || !verdict.covered) {
          results.push(
            unavailable(
              claim.claimId,
              evaluatedAt,
              `mutation attempt ${ref.attemptId} has no digest-verified verdict for profile ${ref.profileId}`,
            ),
          );
          continue;
        }
        results.push(
          resolveFromAttempt(
            claim.claimId,
            attempt,
            ref.profileId,
            verdict.survivorCount,
            verdict.killedCount,
          ),
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
