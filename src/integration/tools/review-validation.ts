/**
 * @module integration/tools/review-validation
 * @description Shared validation logic for independent review findings.
 *
 * Single authority for all review-findings validation rules used by
 * both /plan and /implement tools. Fail-closed: returns a formatBlocked
 * string on any policy or binding violation, or null when valid.
 *
 * Validation rules:
 * - reviewMode=self is rejected by the ReviewFindings schema
 * - planVersion mismatch → BLOCKED
 * - iteration mismatch → BLOCKED
 * - approve verdict + missing findings → BLOCKED
 */

import type { ReviewFindings } from '../../state/evidence.js';
import { formatBlocked } from './helpers.js';
import {
  findLatestObligation,
  hashFindings,
  validateStrictAttestation,
} from '../review-assurance.js';
import type { ReviewAssuranceState, ReviewObligationType } from '../../state/evidence.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';

// ─── Validation Context ───────────────────────────────────────────────────────

/** Policy and binding context required for review-findings validation. */
export interface ReviewFindingsValidationContext {
  /** Deprecated compatibility field; mandatory subagent review is always required. */
  readonly subagentEnabled: boolean;
  /** Deprecated compatibility field; self-review fallback is always prohibited. */
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
  /** When set, enforce that invocation evidence matches the required policy. */
  readonly reviewInvocationPolicy?: 'host_task_required' | 'host_task_preferred' | 'sdk_allowed';
  /** Parent OpenCode session expected in invocation evidence. */
  readonly reviewParentSessionId?: string;
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
  const reviewMode = (findings as { reviewMode?: unknown }).reviewMode;
  if (reviewMode !== 'subagent') {
    return formatBlocked('REVIEW_MODE_SELF_NOT_ALLOWED', {
      action: 'submit non-subagent review findings',
      policyHint: 'mandatory flowguard-reviewer subagent review required',
    });
  }

  // P1.3 slice 4e: third-verdict tool-layer assertion.
  // The schema (slice 1) accepts overallVerdict='unable_to_review' so
  // that the subagent can declare the artifact unreviewable. However,
  // there is NO legitimate tool-submit path that consumes such findings:
  // - In strict mode, the plugin orchestrator (slice 4c) routes
  //   unable_to_review to BLOCKED before the tool ever sees the findings.
  // - In non-strict / submit-driven flows, a caller passing such findings
  //   would otherwise cause rails to advance state on a 2-valued
  //   selfReviewVerdict ('approve' or 'changes_requested') while the
  //   findings declare the verdict unreviewable — a fabrication-of-
  //   convergence bypass.
  // Per Decision C (obligation IS consumed via SUBAGENT_UNABLE_TO_REVIEW)
  // and Decision G (BLOCKED is the only legitimate outcome on this
  // verdict), this layer fail-closes with the SSOT reason from slice 2.
  if ((findings as { overallVerdict?: unknown }).overallVerdict === 'unable_to_review') {
    return formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', {
      obligationId: ctx.obligationType ?? 'review',
    });
  }

  const expectedIteration = ctx.expectedIteration;
  const expectedPlanVersion = ctx.expectedPlanVersion;

  // Rule 3: planVersion binding
  if (findings.planVersion !== expectedPlanVersion) {
    return formatBlocked('REVIEW_PLAN_VERSION_MISMATCH', {
      provided: String(findings.planVersion),
      expected: String(expectedPlanVersion),
    });
  }

  // Rule 4: iteration binding
  if (findings.iteration !== expectedIteration) {
    return formatBlocked('REVIEW_ITERATION_MISMATCH', {
      provided: String(findings.iteration),
      expected: String(expectedIteration),
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
      expectedIteration,
      expectedPlanVersion,
    );
    if (!obligation || !obligation.pluginHandshakeAt) {
      return formatBlocked('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
        obligationType: ctx.obligationType,
        iteration: String(expectedIteration),
        planVersion: String(expectedPlanVersion),
      });
    }

    if (obligation.status === 'blocked') {
      return formatBlocked('STRICT_REVIEW_ORCHESTRATION_FAILED', {
        code: obligation.blockedCode ?? 'UNKNOWN',
      });
    }

    const submittedFindingsHash = hashFindings(findings);
    const invocation = ctx.assurance.invocations.find((item) =>
      obligation.invocationId
        ? item.invocationId === obligation.invocationId
        : item.obligationId === obligation.obligationId &&
          item.childSessionId === findings.reviewedBy.sessionId &&
          item.findingsHash === submittedFindingsHash,
    );
    if (!invocation) {
      return formatBlocked('SUBAGENT_EVIDENCE_MISSING', {
        obligationId: obligation.obligationId,
      });
    }

    if (
      obligation.status !== 'fulfilled' &&
      !(
        ctx.reviewInvocationPolicy === 'host_task_required' &&
        obligation.status === 'pending' &&
        invocation.obligationId === obligation.obligationId &&
        invocation.invocationMode === 'host_subagent_task' &&
        invocation.hostVisible === true
      )
    ) {
      return formatBlocked('SUBAGENT_EVIDENCE_MISSING', {
        obligationId: obligation.obligationId,
      });
    }

    const attestationError = validateStrictAttestation(findings, {
      obligationId: obligation.obligationId,
      iteration: expectedIteration,
      planVersion: expectedPlanVersion,
    });
    if (attestationError) {
      return formatBlocked(attestationError, {
        obligationId: obligation.obligationId,
      });
    }

    if (invocation.obligationId !== obligation.obligationId) {
      return formatBlocked('SUBAGENT_MANDATE_MISMATCH', {
        obligationId: obligation.obligationId,
      });
    }

    if (findings.reviewedBy.sessionId !== invocation.childSessionId) {
      return formatBlocked('REVIEW_FINDINGS_SESSION_MISMATCH', {
        provided: findings.reviewedBy.sessionId,
        expected: invocation.childSessionId,
      });
    }

    if (submittedFindingsHash !== invocation.findingsHash) {
      return formatBlocked('REVIEW_FINDINGS_HASH_MISMATCH', {
        obligationId: obligation.obligationId,
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

    if (
      ctx.reviewInvocationPolicy === 'host_task_required' &&
      (invocation.invocationMode !== 'host_subagent_task' ||
        invocation.hostVisible !== true ||
        invocation.agentType !== REVIEWER_SUBAGENT_TYPE ||
        invocation.parentSessionId !== ctx.reviewParentSessionId ||
        invocation.criteriaVersion !== obligation.criteriaVersion ||
        invocation.mandateDigest !== obligation.mandateDigest)
    ) {
      return formatBlocked('SUBAGENT_EVIDENCE_MISSING', {
        obligationId: obligation.obligationId,
        reason:
          'expected host-visible flowguard-reviewer Task evidence bound to the active session, mandate, criteria, child session, and findings hash',
      });
    }
  }

  return null;
}

/**
 * Check whether a review verdict requires review findings.
 * Covers approve and changes_requested verdicts in mandatory review mode.
 *
 * @returns formatBlocked string if findings are required but missing, null otherwise.
 */
export function requireReviewFindings(hasFindings: boolean): string | null {
  if (!hasFindings) {
    return formatBlocked('REVIEW_FINDINGS_REQUIRED', {
      action: 'mandatory subagent review',
      required: 'reviewFindings',
    });
  }
  return null;
}
