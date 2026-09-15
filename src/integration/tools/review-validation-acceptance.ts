/**
 * @module integration/tools/review-validation-acceptance
 * @description Shared acceptance/rejection types and helpers for review
 *              findings validation. Used by both core and host-task modules.
 *
 * @version v1
 */

import type { ReviewObligation, ReviewInvocationEvidence } from '../../state/evidence.js';
import { formatBlocked } from './helpers.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';

// ─── Acceptance / Rejection Types ─────────────────────────────────────────────

type ReviewFindingsAcceptanceRejectionReason =
  'STRICT_REVIEW_ORCHESTRATION_FAILED' | 'SUBAGENT_EVIDENCE_REUSED';

type ReviewFindingsAcceptanceRejectionStatus = ReviewObligation['status'] | 'invocation_consumed';

export interface ReviewFindingsAcceptanceRejection {
  readonly reason: ReviewFindingsAcceptanceRejectionReason;
  readonly status: ReviewFindingsAcceptanceRejectionStatus;
  readonly obligationId?: string;
  readonly invocationId?: string;
  readonly consumedBy?: string;
  readonly blockedCode?: string | null;
}

// ─── Acceptance / Rejection Helpers ───────────────────────────────────────────

export function getReviewFindingsAcceptanceRejection(input: {
  readonly obligation: ReviewObligation;
  readonly invocation?: ReviewInvocationEvidence;
}): ReviewFindingsAcceptanceRejection | null {
  const { obligation, invocation } = input;
  if (obligation.status === 'blocked') {
    return {
      reason: 'STRICT_REVIEW_ORCHESTRATION_FAILED',
      status: 'blocked',
      obligationId: obligation.obligationId,
      blockedCode: obligation.blockedCode ?? 'UNKNOWN',
    };
  }

  if (obligation.status === 'consumed' || obligation.consumedAt !== null) {
    return {
      reason: 'SUBAGENT_EVIDENCE_REUSED',
      status: 'consumed',
      obligationId: obligation.obligationId,
    };
  }

  if (
    invocation?.consumedByObligationId !== null &&
    invocation?.consumedByObligationId !== undefined
  ) {
    return {
      reason: 'SUBAGENT_EVIDENCE_REUSED',
      status: 'invocation_consumed',
      invocationId: invocation.invocationId,
      consumedBy: invocation.consumedByObligationId,
    };
  }

  return null;
}

/** Canonical provenance contract for captured host-observed reviewer evidence. */
export function hasValidStructuredInvocationContract(input: {
  readonly obligation: ReviewObligation;
  readonly invocation: ReviewInvocationEvidence;
  /** Omit only where no active parent session is available to the caller. */
  readonly parentSessionId?: string;
}): boolean {
  const { obligation, invocation, parentSessionId } = input;
  return (
    invocation.invocationMode === 'sdk_session_prompt' &&
    invocation.agentType === REVIEWER_SUBAGENT_TYPE &&
    (parentSessionId === undefined || invocation.parentSessionId === parentSessionId) &&
    invocation.criteriaVersion === obligation.criteriaVersion &&
    invocation.mandateDigest === obligation.mandateDigest
  );
}

function acceptanceRejectionFormatVars(
  rejection: ReviewFindingsAcceptanceRejection,
): Record<string, string> {
  if (rejection.reason === 'STRICT_REVIEW_ORCHESTRATION_FAILED') {
    return { code: rejection.blockedCode ?? 'UNKNOWN' };
  }
  if (rejection.status === 'invocation_consumed') {
    return {
      invocationId: rejection.invocationId ?? 'unknown',
      consumedBy: rejection.consumedBy ?? 'unknown',
    };
  }
  return { obligationId: rejection.obligationId ?? 'unknown' };
}

export function formatAcceptanceRejection(rejection: ReviewFindingsAcceptanceRejection): string {
  return formatBlocked(rejection.reason, acceptanceRejectionFormatVars(rejection));
}
