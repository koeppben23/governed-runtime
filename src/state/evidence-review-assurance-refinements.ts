/**
 * @module evidence-review-assurance-refinements
 * @description Assurance-level cross-record superRefine refinements for the
 *              review-assurance state.
 *
 * These are the structural validators that span whole assurance records:
 * attempt Discovery governance, canonical invocation linkage, identity
 * uniqueness, and persisted provenance coherence.
 *
 * Callback parameter types are STRUCTURAL (the obligation shape is imported as
 * a type from `evidence-review-refinements.ts`) so this module stays acyclic
 * and the superRefine inference chains cleanly.
 *
 * @version v1
 */

import { z } from 'zod';
import type { ObligationRefinementShape } from './evidence-review-refinements.js';
import {
  deriveRepositoryRevisionProvenance,
  hasFrozenRepositoryAuthority,
} from './evidence-review-authority.js';

/** Minimal structural attempt shape for the Discovery-coherence refinement. */
export interface AttemptRefinementShape {
  readonly attemptId: string;
  readonly obligationId: string;
  readonly obligationType: string;
  readonly subjectDigest: string;
  readonly ordinal: number;
  readonly status: string;
  readonly childSessionId?: string | undefined;
  readonly completedAt?: string | undefined;
  readonly observationCapability?: string | undefined;
  readonly rejectionReason?: string | undefined;
  readonly createdAt: string;
  readonly origin: {
    readonly kind: string;
    readonly predecessorAttemptId?: string | undefined;
    readonly triggerReason?: string | undefined;
  };
  readonly repositoryDiscovery: { readonly kind: 'repository' | 'not_applicable' };
}

/** Minimal structural assurance shape for the cross-record refinements. */
export interface AssuranceRefinementShape {
  readonly obligations: readonly ObligationRefinementShape[];
  readonly invocations: readonly {
    readonly invocationId: string;
    readonly obligationId: string;
    readonly obligationType: string;
    readonly childSessionId: string;
    readonly attemptId?: string | undefined;
    readonly invocationMode?: string | undefined;
    readonly source?: string | undefined;
    readonly hostVisible?: boolean | undefined;
    readonly transcriptNavigable?: boolean | undefined;
    readonly promptHash: string;
    readonly canonicalPromptDigest?: string | undefined;
    readonly consumedByObligationId?: string | null | undefined;
    readonly reviewOutputMode?: string | undefined;
    readonly structuredOutputUsed?: boolean | undefined;
    readonly reviewAssuranceLevel?: string | undefined;
  }[];
  readonly attempts: readonly AttemptRefinementShape[];
  readonly dispatches: readonly {
    readonly dispatchId: string;
    readonly attemptId: string;
    readonly obligationId: string;
    readonly hostCallId: string;
    readonly canonicalPromptDigest: string;
    readonly dispatchStatus: string;
    readonly completedAt?: string | undefined;
  }[];
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
    if (attempt.repositoryDiscovery.kind === 'repository' && !attempt.observationCapability) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `repository-governed attempt ${attempt.attemptId} requires an observation capability`,
      });
      return;
    }
    if (attempt.repositoryDiscovery.kind !== 'repository' && attempt.observationCapability) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `non-repository attempt ${attempt.attemptId} must not carry an observation capability`,
      });
      return;
    }
    const obligation = obligationsById.get(attempt.obligationId);
    if (!obligation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `attempt ${attempt.attemptId} references unknown obligation ${attempt.obligationId}`,
      });
      return;
    }
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

/** The native Task + structured follow-up is the only sanctioned review invocation generation. */
function hasCanonicalInvocationShape(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): boolean {
  for (const invocation of assurance.invocations) {
    if (
      invocation.invocationMode !== 'native_task_structured_followup' ||
      invocation.reviewOutputMode !== 'structured_output' ||
      invocation.reviewAssuranceLevel !== 'structured_high' ||
      invocation.structuredOutputUsed !== true ||
      invocation.source !== 'host-orchestrated' ||
      invocation.hostVisible !== true ||
      invocation.transcriptNavigable !== true
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocations'],
        message:
          'Review invocation evidence requires one visible, navigable native Task with structured host-captured output.',
      });
      return false;
    }
  }
  return true;
}

function hasBoundAttemptLinkage(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): boolean {
  const attemptsByAttemptId = new Map(
    assurance.attempts.map((attempt) => [attempt.attemptId, attempt]),
  );
  for (const invocation of assurance.invocations) {
    const attemptId = invocation.attemptId;
    if (!attemptId) continue;
    const attempt = attemptsByAttemptId.get(attemptId);
    if (!attempt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocations'],
        message: `invocation ${invocation.invocationId} references unknown attempt ${invocation.attemptId}`,
      });
      return false;
    }
    if (
      attempt.obligationId !== invocation.obligationId ||
      attempt.obligationType !== invocation.obligationType
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocations'],
        message: `invocation ${invocation.invocationId} attempt ${attempt.attemptId} belongs to a different obligation`,
      });
      return false;
    }
    if (attempt.status !== 'bound' && attempt.status !== 'rejected') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocations'],
        message: `invocation ${invocation.invocationId} attempt ${attempt.attemptId} has no bound lifecycle`,
      });
      return false;
    }
    if (attempt.childSessionId !== invocation.childSessionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocations'],
        message: `invocation ${invocation.invocationId} child session does not match the bound attempt`,
      });
      return false;
    }
    if (!attempt.completedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocations'],
        message: `invocation ${invocation.invocationId} bound attempt is missing completedAt`,
      });
      return false;
    }
  }
  return true;
}

function hasObligationBackReference(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): boolean {
  const invocationsByInvocationId = new Map(
    assurance.invocations.map((invocation) => [invocation.invocationId, invocation]),
  );
  for (const obligation of assurance.obligations) {
    if (obligation.invocationId) {
      const linked = invocationsByInvocationId.get(obligation.invocationId);
      if (!linked) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['obligations'],
          message: `obligation ${obligation.obligationId} references unknown invocation ${obligation.invocationId}`,
        });
        return false;
      }
      if (
        linked.obligationId !== obligation.obligationId ||
        linked.obligationType !== obligation.obligationType
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['invocations'],
          message: `invocation ${linked.invocationId} is the canonical linkage of obligation ${obligation.obligationId} but back-references obligation ${linked.obligationId} (type ${linked.obligationType})`,
        });
        return false;
      }
    }
    if (
      (obligation.status === 'fulfilled' || obligation.status === 'consumed') &&
      (!obligation.invocationId || !obligation.fulfilledAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['obligations'],
        message: `obligation ${obligation.obligationId} is ${obligation.status} without invocation lineage and fulfilledAt`,
      });
      return false;
    }
    if (obligation.status === 'consumed' && !obligation.consumedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['obligations'],
        message: `consumed obligation ${obligation.obligationId} is missing consumedAt`,
      });
      return false;
    }
  }
  return true;
}

function hasConsumedByInvariant(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): boolean {
  for (const invocation of assurance.invocations) {
    if (
      invocation.consumedByObligationId != null &&
      invocation.consumedByObligationId !== invocation.obligationId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocations'],
        message: `invocation ${invocation.invocationId} consumedByObligationId must equal its own obligationId`,
      });
      return false;
    }
  }
  return true;
}

/**
 * Canonical linkage coherence. The native Task + structured follow-up is the
 * only sanctioned review invocation generation.
 */
export function refineAssuranceInvocationLinkageCoherence(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): void {
  if (!hasCanonicalInvocationShape(assurance, context)) return;
  if (!hasBoundAttemptLinkage(assurance, context)) return;
  if (!hasObligationBackReference(assurance, context)) return;
  if (!hasConsumedByInvariant(assurance, context)) return;
}

/** Canonical authority identifiers must be unique. */
export function refineAssuranceIdentityUniqueness(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): void {
  const obligationIds = new Set<string>();
  for (const obligation of assurance.obligations) {
    if (obligationIds.has(obligation.obligationId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['obligations'],
        message: `duplicate obligationId ${obligation.obligationId} — an obligation identity must be unique across the assurance state`,
      });
      return;
    }
    obligationIds.add(obligation.obligationId);
  }
  const invocationIds = new Set<string>();
  for (const invocation of assurance.invocations) {
    if (invocationIds.has(invocation.invocationId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocations'],
        message: `duplicate invocationId ${invocation.invocationId} — an invocation identity must be unique across the assurance state`,
      });
      return;
    }
    invocationIds.add(invocation.invocationId);
  }
  const attemptIds = new Set<string>();
  for (const attempt of assurance.attempts) {
    if (attemptIds.has(attempt.attemptId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `duplicate attemptId ${attempt.attemptId} — an attempt identity must be unique across the assurance state`,
      });
      return;
    }
    attemptIds.add(attempt.attemptId);
  }
}

/** Persisted revision provenance must equal the derivation from frozen authority. */
export function refineAssuranceProvenanceCoherence(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): void {
  for (const obligation of assurance.obligations) {
    if (!obligation.repositoryAuthority) continue;
    const derived = deriveRepositoryRevisionProvenance(obligation);
    if (derived.kind === 'unavailable') continue;
    const persisted = obligation.repositoryRevisionProvenance;
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
