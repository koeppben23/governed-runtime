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
 * revision reason, and the minted revision identity into a single
 * domain-separated hash. The digest proves that this record is the legitimate
 * successor of its `supersedesRecordDigest` predecessor — change ANY of the
 * lineage metadata (including `revisionId`) and the digest changes.
 *
 * `revisionId` makes the record digest a unique revision-instance identity:
 * two independent lineages with identical content, version, and timestamp
 * still carry distinct record digests.
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
  revisionId: string;
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
        revisionId: input.revisionId,
      }),
  );
}

export const LineageStatus = z.literal('verified');
export type LineageStatus = z.infer<typeof LineageStatus>;

/** A single plan version (immutable snapshot). */
export const PlanEvidence = z.object({
  body: z.string().min(1),
  /** Content-based identity: SHA-256 of the plan text alone. */
  digest: z.string().min(1),
  sections: z.array(z.string()),
  createdAt: z.string().datetime(),
  /**
   * Minted identity of this exact revision instance. Part of the record
   * digest, so it distinguishes independent lineages whose content, version,
   * and timestamp are identical.
   */
  revisionId: z.string().uuid(),

  // ── Lineage ─────────────────────────────────────────────────────────
  // Hard Assurance Epoch: every current-epoch plan version carries the full
  // lineage computed by computeRecordDigest(). There is NO legacy hydration,
  // sentinel default, or inferred status — incomplete lineage fails parsing.
  /** Cryptographic record digest: domain-separated hash of (contentDigest, planVersion, supersedesRecordDigest, originatingReviewObligationId, revisionReason, revisionId). */
  recordDigest: z.string().min(1),
  /** Immutable version number within this plan's lineage (1-based). */
  planVersion: z.number().int().positive(),
  /**
   * Record-digest of the immediate predecessor, or null for v1.
   * References the predecessor's `recordDigest`, NOT its content `digest`.
   */
  supersedesRecordDigest: z.string().nullable(),
  /** The review obligation that triggered this revision, or null for fresh. */
  originatingReviewObligationId: z.string().uuid().nullable(),
  /** Human or machine summary of why this revision was created. */
  revisionReason: z.string().nullable(),
  /** Only 'verified' exists in this epoch — lineage is computed, never inferred. */
  lineageStatus: LineageStatus,
});
export type PlanEvidence = z.infer<typeof PlanEvidence>;

/** Point a lineage issue at the offending revision (current vs. history slot). */
function planRevisionIssuePath(
  record: { readonly current: PlanEvidence; readonly history: readonly PlanEvidence[] },
  revision: PlanEvidence,
): Array<string | number> {
  if (revision === record.current) return ['current'];
  const index = record.history.indexOf(revision);
  return index >= 0 ? ['history', index] : [];
}

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
 *
 * Lineage authority: the record is the SINGLE authority for plan revision
 * identity. Every revision must satisfy `digest === hashText(body)` and
 * `recordDigest === computeRecordDigest(...)`, and `[...history, current]` must
 * form the exact contiguous chain v1..vN with `current` as the head. Derived
 * surfaces (evidence artifacts) consume this identity and MUST NOT re-derive
 * or re-validate the chain.
 */
export const PlanRecord = z
  .object({
    current: PlanEvidence,
    history: z.array(PlanEvidence),
    reviewFindings: z.array(ReviewFindings).optional(),
    /** User-declared ProofGraph claims for the current plan authority. */
    claimDeclarations: PlanClaimDeclarations.optional(),
    /**
     * Non-authoritative record of declarations submitted with this plan that
     * FlowGuard did not admit to the ProofGraph. The approval certificate binds
     * only `claimDeclarations`, never this diagnostic record.
     */
    claimSubmissionDiagnostics: z
      .object({
        submittedClaimDeclarationsDigest: z.string().regex(/^[a-f0-9]{64}$/),
        acceptedClaimDeclarationsDigest: z.string().regex(/^[a-f0-9]{64}$/),
        rejectedClaims: z.array(
          z
            .object({
              claimRef: z.string().uuid(),
              statement: z.string().min(1),
              critical: z.boolean(),
              disposition: z.enum(['rejected_non_blocking', 'rejected_blocking']),
              code: z.string().min(1),
              reason: z.string().min(1),
              recovery: z.array(z.string().min(1)).min(1),
            })
            .readonly(),
        ),
      })
      .readonly()
      .optional(),
    /** Append-only forensic history of non-authoritative rejected declarations. */
    claimSubmissionHistory: z
      .array(
        z
          .object({
            planVersion: z.number().int().positive(),
            submittedClaimDeclarationsDigest: z.string().regex(/^[a-f0-9]{64}$/),
            acceptedClaimDeclarationsDigest: z.string().regex(/^[a-f0-9]{64}$/),
            rejectedClaims: z.array(
              z
                .object({
                  claimRef: z.string().uuid(),
                  statement: z.string().min(1),
                  critical: z.boolean(),
                  disposition: z.enum(['rejected_non_blocking', 'rejected_blocking']),
                  code: z.string().min(1),
                  reason: z.string().min(1),
                  recovery: z.array(z.string().min(1)).min(1),
                })
                .readonly(),
            ),
          })
          .readonly(),
      )
      .optional(),
    /** User approval certificate bound to the current plan authority. */
    approvalCertificate: PlanApprovalCertificate.optional(),
    /**
     * Completion of the independent plan review cycle for the current subject
     * (CE5). Lifecycle evidence, never part of the plan's content identity.
     * REQUIRED in the Hard Assurance Epoch — all controlled writers set it;
     * absence fails parsing instead of defaulting to `pending`.
     */
    reviewCompletion: ReviewCompletion,
  })
  .readonly()
  .superRefine((record, context) => {
    // Revision identity is recomputed, never trusted: content digest, record
    // digest (including revisionId), chain position, and predecessor linkage.
    const chain = [...record.history, record.current].sort(
      (left, right) => left.planVersion - right.planVersion,
    );
    for (const [index, revision] of chain.entries()) {
      const path = planRevisionIssuePath(record, revision);
      if (revision.digest !== hashText(revision.body)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `plan revision v${revision.planVersion} digest does not match hashText(body)`,
        });
        return;
      }
      const expectedRecordDigest = computeRecordDigest({
        contentDigest: revision.digest,
        planVersion: revision.planVersion,
        supersedesRecordDigest: revision.supersedesRecordDigest,
        originatingReviewObligationId: revision.originatingReviewObligationId,
        revisionReason: revision.revisionReason,
        revisionId: revision.revisionId,
      });
      if (revision.recordDigest !== expectedRecordDigest) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `plan revision v${revision.planVersion} recordDigest does not match computeRecordDigest(...)`,
        });
        return;
      }
      if (revision.planVersion !== index + 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `plan lineage is not contiguous: expected planVersion ${index + 1}, got ${revision.planVersion}`,
        });
        return;
      }
      const predecessor = index === 0 ? undefined : chain.at(index - 1);
      const predecessorRecordDigest = predecessor?.recordDigest ?? null;
      if (revision.supersedesRecordDigest !== predecessorRecordDigest) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message:
            `plan lineage chain is broken at v${revision.planVersion}: ` +
            `supersedesRecordDigest must be ${predecessorRecordDigest ?? 'null'}`,
        });
        return;
      }
    }
    if (record.current.planVersion !== chain.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['current'],
        message: `plan current revision is not the lineage head: v${record.current.planVersion} of ${chain.length}`,
      });
    }
  });
export type PlanRecord = z.infer<typeof PlanRecord>;

/**
 * State of the PLAN phase self-review loop.
 * Convergence: iteration >= maxIterations OR (revisionDelta === "none" AND verdict === "accept").
 * This is the "digest-stop" mechanism.
 *
 * `reviewCycle` is the human-cycle identity of this loop projection: the active
 * `SessionState.reviewCycles.plan` at creation. `iteration` restarts at 1 when
 * a human requests changes at PLAN_REVIEW; `reviewCycle` makes the two
 * iteration-1 passes distinguishable in persisted evidence and audit.
 */
export const SelfReviewLoop = z.object({
  iteration: z.number().int().nonnegative(),
  /** Human review cycle this projection belongs to (positive, from state.reviewCycles). */
  reviewCycle: z.number().int().positive(),
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
 * - `review_exhausted`: the review budget ended with `changes_requested`.
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
  // A reviewer tool failure is never an exhaustion override candidate.
  if (verdict === 'unable_to_review') return 'pending';
  const reviewerAccepted = revisionDelta === 'none' && verdict === 'accept';
  if (reviewerAccepted) return 'reviewer_accepted';
  if (iteration >= maxIterations) return 'review_exhausted';
  return 'pending';
}
