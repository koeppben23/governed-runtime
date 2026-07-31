/**
 * @module audit/proofgraph/executed-test-binder
 * @description Bind existing implementation validation attempts as ProofGraph
 * executed-test provider results.
 *
 * This is a binder, not an executor: it maps already-executed, digest-bound
 * ValidationAttempts (the canonical validation authority) into provider results
 * for the claims that reference them by attemptId. A referenced attempt that is
 * missing or not implementation-scoped yields an explicit `unavailable` result
 * (surfaced by the evaluator as NOT_VERIFIED), never a pass-by-fallback. A real
 * execution error (timeout / command-not-found) maps to `error` (BLOCKED),
 * distinct from a failing verdict (`fail` -> UNPROVEN).
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import type { ProofProviderResult } from '../../state/proofgraph.js';
import { isExecutionError } from '../../state/evidence-validation.js';

/** Stable provider identity, distinct from its version. */
export const EXECUTED_TEST_PROVIDER_ID = 'executed-test';
/** Provider identity/version stamped on bound results. */
export const EXECUTED_TEST_PROVIDER_VERSION = 'executed-test.v1';

/**
 * Bind implementation validation attempts referenced by the session's contract
 * claims into executed-test provider results.
 *
 * @param state       Session state (contract claims + validation attempt ledger).
 * @param evaluatedAt ISO-8601 timestamp used for `unavailable` results.
 */
export function bindExecutedTestEvidence(
  state: SessionState,
  evaluatedAt: string,
): ProofProviderResult[] {
  const claims = state.proofContract?.claims ?? [];
  const results: ProofProviderResult[] = [];
  for (const claim of claims) {
    for (const ref of claim.evidenceRefs) {
      if (ref.kind !== 'validation_attempt') continue;
      const attempt = state.validationAttempts.find((a) => a.attemptId === ref.attemptId);
      if (attempt === undefined || attempt.scope !== 'implementation') {
        results.push({
          claimId: claim.claimId,
          providerKind: 'executed_test',
          providerId: EXECUTED_TEST_PROVIDER_ID,
          providerVersion: EXECUTED_TEST_PROVIDER_VERSION,
          input: {},
          status: 'unavailable',
          executedAt: evaluatedAt,
          detail: `no implementation validation attempt for ${ref.attemptId}`,
        });
        continue;
      }
      const r = attempt.result;
      // Executed evidence needs exactly one reproducible input; fall back to a
      // deterministic check-id assertion when a command string is unavailable.
      const input =
        r.command.length > 0 ? { command: r.command } : { assertion: `check:${r.checkId}` };
      const base = {
        claimId: claim.claimId,
        providerKind: 'executed_test' as const,
        providerId: EXECUTED_TEST_PROVIDER_ID,
        providerVersion: EXECUTED_TEST_PROVIDER_VERSION,
        input,
        source: { location: r.checkId, stableId: attempt.attemptId },
        binding: { kind: 'implementation' as const, digest: attempt.implementationDigest },
        resultDigest: r.outputDigest,
        executedAt: r.executedAt,
        detail: r.command,
      };
      results.push(
        r.passed
          ? { ...base, status: 'pass' }
          : isExecutionError(r)
            ? { ...base, status: 'error' }
            : { ...base, status: 'fail' },
      );
    }
  }
  return results;
}
