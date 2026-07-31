/**
 * @module proofgraph-refs
 * @description Typed references for ProofGraph claims, split by role.
 *
 * The governing authority of a claim is deliberately a DIFFERENT type from the
 * executable evidence for a claim. This prevents an authority escalation where a
 * validation attempt (evidence) is treated as the normative source that makes a
 * claim a governing `fact`:
 *
 * - {@link ClaimAuthorityRef}: an approved source that may govern a claim - an
 *   approved ticket, an approved plan/ADR section, or an existing canonical
 *   authority. Only a resolved authority justifies classifying a claim as `fact`.
 * - {@link ClaimEvidenceRef}: reproducible evidence about a claim - a validation
 *   attempt, an implementation surface, or reviewed content. Evidence proves or
 *   falsifies; it never confers governing provenance.
 *
 * The evidence-side refs reuse the canonical digest-bound vocabulary from
 * `evidence-review.ts` rather than duplicating it.
 *
 * @version v1
 */

import { z } from 'zod';
import {
  PlanAdrSectionRef,
  ImplementationRef,
  ValidationAttemptRef,
  ContentRef,
} from './evidence-review.js';

/**
 * Reference to a concrete, immutable mutation-attempt record produced by
 * `flowguard_record_mutation_evidence`, for ONE opt-in profile.
 *
 * The `profileId` is part of the reference because a single recorded run covers
 * several profiles with different verdicts: a claim must state which profile's
 * survivor status it relies on, not merely which run happened.
 */
export const MutationAttemptRef = z
  .object({
    kind: z.literal('mutation_attempt'),
    attemptId: z.string().uuid(),
    profileId: z.string().min(1),
  })
  .readonly();
export type MutationAttemptRef = z.infer<typeof MutationAttemptRef>;

/** Reference to an approved ticket, bound to its digest. */
export const ApprovedTicketRef = z
  .object({
    kind: z.literal('approved_ticket'),
    ticketDigest: z.string().min(1),
  })
  .readonly();
export type ApprovedTicketRef = z.infer<typeof ApprovedTicketRef>;

/**
 * Reference to an existing canonical authority (e.g. an approved plan or ADR
 * as a whole, or a canonical source module), bound to a content digest.
 */
export const CanonicalAuthorityRef = z
  .object({
    kind: z.literal('canonical_authority'),
    /** Stable identifier of the authority (e.g. 'plan', 'architecture'). */
    authorityId: z.string().min(1),
    digest: z.string().min(1),
  })
  .readonly();
export type CanonicalAuthorityRef = z.infer<typeof CanonicalAuthorityRef>;

/**
 * A source that may GOVERN a claim. A claim whose provenance resolves to one of
 * these may be classified `fact`; a claim without a resolved authority is an
 * assumption and is surfaced as `NOT_VERIFIED`.
 */
export const ClaimAuthorityRef = z.discriminatedUnion('kind', [
  ApprovedTicketRef,
  PlanAdrSectionRef,
  CanonicalAuthorityRef,
]);
export type ClaimAuthorityRef = z.infer<typeof ClaimAuthorityRef>;

/**
 * Reference to a structural/schema input surface (a `surface_set` binding key).
 *
 * This is EVIDENCE, not authority: it names the surface whose consistency
 * assertion covers the claim. Freshness is resolved against the surface's
 * current canonical digest, so a passing assertion cannot prove indefinitely
 * after the surface changes.
 */
export const StructuralSurfaceRef = z
  .object({
    kind: z.literal('structural_surface'),
    surfaceId: z.string().min(1),
  })
  .readonly();
export type StructuralSurfaceRef = z.infer<typeof StructuralSurfaceRef>;

/**
 * Reference to an opt-in semantic mutation profile.
 *
 * EVIDENCE, not authority: it names the profile whose recorded mutation results
 * (survivor status) cover the claim. Mutation evidence is revision-bound to the
 * implementation digest, so it goes stale when the implementation changes.
 */
export const MutationProfileRef = z
  .object({
    kind: z.literal('mutation_profile'),
    profileId: z.string().min(1),
  })
  .readonly();
export type MutationProfileRef = z.infer<typeof MutationProfileRef>;

/**
 * Reproducible EVIDENCE about a claim. Evidence proves or falsifies a claim but
 * never confers governing provenance.
 */
export const ClaimEvidenceRef = z.discriminatedUnion('kind', [
  ValidationAttemptRef,
  ImplementationRef,
  ContentRef,
  StructuralSurfaceRef,
  MutationProfileRef,
  MutationAttemptRef,
]);
export type ClaimEvidenceRef = z.infer<typeof ClaimEvidenceRef>;
