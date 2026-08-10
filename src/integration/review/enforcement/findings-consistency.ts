/**
 * @module integration/review/enforcement/findings-consistency
 * @description Canonical consistency invariants for structured review findings.
 */

import {
  FindingRelation,
  RepositoryLocation,
  ReviewSubjectAnchor,
  ReviewSubjectScope,
  type ArtifactSectionAnchor,
  type FindingRelation as FindingRelationValue,
  type MarkdownSectionPath,
  type ReviewSubjectScope as ReviewSubjectScopeValue,
} from '../../../state/evidence-review.js';

/** Boundary-neutral result of the verdict/blocking-issues coherence check. */
export type ReviewFindingsConsistencyResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'SUBAGENT_VERDICT_FINDINGS_INCOHERENT';
      readonly details: { readonly overallVerdict: 'accept'; readonly blockingIssueCount: number };
    };

/** Boundary-neutral result of structured subject-scope validation. */
export type ReviewFindingsScopeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | 'REVIEW_SUBJECT_SCOPE_UNAVAILABLE'
        | 'REVIEW_FINDING_SUBJECT_ANCHOR_REQUIRED'
        | 'REVIEW_EVIDENCE_LOCATION_INVALID'
        | 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE'
        | 'REVIEW_REPOSITORY_REVISION_UNAVAILABLE';
      readonly details: {
        readonly outOfScopeFindingIndexes: readonly number[];
        readonly reviewSubjectScope: ReviewSubjectScopeValue | undefined;
      };
    };

/** Minimal shape required to evaluate verdict/blocking-issues coherence. */
export interface ReviewFindingsConsistencyInput {
  readonly overallVerdict: string;
  readonly blockingIssueCount: number;
}

/** An untrusted finding relation supplied to the canonical validation boundary. */
export interface FindingWithRelation {
  readonly relation: FindingRelationValue;
  readonly [key: string]: unknown;
}

/** An accept verdict is valid only when there are no blocking issues. */
export function validateReviewFindingsConsistency(
  input: ReviewFindingsConsistencyInput,
): ReviewFindingsConsistencyResult {
  if (input.overallVerdict === 'accept' && input.blockingIssueCount > 0) {
    return {
      ok: false,
      code: 'SUBAGENT_VERDICT_FINDINGS_INCOHERENT',
      details: { overallVerdict: 'accept', blockingIssueCount: input.blockingIssueCount },
    };
  }
  return { ok: true };
}

function sectionPathsEqual(scope: MarkdownSectionPath, anchor: MarkdownSectionPath): boolean {
  return (
    scope.length === anchor.length &&
    scope.every((part, index) => {
      const candidate = anchor[index];
      return (
        candidate?.headingDepth === part.headingDepth &&
        candidate.siblingIndex === part.siblingIndex &&
        candidate.headingText === part.headingText
      );
    })
  );
}

function artifactAnchorIntersectsScope(
  anchor: ArtifactSectionAnchor,
  scope: Extract<ReviewSubjectScopeValue, { readonly kind: 'artifact' }>,
): boolean {
  return (
    anchor.artifactKind === scope.artifact.kind &&
    anchor.artifactDigest === scope.artifact.digest &&
    scope.artifact.sectionPaths.some((sectionPath) =>
      sectionPathsEqual(sectionPath, anchor.sectionPath),
    )
  );
}

function relationIntersectsScope(
  relation: FindingRelationValue,
  scope: ReviewSubjectScopeValue,
): boolean {
  if (scope.kind === 'repository_change') {
    return relation.subjectAnchors.some(
      (anchor) =>
        anchor.kind === 'repository_location' &&
        scope.paths.includes(anchor.location.path) &&
        scope.revisions.includes(anchor.location.revision),
    );
  }
  if (scope.kind === 'artifact') {
    return relation.subjectAnchors.some(
      (anchor) =>
        anchor.kind === 'artifact_section' && artifactAnchorIntersectsScope(anchor, scope),
    );
  }
  return false;
}

function hasUnavailableRepositoryRevision(
  relation: FindingRelationValue,
  scope: Extract<ReviewSubjectScopeValue, { readonly kind: 'repository_change' }>,
): boolean {
  return (
    relation.subjectAnchors.some(
      (anchor) =>
        anchor.kind === 'repository_location' &&
        !scope.revisions.includes(anchor.location.revision),
    ) || relation.evidenceLocations.some((location) => !scope.revisions.includes(location.revision))
  );
}

function hasValidSubjectAnchorsAndInvalidEvidenceLocations(relation: unknown): boolean {
  if (!relation || typeof relation !== 'object' || Array.isArray(relation)) return false;
  const { subjectAnchors, evidenceLocations } = relation as Record<string, unknown>;
  return (
    ReviewSubjectAnchor.array().min(1).safeParse(subjectAnchors).success &&
    !RepositoryLocation.array().safeParse(evidenceLocations).success
  );
}

function relationFailureCode(
  relation: unknown,
): 'REVIEW_EVIDENCE_LOCATION_INVALID' | 'REVIEW_FINDING_SUBJECT_ANCHOR_REQUIRED' {
  if (hasValidSubjectAnchorsAndInvalidEvidenceLocations(relation)) {
    return 'REVIEW_EVIDENCE_LOCATION_INVALID';
  }
  return 'REVIEW_FINDING_SUBJECT_ANCHOR_REQUIRED';
}

/**
 * Validate that every finding has a schema-valid relation and at least one
 * subject anchor in the frozen scope. Evidence locations are intentionally not
 * scope-matched: evidence may be external, but must be a structured valid
 * repository or artifact anchor.
 */
export function validateReviewFindingsScope(input: {
  readonly findings: readonly FindingWithRelation[];
  readonly reviewSubjectScope?: ReviewSubjectScopeValue;
}): ReviewFindingsScopeResult {
  const parsedScope =
    input.reviewSubjectScope && ReviewSubjectScope.safeParse(input.reviewSubjectScope);
  if (!parsedScope || !parsedScope.success || parsedScope.data.kind === 'unavailable') {
    return {
      ok: false,
      code: 'REVIEW_SUBJECT_SCOPE_UNAVAILABLE',
      details: { outOfScopeFindingIndexes: [], reviewSubjectScope: undefined },
    };
  }

  const repositoryScope =
    parsedScope.data.kind === 'repository_change' ? parsedScope.data : undefined;
  const outOfScopeFindingIndexes: number[] = [];
  for (const [index, finding] of input.findings.entries()) {
    const relation = FindingRelation.safeParse(finding.relation);
    if (!relation.success) {
      return {
        ok: false,
        code: relationFailureCode(finding.relation),
        details: { outOfScopeFindingIndexes: [], reviewSubjectScope: parsedScope.data },
      };
    }
    if (repositoryScope && hasUnavailableRepositoryRevision(relation.data, repositoryScope)) {
      return {
        ok: false,
        code: 'REVIEW_REPOSITORY_REVISION_UNAVAILABLE',
        details: { outOfScopeFindingIndexes: [index], reviewSubjectScope: parsedScope.data },
      };
    }
    if (!relationIntersectsScope(relation.data, parsedScope.data))
      outOfScopeFindingIndexes.push(index);
  }

  if (outOfScopeFindingIndexes.length > 0) {
    return {
      ok: false,
      code: 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE',
      details: { outOfScopeFindingIndexes, reviewSubjectScope: parsedScope.data },
    };
  }
  return { ok: true };
}
