/**
 * @module audit/proofgraph/counterexample-binder
 * @description Bind declared counterexample references to executed outcomes.
 *
 * Falsification-first, evidence-bound: a claim's counterexample references name
 * an implementation validation attempt whose FAILURE would contradict the claim.
 * The outcome is derived from the attempt's executed result, never asserted:
 *   - the attempt failed  -> `contradicted` (the falsification succeeded)
 *   - the attempt passed   -> `supported` (the falsification attempt did not hold)
 *   - missing / wrong scope -> `not_verified`
 *
 * A `contradicted` counterexample makes the evaluator report the claim as
 * CONTRADICTED, which wins over any passing positive evidence.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import type { ProofCounterexample } from '../../state/proofgraph.js';
import type { CounterexampleOutcome } from '../../state/proofgraph-primitives.js';

/**
 * Bind the counterexample references declared on a session's contract claims to
 * executed outcomes against the current implementation revision.
 *
 * @param state       Session state (contract claims + validation ledger + impl digest).
 * @param evaluatedAt ISO-8601 timestamp used for `not_verified` counterexamples.
 */
export function bindCounterexamples(
  state: SessionState,
  evaluatedAt: string,
): ProofCounterexample[] {
  const claims = state.proofContract?.claims ?? [];
  const currentDigest = state.implementation?.digest;
  if (currentDigest === undefined) return [];

  const counterexamples: ProofCounterexample[] = [];
  for (const claim of claims) {
    for (const ref of claim.counterexampleRefs) {
      if (ref.kind !== 'validation_attempt') continue;
      const attempt = state.validationAttempts.find((a) => a.attemptId === ref.attemptId);
      if (attempt === undefined || attempt.scope !== 'implementation') {
        counterexamples.push({
          claimId: claim.claimId,
          scenario: `unresolved counterexample attempt ${ref.attemptId}`,
          outcome: 'not_verified',
          boundDigest: currentDigest,
          executedAt: evaluatedAt,
        });
        continue;
      }
      const outcome: CounterexampleOutcome = attempt.result.passed ? 'supported' : 'contradicted';
      counterexamples.push({
        claimId: claim.claimId,
        scenario: `falsification via check '${attempt.result.checkId}'`,
        outcome,
        boundDigest: attempt.implementationDigest,
        executedAt: attempt.result.executedAt,
      });
    }
  }
  return counterexamples;
}
