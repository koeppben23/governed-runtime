/**
 * @module audit/proofgraph/counterexample-binder
 * @description Bind declared counterexample references to executed outcomes.
 *
 * Falsification-first, evidence-bound: a claim's counterexample references name
 * an implementation validation attempt whose explicit falsification or
 * verified support produces a decisive outcome:
 *   - explicit falsified  → contradicted (the falsification succeeded)
 *   - supported           → supported  (the falsification attempt did not hold)
 *   - inconclusive        → not_verified (failed but not a falsification)
 *   - blocked             → blocked (could not execute; timeout, crash, no output)
 *   - missing / wrong scope → not_verified
 *
 * A `contradicted` counterexample makes the evaluator report the claim as
 * CONTRADICTED, which wins over any passing positive evidence.
 * A `blocked` counterexample makes the evaluator report the claim as BLOCKED.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import type { ProofCounterexample } from '../../state/proofgraph.js';
import type { CounterexampleOutcome } from '../../state/proofgraph-primitives.js';
import type { ValidationResult } from '../../state/evidence-validation.js';

function toCounterexampleOutcome(result: ValidationResult): CounterexampleOutcome {
  switch (result.outcome) {
    case 'supported':
      return 'supported';
    case 'inconclusive':
      return 'not_verified';
    case 'blocked':
      return 'blocked';
  }
}

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
          attemptId: ref.attemptId,
          checkId: 'unresolved_validation_attempt',
          scenario: `unresolved counterexample attempt ${ref.attemptId}`,
          outcome: 'not_verified',
          boundDigest: currentDigest,
          executedAt: evaluatedAt,
        });
        continue;
      }
      const outcome = toCounterexampleOutcome(attempt.result);
      counterexamples.push({
        claimId: claim.claimId,
        attemptId: attempt.attemptId,
        checkId: attempt.result.checkId,
        scenario: `falsification via check '${attempt.result.checkId}'`,
        outcome,
        boundDigest: attempt.implementationDigest,
        executedAt: attempt.result.executedAt,
      });
    }
  }
  return counterexamples;
}
