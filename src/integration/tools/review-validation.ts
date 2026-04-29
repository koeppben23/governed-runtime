/**
 * @module integration/tools/review-validation
 * @description Shared validation logic for independent review findings.
 *
 * Single authority for all review-findings validation rules used by
 * both /plan and /implement tools. Fail-closed: returns a formatBlocked
 * string on any policy or binding violation, or null when valid.
 *
 * Validation rules:
 * - reviewMode=subagent + !subagentEnabled → BLOCKED
 * - reviewMode=self + subagentEnabled + !fallbackToSelf → BLOCKED
 * - planVersion mismatch → BLOCKED
 * - iteration mismatch → BLOCKED
 * - approve verdict + subagentEnabled + missing findings → BLOCKED
 */

import type { ReviewFindings } from '../../state/evidence.js';
import { formatBlocked } from './helpers.js';
import { findLatestObligation, validateStrictAttestation } from '../review-assurance.js';
import type { ReviewAssuranceState, ReviewObligationType } from '../../state/evidence.js';

// ─── Validation Context ───────────────────────────────────────────────────────

/** Policy and binding context required for review-findings validation. */
export interface ReviewFindingsValidationContext {
  /** Whether subagent-based review is enabled in policy. */
  readonly subagentEnabled: boolean;
  /** Whether self-review is allowed as fallback when subagent is enabled. */
  readonly fallbackToSelf: boolean;
  /** Expected plan version (history.length + 1). */
  readonly expectedPlanVersion: number;
  /** Expected iteration number for the current mode/phase. */
  readonly expectedIteration: number;
  /** Strict assurance mode flag. */
  readonly strictEnforcement?: boolean;
  /** Strict assurance store from state. */
  readonly assurance?: ReviewAssuranceState;
  /** Obligation type for strict checks. */
  readonly obligationType?: ReviewObligationType;
}

// ─── Core Validation ──────────────────────────────────────────────────────────

/**
 * Validate review findings against policy and binding constraints.
 *
 * @returns formatBlocked string if validation fails, null if valid.
 */
export function validateReviewFindings(
  findings: ReviewFindings,
  ctx: ReviewFindingsValidationContext,
): string | null {
  // Rule 1: subagent mode requires policy enabled
  if (findings.reviewMode === 'subagent' && !ctx.subagentEnabled) {
    return formatBlocked('REVIEW_MODE_SUBAGENT_DISABLED', {
      action: 'submit subagent review findings',
      policy: 'selfReview.subagentEnabled',
    });
  }

  // Rule 2: self mode requires fallbackToSelf when subagent enabled
  if (findings.reviewMode === 'self' && ctx.subagentEnabled && !ctx.fallbackToSelf) {
    return formatBlocked('REVIEW_MODE_SELF_NOT_ALLOWED', {
      action: 'submit self-review findings',
      policyHint: 'selfReview.fallbackToSelf=true required',
    });
  }

  // Rule 3: planVersion binding
  if (findings.planVersion !== ctx.expectedPlanVersion) {
    return formatBlocked('REVIEW_PLAN_VERSION_MISMATCH', {
      provided: String(findings.planVersion),
      expected: String(ctx.expectedPlanVersion),
    });
  }

  // Rule 4: iteration binding
  if (findings.iteration !== ctx.expectedIteration) {
    return formatBlocked('REVIEW_ITERATION_MISMATCH', {
      provided: String(findings.iteration),
      expected: String(ctx.expectedIteration),
    });
  }

  if (ctx.strictEnforcement) {
    if (!ctx.assurance || !ctx.obligationType) {
      return formatBlocked('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
        required: 'strict review assurance state',
      });
    }

    const obligation = findLatestObligation(
      ctx.assurance.obligations,
      ctx.obligationType,
      ctx.expectedIteration,
      ctx.expectedPlanVersion,
    );
    if (!obligation || !obligation.pluginHandshakeAt) {
      return formatBlocked('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
        obligationType: ctx.obligationType,
        iteration: String(ctx.expectedIteration),
        planVersion: String(ctx.expectedPlanVersion),
      });
    }

    if (obligation.status === 'blocked') {
      return formatBlocked('STRICT_REVIEW_ORCHESTRATION_FAILED', {
        code: obligation.blockedCode ?? 'UNKNOWN',
      });
    }

    if (obligation.status !== 'fulfilled' || !obligation.invocationId) {
      return formatBlocked('SUBAGENT_EVIDENCE_MISSING', {
        obligationId: obligation.obligationId,
      });
    }

    const attestationError = validateStrictAttestation(findings, {
      obligationId: obligation.obligationId,
      iteration: ctx.expectedIteration,
      planVersion: ctx.expectedPlanVersion,
    });
    if (attestationError) {
      return formatBlocked(attestationError, {
        obligationId: obligation.obligationId,
      });
    }

    const invocation = ctx.assurance.invocations.find(
      (item) => item.invocationId === obligation.invocationId,
    );
    if (!invocation) {
      return formatBlocked('SUBAGENT_EVIDENCE_MISSING', {
        invocationId: obligation.invocationId,
      });
    }

    if (
      invocation.consumedByObligationId &&
      invocation.consumedByObligationId !== obligation.obligationId
    ) {
      return formatBlocked('SUBAGENT_EVIDENCE_REUSED', {
        invocationId: invocation.invocationId,
        consumedBy: invocation.consumedByObligationId,
      });
    }
  }

  return null;
}

/**
 * Check whether an approve verdict requires review findings.
 *
 * @returns formatBlocked string if findings are required but missing, null otherwise.
 */
export function requireFindingsForApprove(
  subagentEnabled: boolean,
  hasFindings: boolean,
): string | null {
  if (subagentEnabled && !hasFindings) {
    return formatBlocked('REVIEW_FINDINGS_REQUIRED_FOR_APPROVE', {
      action: 'approve with subagentEnabled=true',
      required: 'reviewFindings',
    });
  }
  return null;
}
