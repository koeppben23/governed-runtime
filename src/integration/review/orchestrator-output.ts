/**
 * @module integration/review/orchestrator-output
 * @description Output mutation helpers for already-bound reviewer evidence.
 *
 * Extracted from orchestrator.ts. Leaf module — no dependency on
 * orchestrator.ts or orchestrator-detection.ts.
 *
 * @version v1
 */

import { REVIEW_COMPLETED_PREFIX } from './orchestrator-constants.js';
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

  parsed.next =
    `${REVIEW_COMPLETED_PREFIX}: FlowGuard bound the host-validated independent review. ` +
    `Submit only reviewVerdict=${String(reviewerResult.findings.overallVerdict)} to continue; ` +
    'do not submit or reconstruct reviewer findings.';
  // The original tool response was projected before host dispatch. Its pending
  // review metadata and Task instruction are stale once evidence is bound.
  delete parsed.reviewInvocation;
  delete parsed.nextAction;
  delete parsed.productNextAction;

  return JSON.stringify(parsed);
}

export function buildReviewContentMutatedOutput(
  originalOutput: string,
  reviewerResult: ReviewerOutputInput,
): string | null {
  if (!reviewerResult.findings) return null;

  const parsed = parseToolResult(originalOutput);
  if (!parsed || Array.isArray(parsed)) return null;

  parsed.next =
    `PLUGIN_REVIEW_COMPLETED: FlowGuard bound the host-validated independent review. ` +
    `Call flowguard_review again with the same content input and reviewVerdict=${String(reviewerResult.findings.overallVerdict)}. ` +
    'Do not submit or reconstruct reviewer findings.';

  return JSON.stringify(parsed);
}
