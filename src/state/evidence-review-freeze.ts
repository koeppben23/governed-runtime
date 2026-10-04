/**
 * @module state/evidence-review-freeze
 * @description Durable plan/architecture repository-context freeze outcome,
 *              frozen onto review obligations.
 *
 * Extracted from evidence-review.ts to keep the obligation schema within the
 * production file-size budget. The public surface stays re-exported from
 * evidence-review.ts.
 *
 * @version v1
 */

import { z } from 'zod';

/**
 * Why a plan/architecture repository-context freeze degraded. Distinct reasons
 * keep the degradation auditable instead of collapsing every cause into an
 * indistinguishable absence of authority.
 */
export const RepositoryEvidenceFreezeReason = z.enum([
  'repository_unavailable',
  'head_unavailable',
  'repository_identity_unavailable',
  'freeze_failed',
]);
export type RepositoryEvidenceFreezeReason = z.infer<typeof RepositoryEvidenceFreezeReason>;

/**
 * Durable outcome of the plan/architecture repository-context freeze, frozen
 * onto the obligation at creation time. `unavailable` never blocks the review
 * itself — repository evidence simply becomes unavailable — but the cause is
 * auditable in later continuations, restarts, re-emits, archives, and
 * forensics, not only in the immediate Mode-A response.
 */
export const RepositoryEvidenceFreeze = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('available'),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('unavailable'),
      reason: RepositoryEvidenceFreezeReason,
      diagnostic: z.string().min(1).optional(),
    })
    .strict()
    .readonly(),
]);
export type RepositoryEvidenceFreeze = z.infer<typeof RepositoryEvidenceFreeze>;
