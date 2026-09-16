/**
 * @module integration/review/orchestrator-output
 * @description Output mutation helpers for already-bound reviewer evidence.
 *
 * Extracted from orchestrator.ts. Leaf module — no dependency on
 * orchestrator.ts or orchestrator-detection.ts.
 *
 * @version v1
 */

import { reviewDispatchCompleted } from './dispatch-signal.js';
import { parseToolResult } from '../plugin-helpers.js';

/** Subset of ReviewerSuccessResult needed for output mutation. */
interface ReviewerOutputInput {
  readonly findings: Record<string, unknown> | null;
  readonly sessionId?: string;
  readonly reviewOutputMode?: 'structured_output';
  readonly structuredOutputUsed?: boolean;
  readonly reviewAssuranceLevel?: 'structured_high';
}

export function buildMutatedOutput(
  originalOutput: string,
  reviewerResult: ReviewerOutputInput,
): string | null {
  if (!reviewerResult.findings) return null;

  const parsed = parseToolResult(originalOutput);
  if (!parsed || Array.isArray(parsed)) return null;

  parsed.reviewDispatch = reviewDispatchCompleted(String(reviewerResult.findings.overallVerdict));
  // The original tool response was projected before host dispatch. Its pending
  // review metadata and Task instruction are stale once evidence is bound.
  delete parsed.reviewInvocation;
  delete parsed.directive;

  return JSON.stringify(parsed);
}

export function buildReviewContentMutatedOutput(
  originalOutput: string,
  reviewerResult: ReviewerOutputInput,
  phase = 'PEER_REVIEW',
): string | null {
  if (!reviewerResult.findings) return null;

  const parsed = parseToolResult(originalOutput);
  if (!parsed || Array.isArray(parsed)) return null;

  return JSON.stringify({
    phase,
    reviewDispatch: reviewDispatchCompleted(String(reviewerResult.findings.overallVerdict)),
  });
}
