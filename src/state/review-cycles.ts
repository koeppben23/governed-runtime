/**
 * @module review-cycles
 * @description Canonical human review-cycle identity for the three governed
 *              review loops, plus its obligation-level coherence refinement.
 *
 * `iteration` counts agent/self-review iterations WITHIN one human review
 * cycle and restarts at 1 when a human requests changes at the owning gate.
 * These counters survive that restart, so two "iteration 1" passes in
 * different human cycles are distinguishable in persisted evidence and audit.
 *
 * Invariant: a counter is incremented ONLY by a human `changes_requested`
 * decision at the owning gate (plan → PLAN_REVIEW, architecture → ARCH_REVIEW,
 * implementation → EVIDENCE_REVIEW). Approve and reject never change it.
 * There is deliberately NO default and NO read-time migration: every
 * current-epoch state carries the explicit counters.
 *
 * @version v1
 */

import { z } from 'zod';

export const ReviewCycles = z
  .object({
    plan: z.number().int().positive(),
    architecture: z.number().int().positive(),
    implementation: z.number().int().positive(),
  })
  .strict()
  .readonly();
export type ReviewCycles = z.infer<typeof ReviewCycles>;

/** Minimal structural obligation shape the cycle refinement operates on. */
export interface ObligationCycleShape {
  readonly obligationType: string;
  readonly reviewCycle?: number | null;
}

/**
 * Human-cycle identity invariant.
 *
 * Peer review (`obligationType === 'review'`) has exactly one pass and no
 * human convergence cycle, so it MUST carry `reviewCycle === null`. Every other
 * obligation type belongs to a human-governed convergence loop whose cycle is
 * a positive integer; a null cycle there would make two human cycles
 * indistinguishable in persisted evidence and audit.
 */
export function refineReviewCycleCoherence(
  obligation: ObligationCycleShape,
  context: z.RefinementCtx,
): void {
  if (obligation.obligationType === 'review') {
    if (obligation.reviewCycle !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewCycle'],
        message: 'peer review obligations must carry reviewCycle === null (no convergence cycle)',
      });
    }
    return;
  }
  if (obligation.reviewCycle === null || obligation.reviewCycle === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewCycle'],
      message: 'plan/architecture/implement obligations require a positive reviewCycle',
    });
  }
}
