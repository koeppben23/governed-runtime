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
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import {
  findLatestObligation,
  hashFindings,
  validateStrictAttestation,
} from '../review/assurance.js';
import type {
  ReviewAssuranceState,
  ReviewObligationType,
  ReviewObligation,
  ReviewInvocationEvidence,
} from '../../state/evidence.js';
import {
  REVIEWER_SUBAGENT_TYPE,
  REVIEW_ACCEPTANCE_PATH_NATIVE,
} from '../../shared/flowguard-identifiers.js';
import {
  getReviewFindingsAcceptanceRejection,
  formatAcceptanceRejection,
  formatHostTaskAcceptanceRejection,
} from './review-validation-acceptance.js';
import { resolveHostTaskFindings } from './review-validation-host-task.js';

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
  /** Runtime host platform for transport-specific strict evidence validation. */
  readonly reviewHostPlatform?: 'opencode' | 'claude-code' | 'codex' | 'unknown';
}

interface AttestedReviewCheckInput {
  readonly findings: ReviewFindings;
  readonly obligation: ReviewObligation;
  readonly invocation: ReviewInvocationEvidence;
  readonly findingsHash: string;
  readonly ctx: ReviewFindingsValidationContext;
}

/**
 * Shared evidence checks for any agent-submitted attested review (manual_attested and
 * its strict superset native_subagent_attested). Excludes the invocationMode check so
 * each tier can assert its own mode plus tier-specific corroboration. The policy
 * predicate here only ever permits host_task_preferred / sdk_allowed, so neither tier
 * can satisfy host_task_required (which is validated on a separate, stricter branch).
 */
function baseAgentAttestedChecks(input: AttestedReviewCheckInput): boolean[] {
  const { findings, obligation, invocation, findingsHash, ctx } = input;
  const isExternalHost =
    ctx.reviewHostPlatform === 'claude-code' || ctx.reviewHostPlatform === 'codex';
  const policyAllowsManualAttested =
    ctx.reviewInvocationPolicy === 'sdk_allowed' ||
    ctx.reviewInvocationPolicy === 'host_task_preferred';
  // #434 (M1): reuse the single canonical acceptance authority instead of
  // re-deriving the blocked/consumed/consumedAt predicate inline. A null
  // rejection means the obligation is open (not blocked, not consumed,
  // consumedAt === null) — exactly what the strict path also requires.
  const obligationAcceptable = getReviewFindingsAcceptanceRejection({ obligation }) === null;
  return [
    isExternalHost,
    policyAllowsManualAttested,
    obligationAcceptable,
    invocation.hostVisible === false,
    invocation.source === 'agent-submitted-attested',
    invocation.obligationId === obligation.obligationId,
    invocation.obligationType === obligation.obligationType,
    invocation.childSessionId === findings.reviewedBy.sessionId,
    invocation.findingsHash === findingsHash,
    invocation.criteriaVersion === obligation.criteriaVersion,
    invocation.mandateDigest === obligation.mandateDigest,
    invocation.consumedByObligationId === null,
    invocation.childSessionId !== ctx.reviewParentSessionId,
    findings.reviewedBy.sessionId !== ctx.reviewParentSessionId,
  ];
}

function allowsManualAttestedReviewWithoutPluginHandshake(
  input: AttestedReviewCheckInput,
): boolean {
  const checks = [
    ...baseAgentAttestedChecks(input),
    input.invocation.invocationMode === 'manual_attested',
  ];
  return checks.every((check) => check === true);
}

/**
 * Shared pre-acceptance gate: is first-party plugin enforcement unavailable for this
 * submission? Enforcement is available only when the plugin actually handshook
 * (`pluginHandshakeAt`) or when a policy-gated `manual_attested` invocation is permitted.
 *
 * native_subagent_attested corroboration lives in `reviewer-captures.jsonl`, which is
 * append-only plaintext with no hash chain (agent-writable). It therefore does NOT
 * establish enforcement availability: without a plugin handshake the native path fails
 * closed exactly like solo / host_task_preferred, never accept (#419). This is the single
 * canonical authority for the unavailable-enforcement deny — no per-path duplicate.
 */
function pluginEnforcementUnavailableForReviewAcceptance(input: AttestedReviewCheckInput): boolean {
  return (
    !input.obligation.pluginHandshakeAt && !allowsManualAttestedReviewWithoutPluginHandshake(input)
  );
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
      policyHint: `mandatory ${REVIEWER_SUBAGENT_TYPE} subagent review required`,
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
  //   reviewVerdict ('accept' or 'changes_requested') while the
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

  if (ctx.strictEnforcement) return validateStrictReviewFindings(findings, ctx);

  return null;
}

interface StrictReviewBinding {
  readonly obligation: ReviewObligation;
  readonly invocation: ReviewInvocationEvidence;
  readonly submittedFindingsHash: string;
  readonly isHostTaskMode: boolean;
}

function validateStrictReviewFindings(
  findings: ReviewFindings,
  ctx: ReviewFindingsValidationContext,
): string | null {
  const binding = resolveStrictReviewBinding(findings, ctx);
  if (typeof binding === 'string') return binding;
  return (
    validateStrictReviewRejections(binding) ??
    validateStrictReviewIdentity(findings, ctx, binding) ??
    validateStrictReviewAcceptance(findings, ctx, binding) ??
    validateStrictReviewAttestation(findings, ctx, binding.obligation) ??
    validateStrictReviewInvocationBinding(findings, ctx, binding)
  );
}

function resolveStrictReviewBinding(
  findings: ReviewFindings,
  ctx: ReviewFindingsValidationContext,
): StrictReviewBinding | string {
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
  if (!obligation) return missingStrictObligation(ctx);
  const submittedFindingsHash = hashFindings(findings);
  const isHostTaskMode = ctx.reviewInvocationPolicy === 'host_task_required';
  const invocation = findStrictInvocation(ctx, obligation, findings, submittedFindingsHash);
  if (!invocation) {
    return formatBlocked('SUBAGENT_EVIDENCE_MISSING', { obligationId: obligation.obligationId });
  }
  return { obligation, invocation, submittedFindingsHash, isHostTaskMode };
}

function missingStrictObligation(ctx: ReviewFindingsValidationContext): string {
  return formatBlocked('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
    obligationType: ctx.obligationType ?? 'review',
    iteration: String(ctx.expectedIteration),
    planVersion: String(ctx.expectedPlanVersion),
  });
}

function findStrictInvocation(
  ctx: ReviewFindingsValidationContext,
  obligation: ReviewObligation,
  findings: ReviewFindings,
  submittedFindingsHash: string,
): ReviewInvocationEvidence | undefined {
  const isHostTaskMode = ctx.reviewInvocationPolicy === 'host_task_required';
  return ctx.assurance?.invocations.find((item) =>
    obligation.invocationId
      ? item.invocationId === obligation.invocationId
      : item.obligationId === obligation.obligationId &&
        (isHostTaskMode
          ? item.invocationMode === 'host_subagent_task'
          : item.childSessionId === findings.reviewedBy.sessionId &&
            item.findingsHash === submittedFindingsHash),
  );
}

function validateStrictReviewRejections(binding: StrictReviewBinding): string | null {
  const obligationRejection = getReviewFindingsAcceptanceRejection({
    obligation: binding.obligation,
  });
  if (obligationRejection) return formatAcceptanceRejection(obligationRejection);
  const invocationRejection = getReviewFindingsAcceptanceRejection({
    obligation: binding.obligation,
    invocation: binding.invocation,
  });
  return invocationRejection ? formatAcceptanceRejection(invocationRejection) : null;
}

function validateStrictReviewIdentity(
  findings: ReviewFindings,
  ctx: ReviewFindingsValidationContext,
  binding: StrictReviewBinding,
): string | null {
  const { obligation, invocation } = binding;
  const attestedMode =
    invocation.invocationMode === 'manual_attested' ||
    invocation.invocationMode === 'native_subagent_attested';
  const selfSession =
    invocation.childSessionId === ctx.reviewParentSessionId ||
    findings.reviewedBy.sessionId === ctx.reviewParentSessionId;
  return attestedMode && selfSession
    ? formatBlocked('REVIEW_SELF_APPROVAL_DENIED', { obligationId: obligation.obligationId })
    : null;
}

function validateStrictReviewAcceptance(
  findings: ReviewFindings,
  ctx: ReviewFindingsValidationContext,
  binding: StrictReviewBinding,
): string | null {
  const { obligation, invocation, submittedFindingsHash } = binding;
  if (
    pluginEnforcementUnavailableForReviewAcceptance({
      findings,
      obligation,
      invocation,
      findingsHash: submittedFindingsHash,
      ctx,
    })
  ) {
    return formatBlocked('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      obligationType: ctx.obligationType ?? 'review',
      iteration: String(ctx.expectedIteration),
      planVersion: String(ctx.expectedPlanVersion),
      ...(invocation.invocationMode === 'native_subagent_attested'
        ? { deniedReviewPath: REVIEW_ACCEPTANCE_PATH_NATIVE }
        : {}),
    });
  }
  return isStrictObligationConsumable(ctx, binding)
    ? null
    : formatBlocked('SUBAGENT_EVIDENCE_MISSING', { obligationId: obligation.obligationId });
}

function isStrictObligationConsumable(
  ctx: ReviewFindingsValidationContext,
  binding: StrictReviewBinding,
): boolean {
  const { obligation, invocation } = binding;
  return (
    obligation.status === 'fulfilled' ||
    (ctx.reviewInvocationPolicy === 'host_task_required' &&
      obligation.status === 'pending' &&
      invocation.obligationId === obligation.obligationId &&
      invocation.invocationMode === 'host_subagent_task' &&
      invocation.hostVisible === true)
  );
}

function validateStrictReviewAttestation(
  findings: ReviewFindings,
  ctx: ReviewFindingsValidationContext,
  obligation: ReviewObligation,
): string | null {
  const attestationError = validateStrictAttestation(findings, {
    obligationId: obligation.obligationId,
    iteration: ctx.expectedIteration,
    planVersion: ctx.expectedPlanVersion,
  });
  return attestationError
    ? formatBlocked(attestationError, { obligationId: obligation.obligationId })
    : null;
}

function validateStrictReviewInvocationBinding(
  findings: ReviewFindings,
  ctx: ReviewFindingsValidationContext,
  binding: StrictReviewBinding,
): string | null {
  return (
    validateInvocationObligationId(binding) ??
    validateInvocationSessionId(findings, binding) ??
    validateInvocationFindingsHash(findings, binding) ??
    validateHostTaskInvocationContract(ctx, binding)
  );
}

function validateInvocationObligationId(binding: StrictReviewBinding): string | null {
  const { obligation, invocation } = binding;
  return invocation.obligationId !== obligation.obligationId
    ? formatBlocked('SUBAGENT_MANDATE_MISMATCH', { obligationId: obligation.obligationId })
    : null;
}

function validateInvocationSessionId(
  findings: ReviewFindings,
  binding: StrictReviewBinding,
): string | null {
  if (
    findings.reviewedBy.sessionId === binding.invocation.childSessionId ||
    binding.isHostTaskMode
  ) {
    return null;
  }
  return formatBlocked('REVIEW_FINDINGS_SESSION_MISMATCH', {
    provided: findings.reviewedBy.sessionId,
    expected: binding.invocation.childSessionId,
  });
}

function validateInvocationFindingsHash(
  findings: ReviewFindings,
  binding: StrictReviewBinding,
): string | null {
  const { obligation, invocation, submittedFindingsHash, isHostTaskMode } = binding;
  if (isHostTaskMode && invocation.capturedVerdict) {
    const submittedVerdict = (findings as { overallVerdict?: string }).overallVerdict;
    return submittedVerdict === invocation.capturedVerdict
      ? null
      : formatBlocked('REVIEW_FINDINGS_HASH_MISMATCH', { obligationId: obligation.obligationId });
  }
  return submittedFindingsHash === invocation.findingsHash
    ? null
    : formatBlocked('REVIEW_FINDINGS_HASH_MISMATCH', { obligationId: obligation.obligationId });
}

function validateHostTaskInvocationContract(
  ctx: ReviewFindingsValidationContext,
  binding: StrictReviewBinding,
): string | null {
  const { obligation, invocation } = binding;
  if (ctx.reviewInvocationPolicy !== 'host_task_required') return null;
  const valid =
    invocation.invocationMode === 'host_subagent_task' &&
    invocation.hostVisible === true &&
    invocation.agentType === REVIEWER_SUBAGENT_TYPE &&
    invocation.parentSessionId === ctx.reviewParentSessionId &&
    invocation.criteriaVersion === obligation.criteriaVersion &&
    invocation.mandateDigest === obligation.mandateDigest;
  return valid
    ? null
    : formatBlocked('SUBAGENT_EVIDENCE_MISSING', {
        obligationId: obligation.obligationId,
        reason: `expected host-visible ${REVIEWER_SUBAGENT_TYPE} Task evidence bound to the active session, mandate, criteria, child session, and findings hash`,
      });
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

// ─── Host Task Effective Findings Resolution ───────────────────────────────────

interface HostTaskResolutionContext {
  readonly pendingObligation: ReviewObligation | null;
  readonly expected: {
    readonly obligationType: ReviewObligationType;
    readonly iteration: number;
    readonly planVersion: number;
  };
  readonly policy: {
    readonly reviewInvocationPolicy?: 'host_task_required' | 'host_task_preferred' | 'sdk_allowed';
    readonly strictEnforcement: boolean;
    readonly subagentEnabled: boolean;
    readonly fallbackToSelf: boolean;
  };
  readonly input: {
    readonly reviewFindings?: unknown;
    readonly reviewerUnavailable?: boolean;
    readonly verdict?: string;
  };
  readonly state: {
    readonly assurance?: ReviewAssuranceState;
    readonly sessionId: string;
    readonly reviewHostPlatform?: 'opencode' | 'claude-code' | 'codex' | 'unknown';
  };
}

interface HostTaskResolutionResult {
  readonly effectiveFindings?: ReviewFindings;
  readonly evidenceInvocationId?: string;
  readonly blocked?: ReturnType<typeof formatBlocked>;
}

export function resolveHostTaskEffectiveFindings(
  ctx: HostTaskResolutionContext,
): HostTaskResolutionResult {
  const isHostTaskMode = ctx.policy.reviewInvocationPolicy === 'host_task_required';

  if (isHostTaskMode) {
    if (ctx.input.reviewFindings) {
      // Diagnostic for error analysis: in host-task mode the agent must submit
      // the verdict ONLY — findings are resolved from captured invocation
      // evidence below. Submitting (and especially hand-editing) reviewFindings
      // here is the leading cause of SUBAGENT_SESSION_MISMATCH / hash-mismatch
      // confusion. The submitted findings are intentionally ignored; surface the
      // misuse so it can be diagnosed from logs.
      getAdapterLogger().warn(
        'flowguard_review',
        'reviewFindings submitted in host-task mode are ignored; verdict-only is expected',
        {
          sessionId: ctx.state.sessionId,
          obligationType: ctx.expected.obligationType,
          iteration: ctx.expected.iteration,
          planVersion: ctx.expected.planVersion,
        },
      );
    }
    const resolved = resolveHostTaskFindings(ctx.state.assurance, ctx.pendingObligation);
    if (resolved.kind === 'resolved') {
      return {
        effectiveFindings: resolved.findings,
        evidenceInvocationId: resolved.invocation.invocationId,
      };
    }
    if (resolved.kind === 'rejected') {
      return { blocked: formatHostTaskAcceptanceRejection(resolved.rejection) };
    }
    if (resolved.kind === 'unparseable') {
      // The reviewer ran and evidence was captured, but the captured findings
      // are not schema-valid. Emit a DISTINCT block so this is not confused with
      // "reviewer never ran" (REVIEW_FINDINGS_REQUIRED).
      return {
        blocked: formatBlocked('HOST_TASK_FINDINGS_UNPARSEABLE', { message: resolved.detail }),
      };
    }
    if (ctx.input.reviewerUnavailable === true) {
      return {
        blocked: formatBlocked('REVIEWER_UNAVAILABLE_STRICT', {
          reason: 'reviewer unavailable; independent ReviewFindings remain required',
          recovery:
            'Invoke a supported reviewer transport or provide policy-gated manual_attested ReviewFindings bound to the active obligation. flowguard_decision does not replace review evidence.',
        }),
      };
    }
    return {};
  } else if (ctx.input.reviewFindings) {
    const blocked = validateReviewFindings(ctx.input.reviewFindings as ReviewFindings, {
      subagentEnabled: ctx.policy.subagentEnabled,
      fallbackToSelf: ctx.policy.fallbackToSelf,
      expectedPlanVersion: ctx.expected.planVersion,
      expectedIteration: ctx.expected.iteration,
      strictEnforcement: ctx.policy.strictEnforcement,
      assurance: ctx.state.assurance,
      obligationType: ctx.expected.obligationType,
      reviewInvocationPolicy: ctx.policy.reviewInvocationPolicy,
      reviewParentSessionId: ctx.state.sessionId,
      reviewHostPlatform: ctx.state.reviewHostPlatform,
    });
    if (blocked) return { blocked };
    return { effectiveFindings: ctx.input.reviewFindings as ReviewFindings };
  }

  return {};
}

export { resolveHostTaskFindings } from './review-validation-host-task.js';
export type {
  ResolvedHostTaskFindings,
  HostTaskFindingsResolution,
} from './review-validation-host-task.js';
export type {
  ReviewFindingsAcceptanceRejection,
  HostTaskFindingsAcceptanceRejection,
} from './review-validation-acceptance.js';
