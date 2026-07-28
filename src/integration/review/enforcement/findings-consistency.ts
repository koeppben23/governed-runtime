/**
 * @module integration/review/enforcement/findings-consistency
 * @description Canonical, dependency-free consistency invariant for review findings.
 *
 * SSOT for the verdict/blocking-issues coherence rule (F12) ONLY. Challenge and
 * resolution consistency is owned by the separate `challenge-consistency.ts`
 * authority (#747); this module must not re-derive or duplicate that logic. The
 * architecture guard `challenge-consistency-authority-ssot.test.ts` pins the
 * separation.
 *
 * Rule (strict emptiness): an `accept` verdict is incoherent with ANY blocking
 * issue. The rule intentionally keys on the presence of blocking issues, not on
 * their severity: the current `ReviewFindings` schema does not constrain which
 * severities may appear in `blockingIssues`, and the field name is the contract.
 * A minor advisory note misfiled into `blockingIssues` therefore also blocks an
 * `accept` — the reviewer must return a non-accept verdict or reclassify the
 * finding. Severity-aware separation is deferred to a schema change (F13) where
 * it becomes structurally guaranteed rather than interpreted at runtime.
 *
 * The runtime is deliberately stricter than the reviewer mandate prose
 * (which permits `accept` with minor-only blocking issues). Failing closed on a
 * self-contradictory finding does not weaken the security contract.
 *
 * Dependency-free by design: no `formatBlocked`, no rail/enforcement result
 * types. Callers translate `ReviewFindingsConsistencyResult` into their own
 * blocked format.
 */

/** Boundary-neutral result of the canonical consistency check. */
export type ReviewFindingsConsistencyResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'SUBAGENT_VERDICT_FINDINGS_INCOHERENT';
      readonly details: {
        readonly overallVerdict: 'accept';
        readonly blockingIssueCount: number;
      };
    };

/**
 * Minimal shape required to evaluate the coherence rule.
 *
 * Both ingestion boundaries can satisfy this:
 * - Verdict-submission boundary passes `blockingIssues.length`.
 * - Enforcement/binding boundary passes the captured `blockingIssuesCount`.
 */
export interface ReviewFindingsConsistencyInput {
  readonly overallVerdict: string;
  readonly blockingIssueCount: number;
}

/**
 * Canonical coherence check. Returns `{ ok: true }` when the verdict is
 * consistent with the blocking-issue count, otherwise a typed failure that the
 * caller renders into its blocked format.
 */
export function validateReviewFindingsConsistency(
  input: ReviewFindingsConsistencyInput,
): ReviewFindingsConsistencyResult {
  if (input.overallVerdict === 'accept' && input.blockingIssueCount > 0) {
    return {
      ok: false,
      code: 'SUBAGENT_VERDICT_FINDINGS_INCOHERENT',
      details: {
        overallVerdict: 'accept',
        blockingIssueCount: input.blockingIssueCount,
      },
    };
  }
  return { ok: true };
}
