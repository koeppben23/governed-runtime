/**
 * @module evidence-impl
 * @description Implementation evidence schemas — /implement output and implementation review.
 *
 * @version v1
 */

import { z } from 'zod';
import { LoopVerdict, RevisionDelta } from './evidence-primitives.js';

/** Evidence produced by /implement — what files were changed. */
export const ImplEvidence = z
  .object({
    changedFiles: z.array(z.string()),
    domainFiles: z.array(z.string()),
    digest: z.string().min(1),
    executedAt: z.string().datetime(),
  })
  .readonly();
export type ImplEvidence = z.infer<typeof ImplEvidence>;

/**
 * Result of an implementation review iteration (IMPL_REVIEW phase).
 * Same convergence logic as SelfReviewLoop: digest-stop.
 */
export const ImplReviewResult = z
  .object({
    iteration: z.number().int().nonnegative(),
    maxIterations: z.number().int().positive(),
    prevDigest: z.string().nullable(),
    currDigest: z.string().min(1),
    revisionDelta: RevisionDelta,
    verdict: LoopVerdict,
    executedAt: z.string().datetime(),
  })
  .readonly();
export type ImplReviewResult = z.infer<typeof ImplReviewResult>;
