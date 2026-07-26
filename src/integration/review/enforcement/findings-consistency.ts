/**
 * @module integration/review/enforcement/findings-consistency
 * @description Canonical, dependency-free consistency invariant for review findings.
 *
 * SSOT for the verdict/blocking-issues coherence rule (F12). This is the ONLY
 * implementation of the rule; every boundary that ingests reviewer findings
 * MUST call this function rather than re-deriving the rule, so a later refactor
 * cannot silently diverge the two enforcement sites.
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
 * Dependency-free challenge coverage invariant. It accepts structural data so it
 * can be used at schema, SDK, and host-capture boundaries without dependencies.
 */
export interface ChallengeConsistencyInput {
  readonly requiredChallengeCount: number;
  readonly requiredChallengeKind:
    'design_challenge' | 'implementation_challenge' | 'content_challenge';
  readonly challenges:
    | readonly {
        readonly kind: string;
        readonly evidenceRefs?: readonly unknown[];
        readonly outcome?: string;
      }[]
    | undefined;
  readonly unresolvedImplementationChallengeIds?: readonly string[];
  readonly resolutionVerdicts?: readonly {
    readonly challengeId: string;
    readonly verdict: string;
  }[];
}

export type ChallengeConsistencyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly details: Record<string, unknown> };

// eslint-disable-next-line complexity -- explicit fail-closed challenge matrix branches
export function validateChallengeConsistency(
  input: ChallengeConsistencyInput,
): ChallengeConsistencyResult {
  const challenges = input.challenges ?? [];
  if (challenges.length < input.requiredChallengeCount) {
    return {
      ok: false,
      code: 'SUBAGENT_CHALLENGE_COUNT_INCOHERENT',
      details: { required: input.requiredChallengeCount, actual: challenges.length },
    };
  }
  for (const challenge of challenges) {
    if (input.requiredChallengeCount > 0 && challenge.kind !== input.requiredChallengeKind) {
      return {
        ok: false,
        code: 'SUBAGENT_CHALLENGE_KIND_INCOHERENT',
        details: { required: input.requiredChallengeKind, actual: challenge.kind },
      };
    }
    if (!challenge.evidenceRefs || challenge.evidenceRefs.length === 0) {
      return {
        ok: false,
        code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
        details: { kind: challenge.kind },
      };
    }
    if (
      challenge.kind === 'implementation_challenge' &&
      (challenge.outcome === 'fail' || challenge.outcome === 'not_verified')
    ) {
      return {
        ok: false,
        code: 'SUBAGENT_IMPLEMENTATION_CHALLENGE_UNRESOLVED',
        details: { outcome: challenge.outcome },
      };
    }
  }
  const verdicts = new Map(
    (input.resolutionVerdicts ?? []).map((item) => [item.challengeId, item.verdict]),
  );
  const unresolved = (input.unresolvedImplementationChallengeIds ?? []).find(
    (id) => verdicts.get(id) !== 'resolved',
  );
  return unresolved
    ? {
        ok: false,
        code: 'SUBAGENT_IMPLEMENTATION_CHALLENGE_UNRESOLVED',
        details: { challengeId: unresolved },
      }
    : { ok: true };
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
