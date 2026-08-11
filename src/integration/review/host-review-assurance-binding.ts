/**
 * @module integration/review/host-review-assurance-binding
 * @description Canonical binding authority for host-captured reviewer evidence.
 */

import type { ReviewAssuranceState } from '../../state/evidence.js';
import { ensureReviewAssurance, updateAttemptStatus } from './assurance.js';

/** Bind only the exact persisted attempt evidenced by a host-visible Task. */
export function bindHostReviewInvocation(
  assurance: ReviewAssuranceState,
  obligationId: string,
  invocationId: string,
  now: string,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  const invocation = base.invocations.find((item) => item.invocationId === invocationId);
  if (!isHostInvocationForObligation(invocation, obligationId)) return base;
  const attempts = base.attempts.filter((item) => item.obligationId === obligationId);
  const firstAttempt = attempts[0];
  if (!firstAttempt) return base;
  const attempt = attempts.reduce(
    (best, item) => (item.ordinal > best.ordinal ? item : best),
    firstAttempt,
  );
  if (attempt.attemptId !== invocation.attemptId) return base;
  return updateAttemptStatus(base, attempt.attemptId, 'bound', now);
}

function isHostInvocationForObligation(
  invocation: ReviewAssuranceState['invocations'][number] | undefined,
  obligationId: string,
): invocation is ReviewAssuranceState['invocations'][number] & { readonly attemptId: string } {
  return Boolean(
    invocation &&
    invocation.obligationId === obligationId &&
    invocation.invocationMode === 'host_subagent_task' &&
    invocation.hostVisible === true &&
    invocation.attemptId,
  );
}
