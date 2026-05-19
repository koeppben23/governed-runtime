/**
 * @module integration/review/shared-helpers
 * @description Shared pure functions and constants for review pipeline orchestration.
 *
 * Extracted from plugin-orchestrator.ts and plugin-workspace.ts so review/ modules
 * do not depend on plugin-* files (FG-QUAL-002).
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import type { ReviewInvocationPolicy, ReviewOutputPolicy } from '../../config/policy-types.js';
import { REVIEWER_SUBAGENT_TYPE } from './enforcement/types.js';
import type { OrchestratorClient, ReviewerSuccessResult } from './orchestrator.js';
import { extractReviewContext } from './orchestrator.js';
import { parseToolResult } from '../plugin-helpers.js';
import {
  buildPlanReviewPrompt,
  buildImplReviewPrompt,
  buildArchitectureReviewPrompt,
  selectReviewerProfileRules,
} from './prompt-builders.js';
import {
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_ARCHITECTURE,
} from '../tool-names.js';
import {
  ensureReviewAssurance,
  hasEvidenceReuse,
  buildInvocationEvidence,
  appendInvocationEvidence,
} from './assurance.js';
import { updateObligation } from './obligation-state.js';
import type { ReviewObligationType } from '../../state/evidence.js';
import type {
  OrchestratorDeps,
  AttestationResult,
  EvidenceRecordResult,
  PipelineContext,
  ReviewSessionContext,
} from './pipeline-types.js';
import {
  INVOCATION_MODE_SDK_SESSION,
  EVIDENCE_SOURCE_HOST,
} from './pipeline-types.js';

// ─── Reason Constants ────────────────────────────────────────────────────────

export const REASON_MANDATE_MISSING = 'SUBAGENT_MANDATE_MISSING';
export const REASON_MANDATE_MISMATCH = 'SUBAGENT_MANDATE_MISMATCH';
export const REASON_UNABLE_TO_REVIEW = 'SUBAGENT_UNABLE_TO_REVIEW';

// ─── Strict Attestation Validation ───────────────────────────────────────────

/**
 * Validate strict attestation fields against expected review context values.
 *
 * Content pipeline uses values from reviewCtx; standard pipeline uses
 * module-level constants. Both paths share the same structural check.
 */
export function validateStrictAttestation(
  findings: {
    reviewMode?: string;
    attestation?: Record<string, unknown> | null;
    overallVerdict?: string;
  },
  expected: {
    obligationId: string;
    criteriaVersion: string;
    mandateDigest: string;
    iteration: number;
    planVersion: number;
    checkReviewedBy: boolean;
    checkUnableToReview: boolean;
  },
): AttestationResult {
  const att = findings.attestation;
  if (!att) {
    return {
      valid: false,
      code: REASON_MANDATE_MISSING,
      detail: { obligationId: expected.obligationId },
    };
  }

  const fieldMismatch =
    findings.reviewMode !== 'subagent' ||
    att.toolObligationId !== expected.obligationId ||
    att.iteration !== expected.iteration ||
    att.planVersion !== expected.planVersion ||
    att.criteriaVersion !== expected.criteriaVersion ||
    att.mandateDigest !== expected.mandateDigest ||
    (expected.checkReviewedBy && att.reviewedBy !== REVIEWER_SUBAGENT_TYPE);

  if (fieldMismatch) {
    return {
      valid: false,
      code: REASON_MANDATE_MISMATCH,
      detail: { obligationId: expected.obligationId },
    };
  }

  if (expected.checkUnableToReview && findings.overallVerdict === 'unable_to_review') {
    return {
      valid: false,
      code: REASON_UNABLE_TO_REVIEW,
      detail: { obligationId: expected.obligationId },
    };
  }

  return { valid: true };
}

// ─── Evidence Recording ──────────────────────────────────────────────────────

/**
 * Record invocation evidence or block if evidence was reused.
 *
 * Encapsulates the mutable side-channel pattern (`reusedEvidence` flag)
 * into a clean return value. Both pipelines use this to avoid the
 * fragile let-mutate-in-callback anti-pattern.
 */
export async function recordEvidenceOrBlockReuse(
  deps: OrchestratorDeps,
  sessDir: string,
  params: {
    obligationId: string;
    obligationType: ReviewObligationType;
    sessionId: string;
    childSessionId: string;
    promptHash: string;
    findingsHash: string;
    reviewerResult: Pick<
      ReviewerSuccessResult,
      | 'sessionId'
      | 'reviewOutputMode'
      | 'structuredOutputUsed'
      | 'reviewAssuranceLevel'
      | 'extractionMethod'
      | 'modelCapabilityError'
      | 'findings'
    >;
    currentAssuranceInvocations: unknown[];
  },
): Promise<EvidenceRecordResult> {
  let reused = false;
  await deps.updateReviewAssurance(sessDir, (s, now2) => {
    const assurance = ensureReviewAssurance(s.reviewAssurance);
    if (hasEvidenceReuse(assurance.invocations, params.childSessionId, params.findingsHash)) {
      reused = true;
      return updateObligation(s, params.obligationId, (item) => ({
        ...item,
        status: 'blocked',
        blockedCode: 'SUBAGENT_EVIDENCE_REUSED',
      }));
    }

    const invocation = buildInvocationEvidence({
      obligationId: params.obligationId,
      obligationType: params.obligationType,
      parentSessionId: params.sessionId,
      childSessionId: params.childSessionId,
      invocationMode: INVOCATION_MODE_SDK_SESSION,
      hostVisible: false,
      promptHash: params.promptHash,
      findingsHash: params.findingsHash,
      invokedAt: now2,
      fulfilledAt: now2,
      source: EVIDENCE_SOURCE_HOST,
      reviewOutputMode: params.reviewerResult.reviewOutputMode,
      structuredOutputUsed: params.reviewerResult.structuredOutputUsed,
      reviewAssuranceLevel: params.reviewerResult.reviewAssuranceLevel,
      extractionMethod: params.reviewerResult.extractionMethod,
      modelCapabilityError: params.reviewerResult.modelCapabilityError,
      capturedVerdict:
        params.reviewerResult.findings &&
        typeof params.reviewerResult.findings.overallVerdict === 'string'
          ? params.reviewerResult.findings.overallVerdict
          : undefined,
    });
    const withInvocation = {
      ...s,
      reviewAssurance: appendInvocationEvidence(
        ensureReviewAssurance(s.reviewAssurance),
        invocation,
      ),
    };
    return updateObligation(withInvocation, params.obligationId, (item) => ({
      ...item,
      status: 'fulfilled',
      invocationId: invocation.invocationId,
      fulfilledAt: now2,
    }));
  });
  return reused ? 'reused' : 'fulfilled';
}

// ─── Invocation Helpers ──────────────────────────────────────────────────────

export function buildAttemptFailedLogger(
  deps: OrchestratorDeps,
  toolName: string,
  sessionId: string,
): (info: {
  attempt: number;
  step: string;
  error?: unknown;
  details?: Record<string, unknown>;
}) => void {
  return (info) => {
    deps.log.warn('orchestrator', `reviewer attempt ${info.attempt} failed at ${info.step}`, {
      tool: toolName,
      sessionId,
      step: info.step,
      attempt: info.attempt,
      error: info.error instanceof Error ? info.error.message : String(info.error ?? ''),
      ...(info.details ?? {}),
    });
  };
}

// ─── Policy Helpers ──────────────────────────────────────────────────────────

export function isStrictEnforcementEnabled(sessionState: {
  policySnapshot?: { selfReview?: { strictEnforcement?: boolean } };
}): boolean {
  return sessionState?.policySnapshot?.selfReview?.strictEnforcement === true;
}

export function getReviewerPolicies(sessionState: {
  policySnapshot: { reviewOutputPolicy?: string; reviewInvocationPolicy?: string };
}): { reviewOutputPolicy: ReviewOutputPolicy; reviewInvocationPolicy: ReviewInvocationPolicy } {
  const outputPolicy = sessionState.policySnapshot.reviewOutputPolicy;
  const invocationPolicy = sessionState.policySnapshot?.reviewInvocationPolicy;
  return {
    reviewOutputPolicy:
      outputPolicy === 'structured_required' || outputPolicy === 'text_compat_allowed'
        ? outputPolicy
        : 'structured_required',
    reviewInvocationPolicy:
      invocationPolicy === 'host_task_required' ||
      invocationPolicy === 'host_task_preferred' ||
      invocationPolicy === 'sdk_allowed'
        ? invocationPolicy
        : 'host_task_required',
  };
}

export function isOutputAlreadyBlocked(output: { output: string }): boolean {
  const result = parseToolResult(output.output);
  return result?.error === true;
}

// ─── Context Helpers ─────────────────────────────────────────────────────────

export function buildSessionContext(ctx: PipelineContext): ReviewSessionContext {
  return {
    sessDir: ctx.sessDir,
    sessionId: ctx.sessionId,
    phase: String(ctx.parsedOutput.phase ?? ctx.sessionState.phase),
  };
}

export async function blockReviewOutcomeHelper(
  deps: OrchestratorDeps,
  ctx: PipelineContext,
  code: string,
  detail: Record<string, string>,
): Promise<void> {
  await deps.blockReviewOutcome(
    buildSessionContext(ctx),
    ctx.reviewCtx.obligationId,
    code,
    detail,
    ctx.output,
  );
}

// ─── Prompt Building ─────────────────────────────────────────────────────────

interface BuildToolPromptParams {
  toolName: string;
  texts: { planText: string; ticketText: string; adrText: string; adrTitle: string };
  reviewCtx: NonNullable<ReturnType<typeof extractReviewContext>>;
  parsedOutput: Record<string, unknown>;
  sessionState: SessionState;
  rules: {
    planRules: ReturnType<typeof selectReviewerProfileRules>;
    implRules: ReturnType<typeof selectReviewerProfileRules>;
    archRules: ReturnType<typeof selectReviewerProfileRules>;
  };
  deps: OrchestratorDeps;
}

export function buildToolPrompt(params: BuildToolPromptParams): string | null {
  const { toolName, texts, reviewCtx, parsedOutput, sessionState, rules, deps } = params;
  const { planText, ticketText, adrText, adrTitle } = texts;
  const { planRules, implRules, archRules } = rules;
  if (toolName === TOOL_FLOWGUARD_PLAN) {
    return buildPlanReviewPrompt({
      planText,
      ticketText,
      iteration: reviewCtx.iteration,
      planVersion: reviewCtx.planVersion,
      obligationId: reviewCtx.obligationId,
      criteriaVersion: reviewCtx.criteriaVersion,
      mandateDigest: reviewCtx.mandateDigest,
      ...planRules,
    });
  }
  if (toolName === TOOL_FLOWGUARD_IMPLEMENT) {
    return buildImplReviewPrompt({
      changedFiles: Array.isArray(parsedOutput.changedFiles)
        ? (parsedOutput.changedFiles as string[])
        : (sessionState.implementation?.changedFiles ?? []),
      planText,
      ticketText,
      iteration: reviewCtx.iteration,
      planVersion: reviewCtx.planVersion,
      obligationId: reviewCtx.obligationId,
      criteriaVersion: reviewCtx.criteriaVersion,
      mandateDigest: reviewCtx.mandateDigest,
      ...implRules,
    });
  }
  if (toolName === TOOL_FLOWGUARD_ARCHITECTURE) {
    return buildArchitectureReviewPrompt({
      adrText,
      adrTitle,
      ticketText,
      iteration: reviewCtx.iteration,
      planVersion: reviewCtx.planVersion,
      obligationId: reviewCtx.obligationId,
      criteriaVersion: reviewCtx.criteriaVersion,
      mandateDigest: reviewCtx.mandateDigest,
      ...archRules,
    });
  }
  deps.log.warn('orchestrator', 'unsupported reviewable tool — skipping', { tool: toolName });
  return null;
}

// ─── State + Audit Persistence Helper ────────────────────────────────────────

/**
 * Dependencies needed by {@link recordAssuranceWithAudit}.
 *
 * Uses {@link SessionState} for state mutation typing.
 */
export interface AssuranceAuditDeps {
  updateReviewAssurance(
    sessDir: string,
    update: (state: SessionState, now: string) => SessionState,
  ): Promise<void>;
  appendReviewAuditEvent(
    sessDir: string,
    sessionId: string,
    phase: string,
    event: string,
    detail: Record<string, unknown>,
  ): Promise<void>;
  logError(message: string, err: unknown): void;
}

/**
 * Record a review assurance state mutation together with its audit event.
 *
 * State is committed first (under the session-state write lock). If the
 * audit event fails to persist, the failure is surfaced based on
 * {@code auditFailureBehavior}:
 *
 * - {@code 'block'} — returns a blocked result with code
 *   {@code AUDIT_PERSISTENCE_FAILED}. The state was committed; the
 *   corresponding audit event is missing from the trail.
 * - {@code 'warn'} — logs the error and returns {@code auditOk: false}
 *   without blocking. State was committed; audit event is missing.
 *
 * This helper does NOT make policy decisions. The {@code auditFailureBehavior}
 * parameter must be derived from the active policy by the caller.
 */
export async function recordAssuranceWithAudit(
  deps: AssuranceAuditDeps,
  sessDir: string,
  sessionId: string,
  phase: string,
  stateMutation: (state: SessionState, now: string) => SessionState,
  auditEventName: string,
  auditDetail: Record<string, unknown>,
  auditFailureBehavior: 'block' | 'warn',
): Promise<{ auditOk: boolean; block?: boolean; code?: string; reason?: string }> {
  await deps.updateReviewAssurance(sessDir, stateMutation);

  try {
    await deps.appendReviewAuditEvent(sessDir, sessionId, phase, auditEventName, auditDetail);
    return { auditOk: true };
  } catch (err) {
    deps.logError('Proof persistence failure: audit write failed', err);
    if (auditFailureBehavior === 'block') {
      return {
        auditOk: false,
        block: true,
        code: 'AUDIT_PERSISTENCE_FAILED',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    return { auditOk: false };
  }
}
