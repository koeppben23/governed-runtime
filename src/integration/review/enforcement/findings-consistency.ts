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

/** Boundary-neutral result of the canonical file-scope consistency check. */
export type ReviewFindingsScopeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'REVIEW_FINDING_OUT_OF_SCOPE' | 'REVIEW_FINDING_SCOPE_UNVERIFIABLE';
      readonly details: {
        readonly outOfScopePaths: readonly string[];
        readonly reviewedFileScope: readonly string[];
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
 * Canonical coherence check. An `accept` verdict is valid only with zero
 * blocking issues; other verdicts are not constrained by this rule. Returns a
 * typed failure that the caller renders into its blocked format when incoherent.
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

// ─── File-Scope Validation ────────────────────────────────────────────────

function normalizeFilePath(raw: string): string {
  let path = raw.trim();
  while (path.startsWith('./')) {
    path = path.slice(2);
  }
  const segments = path.split('/').filter(Boolean);
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '..') {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') {
        resolved.pop();
      } else {
        resolved.push(segment);
      }
    } else if (segment !== '.') {
      resolved.push(segment);
    }
  }
  return resolved.join('/');
}

export interface FindingWithLocation {
  readonly location?: string;
}

/**
 * Canonical file-scope check. Every finding with a `location` must fall within
 * the frozen `reviewedFileScope`. Legacy obligations without a frozen scope
 * yield `scope_unverifiable` rather than silently passing.
 *
 * Separate from the verdict/blocking-issues coherence check but co-located in
 * the same canonical authority module — no parallel validator.
 */
export function validateReviewFindingsScope(input: {
  readonly findings: readonly FindingWithLocation[];
  readonly reviewedFileScope?: readonly string[];
}): ReviewFindingsScopeResult {
  const scope = input.reviewedFileScope;

  if (!scope) {
    return {
      ok: false,
      code: 'REVIEW_FINDING_SCOPE_UNVERIFIABLE',
      details: { outOfScopePaths: [], reviewedFileScope: [] },
    };
  }

  const normalizedScope = new Set(scope.map(normalizeFilePath));
  const outOfScope: string[] = [];

  for (const finding of input.findings) {
    const location = finding.location?.trim();
    if (!location || location.length === 0) continue;
    const normalized = normalizeFilePath(location);
    if (!normalizedScope.has(normalized)) {
      outOfScope.push(location);
    }
  }

  if (outOfScope.length > 0) {
    return {
      ok: false,
      code: 'REVIEW_FINDING_OUT_OF_SCOPE',
      details: { outOfScopePaths: outOfScope, reviewedFileScope: scope },
    };
  }

  return { ok: true };
}
