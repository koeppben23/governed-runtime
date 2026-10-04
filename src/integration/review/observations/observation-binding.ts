/**
 * @module integration/review/observation-binding
 * @description Canonical repository evidence authorization.
 *
 * The ONLY module that evaluates authoritative `RepositoryObservation`
 * records for evidence ADMISSIBILITY:
 *
 * ```text
 * Finding.evidenceLocations
 *   → must match an authoritative Observation of the binding attempt
 *   → same obligation
 *   → same attempt
 *   → same reviewer child session
 *   → same canonical path
 *   → same revision
 *   → same COMPLETE frozen target { kind, objectSha, repositoryIdentity }
 * ```
 *
 * Design rules (architecture-guarded):
 * - This module NEVER acquires anything. No git, no provider, no worktree
 *   reads, no `adapters/` imports. A failed acquisition manifests upstream as
 *   the ABSENCE of an Observation — never as a binder fallback.
 * - Paths are compared CANONICALLY: the schema layer normalized the citation,
 *   the host normalized the observation at mint time. This module never
 *   re-normalizes.
 * - Line citations are admissible only against `utf8_text` observations and
 *   within the minted canonical line count. Binary + line → fail closed.
 *
 * The result is governance, not schema validation: `evidence_unavailable`,
 * never `schema_invalid`, never output-repairable.
 *
 * @version v1
 */

import { canonicalJsonStringify } from '../../../shared/canonical-json.js';
import type {
  RepositoryObservation,
  ReviewObligation,
  ReviewAttempt,
  ReviewRepositoryIdentity,
} from '../../../state/evidence.js';
import { resolveFrozenRevisionTarget } from '../../../state/evidence.js';

/** Minimal finding-relation shape the binder consumes. */
export interface BindingFindingRelation {
  readonly relation: {
    readonly evidenceLocations: ReadonlyArray<{
      readonly path: string;
      readonly revision: 'base' | 'head';
      readonly line?: number;
      readonly endLine?: number;
    }>;
  };
}

/** Host-classified reason one repository evidenceLocation failed authorization. */
export type EvidenceLocationFailure =
  | { kind: 'no_attempt'; path: string }
  | { kind: 'revision_unavailable'; revision: 'base' | 'head' }
  | { kind: 'unobserved'; path: string; revision: 'base' | 'head' }
  | { kind: 'binary_line_citation'; path: string; revision: 'base' | 'head' }
  | {
      kind: 'line_out_of_range';
      path: string;
      revision: 'base' | 'head';
      line: number;
      lineCount: number;
    }
  | {
      kind: 'end_line_out_of_range';
      path: string;
      revision: 'base' | 'head';
      endLine: number;
      lineCount: number;
    };

export type EvidenceBindingResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'evidence_unavailable';
      readonly failingIndexes: readonly number[];
      readonly failures: readonly EvidenceLocationFailure[];
    };

/** Canonical host rendering of one structured failure for operator-facing envelopes. */
export function renderEvidenceLocationFailure(failure: EvidenceLocationFailure): string {
  switch (failure.kind) {
    case 'no_attempt':
      return `evidenceLocations for '${failure.path}' have no authoritative observation: no attempt-bound observations exist for this review`;
    case 'revision_unavailable':
      return `revision '${failure.revision}' has no frozen repository authority for this obligation`;
    case 'unobserved':
      return `no authoritative observation exists for '${failure.path}'@${failure.revision} in this reviewer attempt`;
    case 'binary_line_citation':
      return `'${failure.path}'@${failure.revision} was observed as binary content; line citations are not admissible`;
    case 'line_out_of_range':
      return `line ${failure.line} exceeds the observed content of '${failure.path}'@${failure.revision} (${failure.lineCount} lines)`;
    case 'end_line_out_of_range':
      return `endLine ${failure.endLine} exceeds the observed content of '${failure.path}'@${failure.revision} (${failure.lineCount} lines)`;
  }
}

function repositoryIdentityEqual(
  a: ReviewRepositoryIdentity,
  b: ReviewRepositoryIdentity,
): boolean {
  return canonicalJsonStringify(a) === canonicalJsonStringify(b);
}

/** Full match predicate: obligation, attempt, session, path, revision, and the COMPLETE frozen target. */
function observationMatchesTarget(
  o: RepositoryObservation,
  input: {
    readonly obligation: ReviewObligation;
    readonly attempt: ReviewAttempt | null;
    readonly childSessionId: string;
  },
  attempt: ReviewAttempt,
  location: { readonly path: string; readonly revision: 'base' | 'head' },
  target: NonNullable<ReturnType<typeof resolveFrozenRevisionTarget>>,
): boolean {
  return (
    o.obligationId === input.obligation.obligationId &&
    o.attemptId === attempt.attemptId &&
    o.observedBySessionId === input.childSessionId &&
    o.path === location.path &&
    o.revision === location.revision &&
    o.resolvedObjectKind === target.kind &&
    o.resolvedObjectSha === target.objectSha &&
    repositoryIdentityEqual(o.repositoryIdentity, target.repositoryIdentity)
  );
}

/**
 * Canonical evidence authorization for repository evidenceLocations.
 *
 * Every cited location must resolve to an authoritative Observation minted for
 * the EXACT binding attempt and reviewer child session, against the EXACT
 * frozen target. No observation means no evidence — the citation remains a
 * claim.
 *
 * @param attempt - the attempt the findings bind against; null (e.g. direct
 *                  SDK/manual submissions without host-task attempt binding)
 *                  makes every repository evidenceLocation unavailable.
 */
export function bindRepositoryEvidenceLocations(input: {
  readonly findings: readonly BindingFindingRelation[];
  readonly obligation: ReviewObligation;
  readonly attempt: ReviewAttempt | null;
  readonly childSessionId: string;
}): EvidenceBindingResult {
  const failingIndexes: number[] = [];
  const failures: EvidenceLocationFailure[] = [];

  input.findings.forEach((finding, index) => {
    const locations = finding.relation.evidenceLocations ?? [];
    if (locations.length === 0) return;

    for (const location of locations) {
      const failure = evaluateLocation(input, location);
      if (failure) {
        failingIndexes.push(index);
        failures.push(failure);
        return;
      }
    }
  });

  if (failingIndexes.length === 0) return { ok: true };
  return {
    ok: false,
    code: 'evidence_unavailable',
    failingIndexes,
    failures,
  };
}

function evaluateLocation(
  input: {
    readonly obligation: ReviewObligation;
    readonly attempt: ReviewAttempt | null;
    readonly childSessionId: string;
  },
  location: {
    readonly path: string;
    readonly revision: 'base' | 'head';
    readonly line?: number;
    readonly endLine?: number;
  },
): EvidenceLocationFailure | null {
  const attempt = input.attempt;
  if (!attempt) {
    return { kind: 'no_attempt', path: location.path };
  }

  // The complete frozen target the citation's revision resolves to. No other
  // resolution source exists — branch movement after the freeze cannot move
  // this target.
  const target = resolveFrozenRevisionTarget(input.obligation, location.revision);
  if (!target) {
    return { kind: 'revision_unavailable', revision: location.revision };
  }

  const observation: RepositoryObservation | undefined = attempt.observations?.find((o) =>
    observationMatchesTarget(o, input, attempt, location, target),
  );

  if (!observation) {
    return {
      kind: 'unobserved',
      path: location.path,
      revision: location.revision,
    };
  }

  return validateLineCitation(observation, location);
}

/**
 * Line citations are admissible only against utf8_text observations and must
 * lie within the minted canonical line count. Binary + line → fail closed.
 */
function validateLineCitation(
  observation: RepositoryObservation,
  location: {
    readonly path: string;
    readonly revision: 'base' | 'head';
    readonly line?: number;
    readonly endLine?: number;
  },
): EvidenceLocationFailure | null {
  if (location.line === undefined && location.endLine === undefined) return null;
  if (observation.representation === 'binary') {
    return {
      kind: 'binary_line_citation',
      path: location.path,
      revision: location.revision,
    };
  }
  const lineCount = observation.lineCount;
  if (location.line !== undefined && (location.line < 1 || location.line > lineCount)) {
    return {
      kind: 'line_out_of_range',
      path: location.path,
      revision: location.revision,
      line: location.line,
      lineCount,
    };
  }
  if (location.endLine !== undefined && location.endLine > lineCount) {
    return {
      kind: 'end_line_out_of_range',
      path: location.path,
      revision: location.revision,
      endLine: location.endLine,
      lineCount,
    };
  }
  return null;
}
