/**
 * @module evidence-plan
 * @description Plan evidence schema — plan versions, plan record with history, and self-review loop.
 *
 * @version v1
 */

import { z } from 'zod';
import { LoopVerdict, RevisionDelta } from './evidence-primitives.js';
import { ReviewFindings } from './evidence-review.js';

/** A single plan version (immutable snapshot). */
export const PlanEvidence = z.object({
  body: z.string().min(1),
  digest: z.string().min(1),
  sections: z.array(z.string()),
  createdAt: z.string().datetime(),
});
export type PlanEvidence = z.infer<typeof PlanEvidence>;

/**
 * Plan record with version history.
 * Compliance requirement for regulated environments (banks, DATEV):
 * every plan revision must be preserved for audit trail.
 *
 * - current: the active plan version
 * - history: all previous versions (newest first)
 * - reviewFindings: independent review findings per iteration (parallel, NOT mixed)
 *
 * Architecture invariant: plan.history = author artifacts, plan.reviewFindings = reviewer artifacts
 */
export const PlanRecord = z
  .object({
    current: PlanEvidence,
    history: z.array(PlanEvidence),
    reviewFindings: z.array(ReviewFindings).optional(),
  })
  .readonly();
export type PlanRecord = z.infer<typeof PlanRecord>;

/**
 * State of the PLAN phase self-review loop.
 * Convergence: iteration >= maxIterations OR (revisionDelta === "none" AND verdict === "approve").
 * This is the "digest-stop" mechanism.
 */
export const SelfReviewLoop = z.object({
  iteration: z.number().int().nonnegative(),
  maxIterations: z.number().int().positive(),
  prevDigest: z.string().nullable(),
  currDigest: z.string().min(1),
  revisionDelta: RevisionDelta,
  verdict: LoopVerdict,
});
export type SelfReviewLoop = z.infer<typeof SelfReviewLoop>;
