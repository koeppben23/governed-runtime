/**
 * @module integration/review/review-loop-progress
 * @description Read-only projection of self-review loop progress for LLM consumption.
 *
 * Additive — no state mutation, no new convergence logic, no guard behavior.
 * Used by formatRailResult() and buildStatusProjection().
 *
 * @version v1
 */

import { isConverged } from '../../machine/guards.js';
import type { SessionState } from '../../state/schema.js';
import type { LoopVerdict } from '../../state/evidence.js';

const REVIEW_LOOP_PHASES = new Set<SessionState['phase']>([
  'PLAN_REVIEW',
  'IMPL_REVIEW',
  'ARCH_REVIEW',
]);

const LOOP_VERDICTS = new Set<LoopVerdict>(['approve', 'changes_requested', 'unable_to_review']);

function isLoopVerdict(value: unknown): value is LoopVerdict {
  return typeof value === 'string' && LOOP_VERDICTS.has(value as LoopVerdict);
}

export interface ReviewLoopProgress {
  iteration: number;
  maxIterations: number;
  previousVerdict: LoopVerdict;
  converged: boolean;
  outstandingIssues?: string[];
}

/**
 * Build a compact review-loop progress projection from session state.
 *
 * Returns null when:
 * - The current phase is not a review phase (PLAN_REVIEW, IMPL_REVIEW, ARCH_REVIEW)
 * - The relevant review slot is null
 * - The review slot exists but the verdict is invalid or missing
 */
export function getReviewLoopProgress(state: SessionState): ReviewLoopProgress | null {
  if (!REVIEW_LOOP_PHASES.has(state.phase)) return null;

  const review = state.phase === 'IMPL_REVIEW' ? state.implReview : state.selfReview;
  if (!review) return null;
  if (!isLoopVerdict(review.verdict)) return null;

  const progress: ReviewLoopProgress = {
    iteration: review.iteration,
    maxIterations: review.maxIterations,
    previousVerdict: review.verdict,
    converged: isConverged(review),
  };

  if (review.verdict === 'changes_requested') {
    const issues = extractOutstandingIssues(state);
    if (issues.length > 0) {
      progress.outstandingIssues = issues;
    }
  }

  return progress;
}

function extractOutstandingIssues(state: SessionState): string[] {
  if (state.phase === 'IMPL_REVIEW') {
    const findings = state.implReviewFindings?.at(-1);
    if (findings?.blockingIssues && Array.isArray(findings.blockingIssues)) {
      return findings.blockingIssues
        .slice(0, 3)
        .map((item: { message?: string }) => (typeof item.message === 'string' ? item.message : ''))
        .filter(Boolean);
    }
  }

  // PLAN_REVIEW / ARCH_REVIEW: extract from most recent review assurance invocation
  const invocations = state.reviewAssurance?.invocations;
  if (invocations && invocations.length > 0) {
    const last = invocations.at(-1);
    const blockingIssues = last?.capturedRawFindings?.blockingIssues;
    if (Array.isArray(blockingIssues)) {
      return blockingIssues
        .slice(0, 3)
        .map((item: unknown) => {
          if (!item || typeof item !== 'object') return '';
          const message = (item as Record<string, unknown>).message;
          return typeof message === 'string' ? message : '';
        })
        .filter(Boolean);
    }
  }

  return [];
}
