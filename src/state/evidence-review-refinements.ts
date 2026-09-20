/**
 * @module evidence-review-refinements
 * @description Cross-record superRefine refinements for review obligations and
 *              assurance state.
 *
 * Extracted from evidence-review.ts along the refinement boundary to keep both
 * modules within the file-size budget. These are the ONLY structural
 * validators for frozen repository authority coherence:
 *
 * - peer review obligations require a frozen reviewSubject whose
 *   subjectDigest matches;
 * - frozen repository authorities must be structurally consistent.
 *
 * Assurance-level refinements live in `evidence-review-assurance-refinements.ts`.
 *
 * Callback parameter types are STRUCTURAL (deliberately not imported from
 * evidence-review.ts) so this module stays acyclic and the superRefine
 * inference chains cleanly.
 *
 * @version v1
 */

import { z } from 'zod';
import type { FrozenRepositoryAuthority } from './evidence-review-authority.js';
import type { ReviewRepositoryIdentity as RepositoryIdentityValue } from './evidence-review-subject.js';
import type { ReviewRepositoryRevisionProvenance as ProvenanceValue } from './evidence-primitives.js';
import { verifyFrozenRepositoryAuthority } from './evidence-review-authority.js';

/** Minimal structural obligation shape the refinements operate on. */
export interface ObligationRefinementShape {
  readonly obligationType: string;
  readonly obligationId: string;
  readonly subjectDigest: string;
  readonly criteriaVersion: string;
  readonly status: string;
  readonly invocationId: string | null;
  readonly fulfilledAt?: string | null | undefined;
  readonly consumedAt?: string | null | undefined;
  readonly reviewMaterial?:
    | {
        readonly subjectDigest: string;
      }
    | null
    | undefined;
  readonly reviewSubject?:
    | {
        readonly kind: string;
        readonly subjectDigest: string;
        readonly baseRepository?: RepositoryIdentityValue | undefined;
        readonly headRepository?: RepositoryIdentityValue | null | undefined;
        readonly baseSha?: string | undefined;
        readonly headSha?: string | undefined;
      }
    | null
    | undefined;
  readonly repositoryAuthority?: FrozenRepositoryAuthority | undefined;
  readonly repositoryEvidenceFreeze?:
    | {
        readonly kind: 'available' | 'unavailable';
        readonly reason?: string | undefined;
      }
    | null
    | undefined;
  readonly repositoryRevisionProvenance?: ProvenanceValue | undefined;
  readonly reviewSubjectScope?:
    | {
        readonly kind: string;
        readonly implementationDigest?: string | undefined;
      }
    | null
    | undefined;
}

/**
 * Implementation obligations bind their scope kind AND digest to the frozen
 * implementation subject.
 */
export function refineImplementationScopeSubjectCoherence(
  obligation: ObligationRefinementShape,
  context: z.RefinementCtx,
): void {
  const scope = obligation.reviewSubjectScope;
  if (obligation.obligationType === 'implement') {
    if (scope?.kind !== 'implementation') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewSubjectScope'],
        message: 'implement obligations require an implementation reviewSubjectScope.',
      });
      return;
    }
    if (scope.implementationDigest !== obligation.subjectDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewSubjectScope'],
        message:
          'implementation reviewSubjectScope digest must equal the obligation subject digest',
      });
    }
    return;
  }
  if (scope?.kind === 'implementation') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewSubjectScope'],
      message: 'only implement obligations may carry an implementation reviewSubjectScope.',
    });
  }
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

/** Peer review obligations require a frozen, digest-matching subject. */
export function refinePeerReviewSubject(
  obligation: ObligationRefinementShape,
  context: z.RefinementCtx,
): void {
  if (obligation.obligationType !== 'review') return;
  if (!obligation.reviewSubject) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewSubject'],
      message: 'Peer review obligations require a frozen reviewSubject.',
    });
    return;
  }
  if (obligation.subjectDigest !== obligation.reviewSubject.subjectDigest) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subjectDigest'],
      message: 'Peer review obligation subjectDigest must match reviewSubject.subjectDigest.',
    });
  }
}

/** Frozen repository authorities must be structurally consistent. */
export function refineAuthorityStructure(
  obligation: ObligationRefinementShape,
  context: z.RefinementCtx,
): void {
  refineImplementationScopeSubjectCoherence(obligation, context);
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

function sameRepositoryIdentity(a: RepositoryIdentityValue, b: RepositoryIdentityValue): boolean {
  if ('kind' in a) return 'kind' in b && a.rootCommitDigest === b.rootCommitDigest;
  return !('kind' in b) && a.host === b.host && a.owner === b.owner && a.name === b.name;
}

/** plan/architecture obligations may only carry a frozen repository context authority. */
function refineContextObligationAuthority(
  authority: FrozenRepositoryAuthority | undefined,
  context: z.RefinementCtx,
): void {
  if (authority && authority.kind !== 'context') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repositoryAuthority'],
      message: 'plan/architecture obligations may only carry a frozen repository context authority',
    });
  }
}

/** implement obligations may only carry a frozen candidate-pair repository authority. */
function refineImplementationObligationAuthority(
  authority: FrozenRepositoryAuthority | undefined,
  context: z.RefinementCtx,
): void {
  if (authority && authority.kind !== 'candidate_pair') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repositoryAuthority'],
      message: 'implement obligations may only carry a frozen candidate-pair repository authority',
    });
  }
}

type RepositoryAuthorityPair = Exclude<FrozenRepositoryAuthority, { kind: 'context' }>;

function frozenAuthorityMatchesRepositorySubject(
  authority: RepositoryAuthorityPair,
  baseRepository: RepositoryIdentityValue,
  headIdentity: RepositoryIdentityValue,
  baseSha: string | undefined,
  headSha: string | undefined,
): boolean {
  return (
    sameRepositoryIdentity(authority.base.repositoryIdentity, baseRepository) &&
    sameRepositoryIdentity(authority.head.repositoryIdentity, headIdentity) &&
    authority.base.objectSha === baseSha &&
    authority.head.objectSha === headSha
  );
}

/** review obligations ↔ frozen repository authority coherence by subject kind. */
function refineReviewObligationAuthority(
  obligation: ObligationRefinementShape,
  context: z.RefinementCtx,
): void {
  const authority = obligation.repositoryAuthority;
  const subject = obligation.reviewSubject;
  if (!subject || subject.kind === 'content') {
    if (authority) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repositoryAuthority'],
        message: 'content review obligations must not carry repository authority',
      });
    }
    return;
  }
  if (subject.kind !== 'repository_change') return;
  if (!authority) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repositoryAuthority'],
      message: 'repository_change review obligations require frozen repository authority',
    });
    return;
  }
  if (authority.kind === 'context') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repositoryAuthority'],
      message:
        'repository_change review obligations require a candidate-pair or fork-pair repository authority',
    });
    return;
  }
  const baseRepository = subject.baseRepository;
  const headIdentity = subject.headRepository ?? baseRepository;
  if (!baseRepository || !headIdentity) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewSubject'],
      message: 'repository_change review subjects require base repository identity',
    });
    return;
  }
  if (
    !frozenAuthorityMatchesRepositorySubject(
      authority,
      baseRepository,
      headIdentity,
      subject.baseSha,
      subject.headSha,
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repositoryAuthority'],
      message:
        'frozen repository authority must exactly match the frozen reviewSubject (identity and SHA)',
    });
  }
}

/** Obligation type ↔ frozen repository authority coherence. */
export function refineObligationRepositoryAuthorityCoherence(
  obligation: ObligationRefinementShape,
  context: z.RefinementCtx,
): void {
  const obligationType = obligation.obligationType;
  if (obligationType === 'plan' || obligationType === 'architecture') {
    refineContextObligationAuthority(obligation.repositoryAuthority, context);
    return;
  }
  if (obligationType === 'implement') {
    refineImplementationObligationAuthority(obligation.repositoryAuthority, context);
    return;
  }
  if (obligationType === 'review') {
    refineReviewObligationAuthority(obligation, context);
  }
}

/** Durable freeze outcome must agree with actual frozen repository authority. */
export function refineRepositoryEvidenceFreezeCoherence(
  obligation: ObligationRefinementShape,
  context: z.RefinementCtx,
): void {
  const freeze = obligation.repositoryEvidenceFreeze;
  const contextFreezeObligation =
    obligation.obligationType === 'plan' || obligation.obligationType === 'architecture';
  if (!freeze) {
    if (contextFreezeObligation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repositoryEvidenceFreeze'],
        message: 'plan/architecture obligations require a repository evidence freeze outcome',
      });
    }
    return;
  }
  if (!contextFreezeObligation) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repositoryEvidenceFreeze'],
      message: 'only plan/architecture obligations carry a repository evidence freeze outcome',
    });
    return;
  }
  if (freeze.kind === 'available' && !obligation.repositoryAuthority) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repositoryEvidenceFreeze'],
      message:
        'repositoryEvidenceFreeze claims an available repository freeze but the obligation carries no frozen repository authority',
    });
    return;
  }
  if (freeze.kind === 'unavailable' && obligation.repositoryAuthority) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repositoryEvidenceFreeze'],
      message:
        'repositoryEvidenceFreeze records an unavailable repository freeze but the obligation carries a frozen repository authority',
    });
  }
}
