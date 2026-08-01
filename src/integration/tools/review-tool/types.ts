/**
 * @module integration/tools/review-tool/types
 * @description Shared type definitions for the review-tool module.
 *
 * @version v1
 */

import type { startReviewFlow, executeReview } from '../../../rails/review.js';
import type { ReviewReferenceInput } from '../../../rails/review.js';
import type { ReviewObligation } from '../../../state/evidence.js';
import type { ReviewFindings } from '../../../state/evidence.js';
import type { ToolContext } from '../helpers.js';
import type { StandaloneReviewObjective } from '../../../state/standalone-review.js';

export type StartedReviewResult = Extract<ReturnType<typeof startReviewFlow>, { kind: 'ok' }>;

export type ReviewExecutionContext = {
  args: ReviewToolArgs;
  context: ToolContext;
  now: string;
  policy: string;
};

export type NativeAttestationRejectionReason =
  | 'capture_read_failed'
  | 'capture_lines_skipped'
  | 'capture_missing'
  | 'capture_unbound'
  | 'capture_session_mismatch';

export type NativeAttestationRejection = {
  reason: NativeAttestationRejectionReason;
  obligationId: string;
};

export type ReviewPreparation = {
  result: StartedReviewResult;
  refInput?: ReviewReferenceInput;
  validatedReviewObligation: ReviewObligation | null;
  /** Newly created pending obligation (first content-aware call). */
  pendingObligation?: ReviewObligation;
  /** Blocking message to return after content preparation (e.g. CONTENT_ANALYSIS_REQUIRED). */
  blockMessage?: string;
  effectiveReviewFindings?: ReviewFindings;
  evidenceInvocationId?: string;
  nativeAttestationRejection?: NativeAttestationRejection;
};

export type ReviewReportResult = Exclude<
  Awaited<ReturnType<typeof executeReview>>,
  { kind: 'blocked' }
>;

export type ReviewToolArgs = {
  inputOrigin?: ReviewReferenceInput['inputOrigin'];
  references?: ReviewReferenceInput['references'];
  text?: string;
  prNumber?: number;
  branch?: string;
  /** Optional explicit base ref/branch/SHA for a branch review diff. */
  base?: string;
  url?: string;
  /** Exact obligation identity required for host-task verdict continuations. */
  reviewObligationId?: string;
  reviewVerdict?: 'accept' | 'changes_requested';
  reviewFindings?: ReviewFindings;
  /** Optional structured objectives; omitted uses the canonical static profile. */
  objectives?: StandaloneReviewObjective[];
  targetPaths?: string[];
};
