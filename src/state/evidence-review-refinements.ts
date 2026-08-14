/**
 * @module evidence-review-refinements
 * @description Cross-record superRefine refinements for review obligations and
 *              assurance state.
 *
 * Extracted from evidence-review.ts along the refinement boundary to keep both
 * modules within the file-size budget. These are the ONLY structural
 * validators for frozen repository authority coherence:
 *
 * - standalone review obligations require a frozen reviewSubject whose
 *   subjectDigest matches;
 * - frozen repository authorities must be structurally consistent;
 * - an attempt's Discovery variant must match its obligation's frozen
 *   repository governance;
 * - a persisted provenance projection must equal the canonical derivation
 *   from frozen authority.
 *
 * Callback parameter types are STRUCTURAL (deliberately not imported from
 * evidence-review.ts) so this module stays acyclic and the superRefine
 * inference chains cleanly.
 *
 * @version v1
 */

import { z } from 'zod';
import type { FrozenRepositoryAuthority } from './evidence-review-authority.js';
import type { ReviewRepositoryRevisionProvenance as ProvenanceValue } from './evidence-primitives.js';
import {
  deriveRepositoryRevisionProvenance,
  hasFrozenRepositoryAuthority,
  verifyFrozenRepositoryAuthority,
} from './evidence-review-authority.js';

/** Minimal structural obligation shape the refinements operate on. */
export interface ObligationRefinementShape {
  readonly obligationType: string;
  readonly obligationId: string;
  readonly subjectDigest: string;
  readonly criteriaVersion: string;
  readonly reviewMaterial?: {
    readonly subjectDigest: string;
  } | null;
  readonly reviewSubject?: {
    readonly kind: string;
    readonly subjectDigest: string;
  } | null;
  readonly repositoryAuthority?: FrozenRepositoryAuthority;
  readonly repositoryRevisionProvenance?: ProvenanceValue;
}

/** Minimal structural attempt shape for the Discovery-coherence refinement. */
export interface AttemptRefinementShape {
  readonly attemptId: string;
  readonly obligationId: string;
  readonly repositoryDiscovery: { readonly kind: 'repository' | 'not_applicable' };
}

/** Minimal structural assurance shape for the cross-record refinements. */
export interface AssuranceRefinementShape {
  readonly obligations: readonly ObligationRefinementShape[];
  readonly attempts: readonly AttemptRefinementShape[];
}

/** Frozen material must belong to the same subject as its obligation. */
export function refineReviewMaterialSubject(
  obligation: ObligationRefinementShape,
  context: z.RefinementCtx,
): void {
  if (
    !obligation.reviewMaterial ||
    obligation.reviewMaterial.subjectDigest === obligation.subjectDigest
  ) {
    return;
  }
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['reviewMaterial', 'subjectDigest'],
    message: 'Review obligation reviewMaterial.subjectDigest must match obligation.subjectDigest.',
  });
}

/** Material authority is mandatory from the p41 generation onward. */
export function refineCurrentGenerationMaterial(
  obligation: ObligationRefinementShape,
  context: z.RefinementCtx,
): void {
  if (obligation.criteriaVersion !== 'p41-v1' || obligation.reviewMaterial) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['reviewMaterial'],
    message: 'p41 review obligations require frozen reviewMaterial.',
  });
}

/** Standalone review obligations require a frozen, digest-matching subject. */
export function refineStandaloneSubject(
  obligation: ObligationRefinementShape,
  context: z.RefinementCtx,
): void {
  if (obligation.obligationType !== 'review') return;
  if (!obligation.reviewSubject) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewSubject'],
      message: 'Standalone review obligations require a frozen reviewSubject.',
    });
    return;
  }
  if (obligation.subjectDigest !== obligation.reviewSubject.subjectDigest) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subjectDigest'],
      message: 'Standalone review obligation subjectDigest must match reviewSubject.subjectDigest.',
    });
  }
}

/** Frozen repository authorities must be structurally consistent. */
export function refineAuthorityStructure(
  obligation: ObligationRefinementShape,
  context: z.RefinementCtx,
): void {
  if (!obligation.repositoryAuthority) return;
  const structural = verifyFrozenRepositoryAuthority(obligation.repositoryAuthority);
  if (structural) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repositoryAuthority'],
      message: `Invalid frozen repository authority: ${structural}`,
    });
  }
}

/** An attempt's Discovery variant must match its obligation's frozen governance. */
export function refineAssuranceDiscoveryCoherence(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): void {
  const obligationsById = new Map(
    assurance.obligations.map((obligation) => [obligation.obligationId, obligation]),
  );
  for (const attempt of assurance.attempts) {
    const obligation = obligationsById.get(attempt.obligationId);
    if (!obligation) continue;
    const repositoryGoverned = hasFrozenRepositoryAuthority(obligation);
    if (repositoryGoverned && attempt.repositoryDiscovery.kind !== 'repository') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `attempt ${attempt.attemptId} must carry a repository Discovery snapshot for a repository-governed obligation`,
      });
      return;
    }
    if (!repositoryGoverned && attempt.repositoryDiscovery.kind !== 'not_applicable') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `attempt ${attempt.attemptId} must carry not_applicable Discovery for a non-repository-governed obligation`,
      });
      return;
    }
  }
}

/**
 * A persisted provenance projection must equal the canonical derivation from
 * frozen authority. Divergent projections are authority drift, not legacy data.
 */
export function refineAssuranceProvenanceCoherence(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): void {
  for (const obligation of assurance.obligations) {
    if (!obligation.repositoryAuthority) continue;
    const derived = deriveRepositoryRevisionProvenance(obligation);
    if (derived.kind === 'unavailable') continue;
    const persisted = obligation.repositoryRevisionProvenance as ProvenanceValue | undefined;
    if (
      persisted &&
      (persisted.kind !== 'available' ||
        persisted.headSha !== derived.headSha ||
        persisted.baseSha !== derived.baseSha)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['obligations'],
        message: `obligation ${obligation.obligationId} carries a provenance projection that diverges from its frozen repository authority`,
      });
      return;
    }
  }
}
