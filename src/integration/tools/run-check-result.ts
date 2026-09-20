/**
 * @module integration/tools/run-check-result
 * @description Pure result, subject, and next-state builders for the
 *              `flowguard_run_check` production path.
 *
 * Extracted from `run-check-tool.ts` so the tool module stays within the
 * production file-size budget. These helpers perform no I/O and read no state
 * beyond the values passed in; behavior is identical to the previous inline
 * definitions.
 */

import type { SessionState } from '../../state/schema.js';
import type {
  AssertionExtractionResult,
  ValidationAttempt,
  ValidationExecutionObservation,
  ValidationOutcome,
  ValidationResult,
} from '../../state/evidence-validation.js';
import { isTechnicalValidationBlock } from '../../state/evidence-validation.js';
import type {
  AssertionCapability,
  FullCheckScopeAttestation,
} from '../../state/discovery-schemas.js';
import type { executeCheck } from '../../verification/executor.js';
import type { deriveRepairGuidance } from '../../verification/repair-guidance.js';
import { IntegrationInvariantError } from '../errors.js';
import { formatBlocked } from '../blocked-result.js';

import { formatValidationDetail } from './run-check-presentation.js';

export type CheckEvidence = Awaited<ReturnType<typeof executeCheck>>;

export function buildValidationResult(params: {
  checkId: string;
  candidateId?: string | undefined;
  evidence: CheckEvidence;
  outcome: ValidationOutcome;
  derivedRepairGuidance: ReturnType<typeof deriveRepairGuidance>;
  extraction?: AssertionExtractionResult | undefined;
  fullCheckScopeAttestation?: FullCheckScopeAttestation | undefined;
  classificationReasonOverride?: string | undefined;
}): ValidationResult {
  const {
    checkId,
    candidateId,
    evidence,
    outcome,
    derivedRepairGuidance,
    extraction,
    fullCheckScopeAttestation,
    classificationReasonOverride,
  } = params;
  const passed = outcome === 'supported';
  return {
    checkId,
    candidateId,
    passed,
    detail: formatValidationDetail(evidence, extraction),
    executedAt: evidence.startedAt,
    kind: evidence.kind,
    command: evidence.command,
    exitCode: evidence.exitCode,
    executionMs: evidence.executionMs,
    outputDigest: evidence.outputDigest,
    timedOut: evidence.timedOut,
    outcome,
    classificationReason:
      classificationReasonOverride ??
      (passed ? undefined : `exitCode=${evidence.exitCode}, timedOut=${evidence.timedOut}`),
    derivedRepairGuidance,
    assertionExtraction: extraction,
    fullCheckScopeAttestation,
  };
}

export function classifyValidationOutcome(
  execution: CheckEvidence,
  extraction: AssertionExtractionResult | undefined,
  capability: AssertionCapability,
): ValidationOutcome {
  if (execution.timedOut) return 'blocked';

  if (capability === 'structured' && extraction) {
    switch (extraction.status) {
      case 'blocked':
        return 'blocked';
      case 'inconclusive':
        return 'inconclusive';
      case 'not_configured':
        return 'blocked';
      case 'extracted':
        if (extraction.summary.suiteInfrastructureError) return 'blocked';
        return execution.passed ? 'supported' : 'inconclusive';
    }
  }

  if (execution.passed) return 'supported';
  const output = `${execution.stdout}\n${execution.stderr}`.trim();
  return output.length === 0 ? 'blocked' : 'inconclusive';
}

export function mergeValidationResult(
  state: SessionState,
  validationResult: ValidationResult,
): ValidationResult[] {
  // Post-implementation checks (IMPL_VALIDATION) accumulate in implValidation; the
  // pre-implementation baseline run (VALIDATION) accumulates in validation.
  const slot = state.phase === 'IMPL_VALIDATION' ? state.implValidation : state.validation;
  return [...slot.filter((v) => v.checkId !== validationResult.checkId), validationResult];
}

export type ValidationSubject =
  | { readonly scope: 'baseline'; readonly planDigest: string }
  | { readonly scope: 'implementation'; readonly implementationDigest: string };

export function freezeValidationSubject(state: SessionState): ValidationSubject {
  if (state.phase === 'VALIDATION') {
    const plan = state.plan;
    if (!plan) {
      throw new IntegrationInvariantError(
        'VALIDATION_PLAN_REQUIRED',
        'VALIDATION phase requires plan evidence to freeze the validation subject',
      );
    }
    return {
      scope: 'baseline',
      planDigest: plan.current.digest,
    };
  }
  const implementation = state.implementation;
  if (!implementation) {
    throw new IntegrationInvariantError(
      'VALIDATION_IMPLEMENTATION_REQUIRED',
      'implementation validation requires implementation evidence to freeze the validation subject',
    );
  }
  return {
    scope: 'implementation',
    implementationDigest: implementation.digest,
  };
}

function validationSubjectMatches(state: SessionState, subject: ValidationSubject): boolean {
  return subject.scope === 'baseline'
    ? state.phase === 'VALIDATION' && state.plan?.current.digest === subject.planDigest
    : state.phase === 'IMPL_VALIDATION' &&
        state.implementation?.digest === subject.implementationDigest;
}

export function validationSubjectBlock(
  state: SessionState,
  subject: ValidationSubject,
): string | null {
  return validationSubjectMatches(state, subject)
    ? null
    : formatBlocked('VALIDATION_SUBJECT_CHANGED');
}

export function buildValidationAttempt(
  subject: ValidationSubject,
  result: ValidationResult,
  attemptId: string,
  executionObservation: ValidationExecutionObservation,
): ValidationAttempt {
  return { attemptId, ...subject, executionObservation, result };
}

export function buildNextValidationState(
  state: SessionState,
  validation: ValidationResult[],
  validationAttempt: ValidationAttempt,
): SessionState {
  // Canonical disposition authority: only a proven artifact failure may clear
  // approval/implementation authority. A technical block (blocked outcome,
  // execution error, inconclusive extraction) keeps the phase and the
  // authority for a retry.
  const hasTechnicalBlock = validation.some((result) =>
    isTechnicalValidationBlock({
      passed: result.passed,
      outcome: result.outcome,
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      ...(result.assertionExtraction !== undefined
        ? { assertionExtraction: result.assertionExtraction }
        : {}),
    }),
  );

  if (state.phase === 'IMPL_VALIDATION') {
    // Post-implementation validation writes to implValidation. A genuine failure
    // routes IMPL_VALIDATION → IMPLEMENTATION (the delivered CODE is wrong, not the
    // plan); clear implementation so the agent must re-run /implement and the
    // machine does not immediately re-fire IMPL_COMPLETE into an advance loop. A
    // technical block stays in IMPL_VALIDATION for a retry.
    const genuinelyFailed = validation.some((result) => !result.passed) && !hasTechnicalBlock;
    return {
      ...state,
      implValidation: validation,
      validationAttempts: [...state.validationAttempts, validationAttempt],
      error: null,
      ...(genuinelyFailed ? { implementation: null } : {}),
    };
  }

  // F5: preserve plan evidence when the non-pass is a technical block. The
  // machine stays in VALIDATION (CHECK_ERRORED) for a retry rather than routing
  // to PLAN, so the approved plan must survive.
  const clearPlanEvidence = validation.some((result) => !result.passed) && !hasTechnicalBlock;
  return {
    ...state,
    validation,
    validationAttempts: [...state.validationAttempts, validationAttempt],
    error: null,
    ...(clearPlanEvidence ? { selfReview: null, reviewDecision: null } : {}),
  };
}
