/**
 * @module evidence-plan
 * @description Plan evidence schema — plan versions, plan record with history, and self-review loop.
 *
 * @version v1
 */

import { z } from 'zod';
import { LoopVerdict, RevisionDelta } from './evidence-primitives.js';
import { ReviewFindings } from './evidence-review.js';
import { PlanApprovalCertificate, PlanClaimDeclarations } from './proofgraph-approval.js';

export const LineageStatus = z.enum(['verified', 'legacy_inferred', 'unavailable']);
export type LineageStatus = z.infer<typeof LineageStatus>;

/** A single plan version (immutable snapshot). */
export const PlanEvidence = z.object({
  body: z.string().min(1),
  /** Content-based identity: SHA-256 of the plan text alone. */
  digest: z.string().min(1),
  sections: z.array(z.string()),
  createdAt: z.string().datetime(),

  // ── Lineage (Commit 3) ──────────────────────────────────────────────
  /** Immutable version number within this plan's lineage (1-based). */
  planVersion: z.number().int().positive().default(1),
  /**
   * Record-digest of the immediate predecessor, or null for v1.
   * This is a cryptographic reference, not a content hash — it proves
   * that this version genuinely succeeds the referenced predecessor.
   */
  supersedesRecordDigest: z.string().nullable().default(null),
  /** The review obligation that triggered this revision, or null for fresh. */
  originatingReviewObligationId: z.string().uuid().nullable().default(null),
  /** Human or machine summary of why this revision was created. */
  revisionReason: z.string().nullable().default(null),
  /** Trust status of the lineage: verified (post-Commit-3), legacy_inferred
   *  (migrated from pre-lineage data), or unavailable (truly unknown). */
  lineageStatus: LineageStatus.default('verified'),
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
    /** User-declared ProofGraph claims for the current plan authority. */
    claimDeclarations: PlanClaimDeclarations.optional(),
    /** User approval certificate bound to the current plan authority. */
    approvalCertificate: PlanApprovalCertificate.optional(),
  })
  .readonly();
export type PlanRecord = z.infer<typeof PlanRecord>;

/**
 * State of the PLAN phase self-review loop.
 * Convergence: iteration >= maxIterations OR (revisionDelta === "none" AND verdict === "accept").
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
