/**
 * @module integration/diagnostics/review-links
 * @description Bounded projection of canonical review-assurance IDs.
 *
 * Only stable IDs, enums, digests and timestamps are copied. Reviewer text and
 * actor identity remain in the canonical state/host artifacts.
 */

import type { DiagnosticWarning } from '../../adapters/diagnostics/export-schema.js';
import { warning } from '../../adapters/diagnostics/types.js';
import { sanitizeDiagnosticString } from '../../logging/redact.js';
import type { SessionState } from '../../state/schema.js';
import type {
  ExplorerAttemptLink,
  ExplorerDispatchLink,
  ExplorerInvocationLink,
  ExplorerReviewLink,
  ExplorerReviewLinks,
} from './types.js';

/** Per-array cap keeps command output bounded without hiding the cap. */
const MAX_REVIEW_LINKS = 200;

function take<T>(items: readonly T[], warnings: DiagnosticWarning[]): readonly T[] {
  if (items.length <= MAX_REVIEW_LINKS) return items;
  warnings.push(
    warning(
      'REVIEW_LINKS_TRUNCATED',
      sanitizeDiagnosticString(
        `Review evidence exceeds the ${MAX_REVIEW_LINKS}-entry view limit; only the newest entries are shown.`,
      ),
      null,
      'review',
    ),
  );
  return items.slice(items.length - MAX_REVIEW_LINKS);
}

/** Project all review-assurance links, bounded and with explicit truncation. */
export function projectReviewLinks(
  state: SessionState,
  warnings: DiagnosticWarning[],
): ExplorerReviewLinks | null {
  const assurance = state.reviewAssurance;
  if (!assurance) return null;

  const obligations: ExplorerReviewLink[] = assurance.obligations.map((item) => ({
    obligationId: item.obligationId,
    obligationType: item.obligationType,
    status: item.status,
    iteration: item.iteration,
    reviewCycle: item.reviewCycle,
    planVersion: item.planVersion,
    subjectDigest: item.subjectDigest,
    invocationId: item.invocationId,
    blockedCode: item.blockedCode,
    fulfilledAt: item.fulfilledAt,
    consumedAt: item.consumedAt,
  }));
  const attempts: ExplorerAttemptLink[] = assurance.attempts.map((item) => ({
    attemptId: item.attemptId,
    obligationId: item.obligationId,
    status: item.status,
    ordinal: item.ordinal,
    childSessionId: item.childSessionId ?? null,
    subjectDigest: item.subjectDigest,
    createdAt: item.createdAt,
    completedAt: item.completedAt ?? null,
  }));
  const dispatches: ExplorerDispatchLink[] = assurance.dispatches.map((item) => ({
    dispatchId: item.dispatchId,
    attemptId: item.attemptId,
    obligationId: item.obligationId,
    hostCallId: item.hostCallId,
    dispatchStatus: item.dispatchStatus,
    dispatchAuthorizedAt: item.dispatchAuthorizedAt,
    completedAt: item.completedAt ?? null,
  }));
  const invocations: ExplorerInvocationLink[] = assurance.invocations.map((item) => ({
    invocationId: item.invocationId,
    obligationId: item.obligationId,
    attemptId: item.attemptId,
    childSessionId: item.childSessionId,
    parentSessionId: item.parentSessionId,
    capturedVerdict: item.capturedVerdict ?? null,
    invokedAt: item.invokedAt,
    fulfilledAt: item.fulfilledAt,
  }));

  const boundedObligations = take(obligations, warnings);
  const boundedAttempts = take(attempts, warnings);
  const boundedDispatches = take(dispatches, warnings);
  const boundedInvocations = take(invocations, warnings);
  return {
    obligations: boundedObligations,
    attempts: boundedAttempts,
    dispatches: boundedDispatches,
    invocations: boundedInvocations,
    truncated:
      boundedObligations.length !== obligations.length ||
      boundedAttempts.length !== attempts.length ||
      boundedDispatches.length !== dispatches.length ||
      boundedInvocations.length !== invocations.length,
  };
}
