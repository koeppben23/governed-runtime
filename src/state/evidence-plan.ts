/**
 * @module evidence-plan
 * @description Plan evidence schema — plan versions, plan record with history, and self-review loop.
 *
 * @version v1
 */

import { z } from 'zod';
import { LoopVerdict, RevisionDelta, ReviewCompletion } from './evidence-primitives.js';
import { ReviewFindings } from './evidence-review.js';
import { PlanApprovalCertificate, PlanClaimDeclarations } from './proofgraph-approval.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashText } from '../shared/hashing.js';

export const PLAN_RECORD_DOMAIN = 'flowguard.plan-record.v1';

/**
 * Compute the cryptographic record digest for a plan version.
 *
 * Binds the content identity, version, predecessor, originating obligation,
 * and revision reason into a single domain-separated hash. The digest proves
 * that this record is the legitimate successor of its `supersedesRecordDigest`
 * predecessor — change ANY of the lineage metadata and the digest changes.
 *
 * The content itself is represented by the existing `digest` (content hash);
 * the record digest inherits that via inclusion.
 */
export function computeRecordDigest(input: {
  contentDigest: string;
  planVersion: number;
  supersedesRecordDigest: string | null;
  originatingReviewObligationId: string | null;
  revisionReason: string | null;
}): string {
  return hashText(
    PLAN_RECORD_DOMAIN +
      '\n' +
      canonicalJsonStringify({
        contentDigest: input.contentDigest,
        planVersion: input.planVersion,
        supersedesRecordDigest: input.supersedesRecordDigest,
        originatingReviewObligationId: input.originatingReviewObligationId,
        revisionReason: input.revisionReason,
      }),
  );
}

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
  /**
   * Cryptographic record digest: domain-separated hash of (contentDigest,
   * planVersion, supersedesRecordDigest, originatingReviewObligationId,
   * revisionReason). Computed by `computeRecordDigest()`.
   * Defaults to a sentinel for backward-compatible legacy parsing; controlled
   * construction paths (buildPlanEvidence) always override with a real value.
   */
  recordDigest: z.string().min(1).default('unavailable-record-digest'),
  /** Immutable version number within this plan's lineage (1-based). */
  planVersion: z.number().int().positive().default(1),
  /**
   * Record-digest of the immediate predecessor, or null for v1.
   * References the predecessor's `recordDigest`, NOT its content `digest`.
   */
  supersedesRecordDigest: z.string().nullable().default(null),
  /** The review obligation that triggered this revision, or null for fresh. */
  originatingReviewObligationId: z.string().uuid().nullable().default(null),
  /** Human or machine summary of why this revision was created. */
  revisionReason: z.string().nullable().default(null),
  /**
   * Trust status of the lineage.
   * - 'verified': computed by `computeRecordDigest` from authoritative fields.
   * - 'legacy_inferred': reconstructed from pre-lineage data (best-effort, not
   *    cryptographically guaranteed).
   * - 'unavailable': plan was parsed from legacy data with no lineage metadata.
   *    The Zod schema default is 'unavailable' — only the controlled creation
   *    paths in buildPlanEvidence() override this to 'verified'.
   */
  lineageStatus: LineageStatus.default('unavailable'),
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
    /**
     * Completion of the independent plan review cycle for the current subject
     * (CE5). Lifecycle evidence, never part of the plan's content identity.
     * Optional for legacy hydration: absent means `pending` at the authority
     * boundary — a converged-but-unmarked legacy plan cannot be approved, the
     * review loop must converge again. All controlled writers set it.
     */
    reviewCompletion: ReviewCompletion.optional(),
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

/**
 * Completion of the plan review cycle for the current subject, derived at
 * review time from the loop state (CE5, architecture parity):
 *
 * - `reviewer_accepted`: the reviewer accepted the current plan text
 *   (revisionDelta 'none' + verdict 'accept') — even at the iteration limit.
 * - `review_exhausted`: the review budget ended without acceptance.
 * - `pending`: the loop has not converged.
 *
 * Canonical authority for the plan completion derivation; both the tool path
 * (`src/integration/tools/plan.ts`) and the self-review rails
 * (`src/rails/plan.ts`, `src/rails/continue.ts`) derive it here.
 */
export function resolvePlanReviewCompletion(
  iteration: number,
  maxIterations: number,
  revisionDelta: RevisionDelta,
  verdict: LoopVerdict,
): ReviewCompletion {
  const reviewerAccepted = revisionDelta === 'none' && verdict === 'accept';
  if (reviewerAccepted) return 'reviewer_accepted';
  if (iteration >= maxIterations) return 'review_exhausted';
  return 'pending';
}
