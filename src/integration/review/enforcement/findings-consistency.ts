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

// ─── Reviewed Scope (discriminated union) ──────────────────────────────────

/**
 * Explicit, typed file-scope state for review obligations.
 *
 * - `files`: the reviewer was issued a concrete set of file paths.
 * - `not_applicable`: the review context has no file scope (ADR, plan section,
 *    architecture text).
 * - `unavailable`: scope could not be resolved for a file-backed review (diff
 *    provider failure, legacy untyped obligation).
 *
 * Absence of the field (undefined) is legacy and treated as `unavailable` —
 * fail closed.
 */
export type ReviewedScope =
  | { readonly kind: 'files'; readonly paths: readonly string[] }
  | { readonly kind: 'not_applicable'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

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

// ─── Path Candidate Extraction ────────────────────────────────────────────

const KNOWN_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'java',
  'kt',
  'kts',
  'go',
  'py',
  'rb',
  'rs',
  'cs',
  'cpp',
  'cc',
  'cxx',
  'h',
  'hpp',
  'c',
  'md',
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'html',
  'css',
  'scss',
  'less',
  'sql',
  'sh',
  'bash',
  'graphql',
  'proto',
  'tf',
  'swift',
  'scala',
  'dart',
  'ex',
  'exs',
  'erl',
  'hrl',
  'lua',
  'php',
  'r',
  'ps1',
  'fs',
  'fsx',
  'hs',
  'lhs',
  'elm',
  'clj',
  'cljs',
  'edn',
  'vue',
  'svelte',
  'astro',
  'sol',
  'zig',
  'nim',
]);

const EXTENSION_LIST = [...KNOWN_EXTENSIONS].join('|');

const EXTENSION_PATH_RE_SOURCE = `([a-zA-Z0-9_./-]+\\.(?:${EXTENSION_LIST}))`;

function extractExtensionPaths(text: string): string[] {
  const paths: string[] = [];
  const re = new RegExp(EXTENSION_PATH_RE_SOURCE, 'gi');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[1]) paths.push(match[1]);
  }
  return paths;
}

function hasExtension(text: string): boolean {
  const lastDot = text.lastIndexOf('.');
  if (lastDot === -1) return false;
  const afterDot = text.slice(lastDot + 1).toLowerCase();
  const ext = afterDot.split(/[^a-z0-9]/)[0] ?? '';
  return ext.length > 0 && KNOWN_EXTENSIONS.has(ext);
}

/**
 * Strip line/range annotations and parenthetical method/field references from
 * a path candidate, then normalize the result.
 */
function stripPathDecorations(raw: string): string {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/:\d+(-\d+)?$/, '');
  cleaned = cleaned.replace(/\s*\([^)]*\)$/, '');
  cleaned = cleaned.trim();
  return normalizeFilePath(cleaned);
}

/**
 * Extract every recognized repository-path reference from a location string.
 *
 * 1. Split on `;` and `,` into rough tokens.
 * 2. For each token, scan for substrings matching a known source extension.
 * 3. If none found, check whether the token itself is a directory-style path
 *    (contains `/` and does not match common prose prefixes).
 * 4. Strip line/range (`:N`, `:N-M`) and parenthetical annotations, then
 *    normalize.
 *
 * Non-path prose tokens yield zero candidates and are ignored — they do not
 * cause false-positive scope violations.
 */
function extractPathCandidates(location: string): string[] {
  const segments = location
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const candidates: string[] = [];

  for (const segment of segments) {
    const extPaths = extractExtensionPaths(segment);
    if (extPaths.length > 0) {
      for (const p of extPaths) {
        const cleaned = stripPathDecorations(p);
        if (cleaned) candidates.push(cleaned);
      }
      continue;
    }

    if (segment.includes('/') && hasExtension(segment)) {
      const cleaned = stripPathDecorations(segment);
      if (cleaned) candidates.push(cleaned);
      continue;
    }

    if (
      segment.includes('/') &&
      !/^\s*(?:see|line|lines|ADR|Section|chapter|paragraph|clause|decision|review)\b/i.test(
        segment,
      )
    ) {
      const cleaned = stripPathDecorations(segment);
      if (cleaned) candidates.push(cleaned);
    }
  }

  return [...new Set(candidates)];
}

// ─── Finding Location Interface ──────────────────────────────────────────

export interface FindingWithLocation {
  readonly location?: string;
  readonly [key: string]: unknown;
}

/**
 * Canonical file-scope check.
 *
 * For every finding with a `location`:
 *
 * 1. Extract all syntactically recognizable repository-path references from
 *    the location string. If zero path candidates are present, the location is
 *    descriptive/unscoped and does not violate file scope.
 *
 * 2. If one or more path candidates are present, EVERY referenced path MUST
 *    belong to the obligation's frozen `reviewedFileScope`. One out-of-scope
 *    path is sufficient to reject the finding.
 *
 * Scope state determines enforcement:
 * - `kind: 'files'` → check all path candidates against the frozen set.
 * - `kind: 'not_applicable'` → no file scope expected; always passes.
 * - `kind: 'unavailable'` or `undefined` (legacy) → `SCOPE_UNVERIFIABLE`;
 *   fail-closed for file-backed reviews.
 */
export function validateReviewFindingsScope(input: {
  readonly findings: readonly FindingWithLocation[];
  readonly reviewedFileScope?: ReviewedScope | readonly string[];
}): ReviewFindingsScopeResult {
  const scope = input.reviewedFileScope;

  if (!scope) {
    return {
      ok: false,
      code: 'REVIEW_FINDING_SCOPE_UNVERIFIABLE',
      details: { outOfScopePaths: [], reviewedFileScope: [] },
    };
  }

  if (Array.isArray(scope)) {
    return validateScopeWithPaths(input.findings, scope);
  }

  const reviewedScope = scope as ReviewedScope;

  if (reviewedScope.kind === 'not_applicable') {
    return { ok: true };
  }

  if (reviewedScope.kind === 'unavailable') {
    return {
      ok: false,
      code: 'REVIEW_FINDING_SCOPE_UNVERIFIABLE',
      details: { outOfScopePaths: [], reviewedFileScope: [] },
    };
  }

  return validateScopeWithPaths(input.findings, reviewedScope.paths);
}

function validateScopeWithPaths(
  findings: readonly FindingWithLocation[],
  scope: readonly string[],
): ReviewFindingsScopeResult {
  const normalizedScope = new Set(scope.map(normalizeFilePath));
  const outOfScope: string[] = [];

  for (const finding of findings) {
    const location = finding.location?.trim();
    if (!location || location.length === 0) continue;

    const candidates = extractPathCandidates(location);
    if (candidates.length === 0) continue;

    for (const candidate of candidates) {
      if (!normalizedScope.has(candidate)) {
        outOfScope.push(location);
        break;
      }
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
