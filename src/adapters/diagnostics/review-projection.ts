/**
 * @module adapters/diagnostics/review-projection
 * @description Technical review-assurance projection for diagnostic snapshots.
 *
 * Only stable IDs, enums, digests and timestamps are copied. Free-text findings,
 * prompts, actor identity and model output remain in the redacted state/host
 * artifacts and are not duplicated here.
 */

import type { SessionState } from '../../state/schema.js';

export function projectReviewAssurance(state: SessionState): Record<string, unknown> | null {
  const assurance = state.reviewAssurance;
  if (!assurance) return null;
  return {
    assuranceSchemaVersion: assurance.assuranceSchemaVersion,
    obligations: assurance.obligations.map((item) => ({
      obligationId: item.obligationId,
      obligationType: item.obligationType,
      iteration: item.iteration,
      reviewCycle: item.reviewCycle,
      status: item.status,
      subjectDigest: item.subjectDigest,
      blockedCode: item.blockedCode,
      createdAt: item.createdAt,
      fulfilledAt: item.fulfilledAt,
      consumedAt: item.consumedAt,
    })),
    invocations: assurance.invocations.map((item) => ({
      invocationId: item.invocationId,
      obligationId: item.obligationId,
      attemptId: item.attemptId,
      childSessionId: item.childSessionId,
      transportVersion: item.transportVersion,
      invocationMode: item.invocationMode,
      invokedAt: item.invokedAt,
      fulfilledAt: item.fulfilledAt,
      capturedVerdict: item.capturedVerdict ?? null,
    })),
    attempts: assurance.attempts.map((item) => ({
      attemptId: item.attemptId,
      obligationId: item.obligationId,
      ordinal: item.ordinal,
      status: item.status,
      childSessionId: item.childSessionId ?? null,
      origin: item.origin,
      createdAt: item.createdAt,
      completedAt: item.completedAt ?? null,
    })),
    dispatches: assurance.dispatches.map((item) => ({
      dispatchId: item.dispatchId,
      attemptId: item.attemptId,
      obligationId: item.obligationId,
      hostCallId: item.hostCallId,
      dispatchStatus: item.dispatchStatus,
      dispatchAuthorizedAt: item.dispatchAuthorizedAt,
      completedAt: item.completedAt ?? null,
    })),
    capacityLock: assurance.capacityLock ?? null,
  };
}
