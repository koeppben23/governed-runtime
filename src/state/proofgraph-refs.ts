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
 * Reproducible EVIDENCE about a claim. Evidence proves or falsifies a claim but
 * never confers governing provenance.
 */
export const ClaimEvidenceRef = z.discriminatedUnion('kind', [
  ValidationAttemptRef,
  ImplementationRef,
  ContentRef,
]);
export type ClaimEvidenceRef = z.infer<typeof ClaimEvidenceRef>;
