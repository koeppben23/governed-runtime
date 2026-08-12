/**
 * @module integration/tools/review-tool/frozen-continuation
 * @description Immutable-subject reuse and drift detection for review continuations.
 *
 * A frozen review subject is persisted state. Re-deriving it from mutable
 * sources (git refs, gh CLI, diff parsing) on every follow-up call creates a
 * second authority over immutable data: the continuation can fail, or silently
 * disagree with the subject the reviewer actually reviewed, even though the
 * authoritative bytes are already on disk.
 *
 * This module is that single authority. A host-task verdict continuation reuses
 * the persisted subject and material verbatim; any remaining derivation is
 * checked against the frozen subject digest and fails closed on mismatch.
 *
 * @version v1
 */

import type { SessionState } from '../../../state/schema.js';
import type { PreparedReviewContent } from '../../../rails/review.js';
import { findReviewObligationById, latestReviewMaterial } from '../../review/assurance.js';
import { ensureReviewAssurance } from '../../review/attempt-lifecycle.js';
import { verifyFrozenReviewerContext } from '../../review/frozen-reviewer-context.js';
import { formatBlocked } from '../helpers.js';
import type { ReviewToolArgs } from './types.js';

/** The continuation inputs this module reasons about. */
interface ContinuationContext {
  readonly args: ReviewToolArgs;
  readonly policy: string;
}

/**
 * Whether this call continues an existing host-task obligation to submit its
 * captured reviewer verdict.
 */
function isHostTaskVerdictContinuation(exec: ContinuationContext): boolean {
  return (
    exec.policy === 'host_task_required' &&
    exec.args.reviewVerdict !== undefined &&
    exec.args.reviewObligationId !== undefined
  );
}

export type FrozenContinuationResult =
  /** Reuse the persisted subject and material instead of re-deriving them. */
  | { readonly kind: 'reuse'; readonly content: PreparedReviewContent }
  /** Fail closed: the persisted subject exists but cannot be trusted. */
  | { readonly kind: 'blocked'; readonly message: string }
  /** Not a frozen continuation; the caller materializes content normally. */
  | { readonly kind: 'not_applicable' };

/**
 * Resolve the reviewed content for a host-task verdict continuation from
 * persisted state.
 *
 * Deliberately fails closed rather than falling back to re-derivation once an
 * obligation with a frozen subject is in play: a continuation whose material is
 * missing or no longer matches its digest must not silently review freshly
 * derived bytes under an attestation captured for different ones.
 */
export function resolveFrozenContinuationContent(
  state: SessionState,
  exec: ContinuationContext,
): FrozenContinuationResult {
  if (!isHostTaskVerdictContinuation(exec)) return { kind: 'not_applicable' };
  const obligationId = exec.args.reviewObligationId;
  if (obligationId === undefined) return { kind: 'not_applicable' };
  const assurance = ensureReviewAssurance(state.reviewAssurance);
  const obligation = findReviewObligationById(assurance, obligationId);
  // No obligation, or one without a frozen subject, is not this module's
  // decision: the existing obligation-resolution guards own that outcome.
  if (!obligation?.reviewSubject) return { kind: 'not_applicable' };

  const material = latestReviewMaterial(assurance, obligationId);
  const verified = verifyFrozenReviewerContext(obligation, material);
  if (verified.kind === 'blocked') {
    return {
      kind: 'blocked',
      message: formatBlocked(verified.code, { obligationId, reason: verified.reason }),
    };
  }
  return {
    kind: 'reuse',
    content: {
      content: verified.context.reviewMaterial.content,
      reviewedContentDigest: verified.context.reviewMaterial.materialDigest,
      reviewSubject: verified.context.reviewSubject,
    },
  };
}

/**
 * Reject a re-derived subject that does not match the frozen obligation subject.
 *
 * Applies to the paths that still derive content while naming an existing
 * obligation and where that derivation decides what gets reviewed — chiefly the
 * reviewer repair retry, which re-issues a reviewer prompt. The reviewed subject
 * is immutable once frozen, so a divergence is a hard stop, never a silent
 * substitution of what the reviewer was asked to assess.
 *
 * Findings submissions are deliberately excluded: that path does not re-issue a
 * reviewed subject, and it is already gated by attestation validation, input
 * fingerprint matching, and invocation-evidence binding. Running this check
 * there would pre-empt those checks and report a subject mismatch for a call
 * whose actual defect is a missing or forged attestation.
 */
export function assertFrozenSubjectUnchanged(
  state: SessionState,
  exec: ContinuationContext,
  derived: PreparedReviewContent | null,
): string | null {
  const obligationId = exec.args.reviewObligationId;
  if (obligationId === undefined || !derived) return null;
  if (exec.args.reviewFindings !== undefined) return null;
  const obligation = findReviewObligationById(
    ensureReviewAssurance(state.reviewAssurance),
    obligationId,
  );
  const frozen = obligation?.reviewSubject;
  if (!frozen) return null;
  if (frozen.subjectDigest === derived.reviewSubject.subjectDigest) return null;
  return formatBlocked('REVIEW_SUBJECT_DIGEST_MISMATCH', {
    obligationId,
    reason: `frozen ${frozen.subjectDigest} vs re-derived ${derived.reviewSubject.subjectDigest}`,
  });
}
