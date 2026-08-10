/**
 * @module evidence-impl
 * @description Implementation evidence schemas — /implement output and implementation review.
 *
 * @version v2
 */

import { z } from 'zod';
import { LoopVerdict, RevisionDelta } from './evidence-primitives.js';
import { ImplementationCandidate } from './evidence-candidate.js';

/** Evidence produced by /implement — bound to exactly one immutable candidate. */
export const ImplEvidence = z
  .object({
    /** The immutable repository candidate from which all implementation identity is derived. */
    candidate: ImplementationCandidate,
    /** Task-owned domain files (governance classification, not a git fact). */
    domainFiles: z.array(z.string()).readonly(),
    executedAt: z.string().datetime(),
  })
  .strict()
  .readonly();
export type ImplEvidence = z.infer<typeof ImplEvidence>;

/**
 * Result of an implementation review iteration (IMPL_REVIEW phase).
 * Same convergence logic as SelfReviewLoop: digest-stop.
 *
 * `prevDigest` and `currDigest` are ImplementationCandidate.candidateDigest values.
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
