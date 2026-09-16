/**
 * @module integration/tools/review-tool/types
 * @description Shared type definitions for the review-tool module.
 *
 * @version v1
 */

import type { startReviewFlow, executeReview } from '../../../rails/review.js';
import type { RailBlocked } from '../../../rails/types.js';
import type { ReviewReferenceInput } from '../../../rails/review.js';
import type { FrozenReviewSubject, ReviewObligation } from '../../../state/evidence.js';
import type { ReviewFindings } from '../../../state/evidence.js';
import type { ReviewAssuranceState } from '../../../state/evidence-review.js';
import type { ToolContext } from '../helpers.js';
import type { PeerReviewObjective } from '../../../state/peer-review.js';

export type StartedReviewResult = Extract<ReturnType<typeof startReviewFlow>, { kind: 'ok' }>;

export type ReviewExecutionContext = {
  args: ReviewToolArgs;
  context: ToolContext;
  now: string;
};

export type ReviewPreparation = {
  result: StartedReviewResult;
  refInput?: ReviewReferenceInput;
  validatedReviewObligation: ReviewObligation | null;
  /** Newly created pending obligation (first content-aware call). */
  pendingObligation?: ReviewObligation;
  /**
   * Assurance state actually written while preparing the obligation, including
   * its attempt. Authoritative over the caller's pre-write snapshot.
   */
  persistedAssurance?: ReviewAssuranceState;
  /** Blocking message to return after content preparation (e.g. CONTENT_ANALYSIS_REQUIRED). */
  blockMessage?: string;
  effectiveReviewFindings?: ReviewFindings;
  evidenceInvocationId?: string;
  materializedContent?: import('../../../rails/review.js').PreparedReviewContent | null;
  reviewSubject?: FrozenReviewSubject;
};

export type ReviewReportResult = Exclude<Awaited<ReturnType<typeof executeReview>>, RailBlocked>;

export type ReviewToolArgs = {
  inputOrigin?: ReviewReferenceInput['inputOrigin'];
  references?: ReviewReferenceInput['references'];
  text?: string;
  prNumber?: number;
  branch?: string;
  /** Optional explicit base ref/branch/SHA for a branch review diff. */
  base?: string;
  url?: string;
  reviewObligationId?: string;
  /** Optional structured objectives; omitted uses the canonical static profile. */
  objectives?: PeerReviewObjective[];
  targetPaths?: string[];
};
