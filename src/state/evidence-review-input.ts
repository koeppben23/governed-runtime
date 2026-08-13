/**
 * @module evidence-review-input
 * @description Strict reviewer-owned payload accepted before host provenance.
 */

import { z } from 'zod';
import { ChallengeResolutionVerdict, ReviewerChallengeInput } from './evidence-review-challenge.js';
import { ReviewFindingsObject } from './evidence-review.js';

/**
 * The reviewer cannot author execution identity, timestamps, or host-owned
 * attestation constants. Those fields are added only after this strict input
 * boundary accepts the reviewer-owned payload.
 */
export const ReviewerFindingsInput = ReviewFindingsObject.omit({
  reviewedBy: true,
  reviewedAt: true,
  reviewerClaimedAt: true,
  reviewerClaimedBy: true,
  attestation: true,
  challenges: true,
  challengeResolutionVerdicts: true,
})
  .extend({
    attestation: z.object({ toolObligationId: z.string().uuid() }).strict().readonly(),
    challenges: z.array(ReviewerChallengeInput).optional(),
    challengeResolutionVerdicts: z.array(ChallengeResolutionVerdict).optional(),
  })
  .strict()
  .readonly();
export type ReviewerFindingsInput = z.infer<typeof ReviewerFindingsInput>;
