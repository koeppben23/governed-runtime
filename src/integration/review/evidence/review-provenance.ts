/**
 * @module integration/review/review-provenance
 * @description Immutable branch review provenance — shared validators for
 *              obligation creation, invocation evidence, and transport paths.
 *
 * All review paths (tool, host-orchestrator, transport) consume the same
 * schemas so provenance invariants cannot drift between call sites.
 *
 * @version v1
 */

import { z } from 'zod';

import type { ReviewObligation } from '../../../state/evidence.js';

const SHA1_HEX = z.string().regex(/^[0-9a-f]{40,64}$/i);
const SHA256_HEX = z.string().regex(/^[0-9a-f]{64}$/i);

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const BranchReviewSourceSchema = z.object({
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  resolvedBranchSha: SHA1_HEX,
  resolvedBaseSha: SHA1_HEX,
});

export const BranchReviewProvenanceSchema = BranchReviewSourceSchema.extend({
  reviewedContentDigest: SHA256_HEX,
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type RequiredBranchReviewSource = z.infer<typeof BranchReviewSourceSchema>;
export type RequiredBranchReviewProvenance = z.infer<typeof BranchReviewProvenanceSchema>;

// ─── Error ───────────────────────────────────────────────────────────────────

class ReviewProvenanceError extends Error {
  readonly code = 'REVIEW_BRANCH_PROVENANCE_MISSING' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ReviewProvenanceError';
  }
}

// ─── Extractors ──────────────────────────────────────────────────────────────

export function getRequiredBranchReviewProvenance(
  obligation: ReviewObligation,
): RequiredBranchReviewProvenance {
  const parsed = BranchReviewProvenanceSchema.safeParse(obligation.metadata);
  if (!parsed.success) {
    throw new ReviewProvenanceError(
      'Branch review obligation does not contain valid provenance including content digest.',
    );
  }
  return parsed.data;
}
