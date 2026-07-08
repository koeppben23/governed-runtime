/**
 * @module integration/tools/review-validation-acceptance
 * @description Shared acceptance/rejection types and helpers for review
 *              findings validation. Used by both core and host-task modules.
 *
 * @version v1
 */

import type { ReviewObligation, ReviewInvocationEvidence } from '../../state/evidence.js';
import { formatBlocked } from './helpers.js';
import { HOST_TASK_FINDINGS_REJECTION_FIELD } from '../../shared/flowguard-identifiers.js';

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

export type HostTaskFindingsAcceptanceRejection = ReviewFindingsAcceptanceRejection & {
  readonly path: 'host_task';
};

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

export function withHostTaskPath(
  rejection: ReviewFindingsAcceptanceRejection,
): HostTaskFindingsAcceptanceRejection {
  return { ...rejection, path: 'host_task' };
}

export function formatAcceptanceRejection(rejection: ReviewFindingsAcceptanceRejection): string {
  return formatBlocked(rejection.reason, acceptanceRejectionFormatVars(rejection));
}

export function formatHostTaskAcceptanceRejection(
  rejection: HostTaskFindingsAcceptanceRejection,
): string {
  const vars = acceptanceRejectionFormatVars(rejection);
  return formatBlocked(rejection.reason, vars, {
    [HOST_TASK_FINDINGS_REJECTION_FIELD]: {
      path: rejection.path,
      reason: rejection.reason,
      status: rejection.status,
      ...(rejection.obligationId ? { obligationId: rejection.obligationId } : {}),
      ...(rejection.invocationId ? { invocationId: rejection.invocationId } : {}),
    },
  });
}
