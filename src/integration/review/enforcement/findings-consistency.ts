/**
 * @module integration/review/enforcement/findings-consistency
 * @description Canonical consistency invariants for structured review findings.
 */

import {
  classifyRepositoryPath,
  FindingRelation,
  RepositoryLocation,
  ReviewSubjectAnchor,
  ReviewSubjectScope,
  type ArtifactSectionAnchor,
  type FindingRelation as FindingRelationValue,
  type MarkdownSectionPath,
  type ReviewRepositoryRevisionProvenance,
  type ReviewSubjectScope as ReviewSubjectScopeValue,
} from '../../../state/evidence-review.js';
import type { ReviewObligation } from '../../../state/evidence.js';

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
        | 'REVIEW_EVIDENCE_LOCATION_ESCAPES_REPOSITORY'
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
  if (scope.kind === 'implementation') {
    return relation.subjectAnchors.some(
      (anchor) =>
        anchor.kind === 'implementation' &&
        anchor.implementationDigest === scope.implementationDigest,
    );
  }
  if (scope.kind === 'content') {
    return relation.subjectAnchors.some(
      (anchor) =>
        anchor.kind === 'content' &&
        anchor.subjectDigest === scope.subjectDigest &&
        (anchor.range === undefined ||
          (anchor.range.startLine <= scope.lineCount &&
            (anchor.range.endLine === undefined || anchor.range.endLine <= scope.lineCount))),
    );
  }
  return false;
}

function hasUnavailableScopedRepositoryRevision(
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

function hasUnavailableFrozenRepositoryRevision(
  relation: FindingRelationValue,
  provenance: ReviewRepositoryRevisionProvenance | undefined,
): boolean {
  const locations = [
    ...relation.subjectAnchors.flatMap((anchor) =>
      anchor.kind === 'repository_location' ? [anchor.location] : [],
    ),
    ...relation.evidenceLocations,
  ];
  return locations.some(
    (location) =>
      provenance?.kind !== 'available' ||
      (location.revision === 'head' ? !provenance.headSha : !provenance.baseSha),
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

function hasEscapingEvidenceLocation(relation: unknown): boolean {
  if (!relation || typeof relation !== 'object' || Array.isArray(relation)) return false;
  const { evidenceLocations } = relation as Record<string, unknown>;
  if (!Array.isArray(evidenceLocations)) return false;
  return evidenceLocations.some((location) => {
    if (!location || typeof location !== 'object' || Array.isArray(location)) return false;
    const { path } = location as Record<string, unknown>;
    return typeof path === 'string' && classifyRepositoryPath(path).kind === 'escapes_repository';
  });
}

function relationFailureCode(
  relation: unknown,
):
  | 'REVIEW_EVIDENCE_LOCATION_ESCAPES_REPOSITORY'
  | 'REVIEW_EVIDENCE_LOCATION_INVALID'
  | 'REVIEW_FINDING_SUBJECT_ANCHOR_REQUIRED' {
  if (hasValidSubjectAnchorsAndInvalidEvidenceLocations(relation)) {
    return hasEscapingEvidenceLocation(relation)
      ? 'REVIEW_EVIDENCE_LOCATION_ESCAPES_REPOSITORY'
      : 'REVIEW_EVIDENCE_LOCATION_INVALID';
  }
  return 'REVIEW_FINDING_SUBJECT_ANCHOR_REQUIRED';
}

/**
 * Validate that every finding has a schema-valid relation and at least one
 * subject anchor in the frozen scope. Evidence locations are intentionally not
 * scope-matched: evidence may be external, but must be a structured valid
 * repository or artifact anchor.
 */
// eslint-disable-next-line complexity -- independent schema, provenance, and subject-scope checks fail closed.
export function validateReviewFindingsScope(input: {
  readonly findings: readonly FindingWithRelation[];
  readonly reviewSubjectScope?: ReviewSubjectScopeValue;
  readonly repositoryRevisionProvenance?: ReviewRepositoryRevisionProvenance;
}): ReviewFindingsScopeResult {
  const parsedScope =
    input.reviewSubjectScope && ReviewSubjectScope.safeParse(input.reviewSubjectScope);
  const repositoryScope =
    parsedScope?.success && parsedScope.data.kind === 'repository_change'
      ? parsedScope.data
      : undefined;
  const outOfScopeFindingIndexes: number[] = [];
  for (const [index, finding] of input.findings.entries()) {
    const relation = FindingRelation.safeParse(finding.relation);
    if (!relation.success) {
      return {
        ok: false,
        code: relationFailureCode(finding.relation),
        details: { outOfScopeFindingIndexes: [], reviewSubjectScope: parsedScope?.data },
      };
    }
    if (hasUnavailableFrozenRepositoryRevision(relation.data, input.repositoryRevisionProvenance)) {
      return {
        ok: false,
        code: 'REVIEW_REPOSITORY_REVISION_UNAVAILABLE',
        details: { outOfScopeFindingIndexes: [index], reviewSubjectScope: parsedScope?.data },
      };
    }
    if (!parsedScope || !parsedScope.success || parsedScope.data.kind === 'unavailable') {
      return {
        ok: false,
        code: 'REVIEW_SUBJECT_SCOPE_UNAVAILABLE',
        details: { outOfScopeFindingIndexes: [], reviewSubjectScope: undefined },
      };
    }
    if (repositoryScope && hasUnavailableScopedRepositoryRevision(relation.data, repositoryScope)) {
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
      details: { outOfScopeFindingIndexes, reviewSubjectScope: parsedScope?.data },
    };
  }
  return { ok: true };
}

/**
 * Subject-identity cross-check (defense in depth): the obligation type
 * determines the required subject-scope class — never the persisted scope
 * kind. Plan/architecture obligations MUST carry an artifact scope whose
 * artifactKind and digest are bound to the obligation subject identity;
 * other obligation types MUST NOT carry an artifact scope.
 */
export function artifactScopeSubjectIdentityMatches(obligation: ReviewObligation): boolean {
  const isArtifactType =
    obligation.obligationType === 'plan' || obligation.obligationType === 'architecture';
  if (!isArtifactType) {
    return obligation.reviewSubjectScope?.kind !== 'artifact';
  }
  const scope = obligation.reviewSubjectScope;
  if (scope?.kind !== 'artifact') return false;
  const expectedKind = obligation.obligationType === 'plan' ? 'plan' : 'adr';
  return scope.artifact.kind === expectedKind && scope.artifact.digest === obligation.subjectDigest;
}
