import { extractContentMeta } from './extraction.js';
import type { PendingReview, PendingReviewTool } from './types.js';

export type ReviewSignalBinding = {
  readonly attemptId?: string | null;
  readonly obligationId?: string | null;
  readonly canonicalPromptAnchor?: string | null;
  readonly canonicalPrompt?: string | null;
  readonly canonicalPromptDigest?: string | null;
  readonly hostAttestationConstants?: {
    readonly mandateDigest: string;
    readonly criteriaVersion: string;
  } | null;
};

/** Build the host-owned pending-review record from one canonical review signal. */
export function buildPendingReview(
  reviewTool: PendingReviewTool,
  next: string,
  now: string,
  binding: ReviewSignalBinding,
  prior: PendingReview | undefined,
): PendingReview {
  const reviewContext = pendingReviewContext(binding);
  const retryState = pendingReviewRetryState(prior, reviewContext.obligationId, binding);
  return {
    tool: reviewTool,
    requestedAt: now,
    attemptId: binding.attemptId ?? null,
    ...reviewContext,
    subagentCalled: false,
    subagentRecord: null,
    contentMeta: extractContentMeta(next),
    canonicalPromptAnchor: binding.canonicalPromptAnchor ?? null,
    canonicalPrompt: binding.canonicalPrompt ?? null,
    capturedFindings: null,
    ...retryState,
    expectedPromptDigest: binding.canonicalPromptDigest ?? null,
  };
}

function pendingReviewContext(
  binding: ReviewSignalBinding,
): Pick<PendingReview, 'obligationId' | 'hostAttestationConstants' | 'enforcementFailure'> {
  const obligationId = binding.obligationId ?? null;
  const hostAttestationConstants = binding.hostAttestationConstants ?? null;
  return {
    obligationId,
    hostAttestationConstants,
    enforcementFailure: reviewContextFailure(obligationId, hostAttestationConstants),
  };
}

function pendingReviewRetryState(
  prior: PendingReview | undefined,
  obligationId: string | null,
  binding: ReviewSignalBinding,
): Pick<
  PendingReview,
  'retryCount' | 'lastSchemaErrors' | 'repairPromptRequired' | 'expectedRepairPromptDigest'
> {
  const sameObligation = isSamePendingObligation(prior, obligationId);
  const isRepairReissue = sameObligation && prior?.repairPromptRequired === true;
  return {
    retryCount: sameObligation ? (prior?.retryCount ?? 0) : 0,
    lastSchemaErrors: isRepairReissue ? (prior?.lastSchemaErrors ?? null) : null,
    repairPromptRequired: isRepairReissue,
    expectedRepairPromptDigest: isRepairReissue ? (binding.canonicalPromptDigest ?? null) : null,
  };
}

function isSamePendingObligation(
  prior: PendingReview | undefined,
  obligationId: string | null,
): boolean {
  return prior?.obligationId != null && prior.obligationId === obligationId;
}

function reviewContextFailure(
  obligationId: string | null,
  hostAttestationConstants: PendingReview['hostAttestationConstants'],
): PendingReview['enforcementFailure'] {
  if (obligationId == null) return 'host_review_obligation_missing';
  if (hostAttestationConstants == null) return 'host_attestation_constants_missing';
  return null;
}
