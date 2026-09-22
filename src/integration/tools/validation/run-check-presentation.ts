import type {
  AssertionExtractionResult,
  ValidationExecutionObservation,
  ValidationOutcome,
  ValidationResult,
} from '../../../state/evidence-validation.js';
import { deriveRepairGuidance } from '../../../verification/repair-guidance.js';
import type { ToolResult } from '../helpers.js';
import { enrichWithWorkflowDirective } from '../helpers.js';
import type { SessionState } from '../../../state/schema.js';
import type { FlowGuardPolicy } from '../../../config/policy.js';
import { autoAdvance } from '../../../rails/types.js';
import { canonicalJsonStringify } from '../../../shared/canonical-json.js';
import { hashText } from '../../../shared/hashing.js';
import { formatBlocked } from '../../blocked-result.js';
import {
  resolveReviewDispatchAuthority,
  reviewObligationResponseFields,
} from '../../review/dispatch/dispatch-authority.js';
import type { ReviewDispatchAuthority } from '../../review/dispatch/dispatch-authority.js';
import { buildImplementationReviewInstruction } from '../implementation-review-activation.js';
interface CheckEvidencePresentation {
  readonly kind: string;
  readonly command: string;
  readonly exitCode: number;
  readonly passed: boolean;
  readonly executionMs: number;
  readonly outputDigest: string;
  readonly timedOut: boolean;
}

export interface RunCheckExecutionPresentation {
  readonly passed: boolean;
  readonly timedOut: boolean;
  readonly exitCode: number;
  readonly executionMs: number;
}

export interface RunCheckClassificationPresentation {
  readonly passed: boolean;
  readonly outcome: ValidationOutcome;
  readonly assertionExtraction?: AssertionExtractionResult | undefined;
}

/**
 * Render durable validation detail without conflating process success with
 * assertion completeness. Exit 0 remains execution evidence; extracted
 * assertion counts make skips/failures visible to downstream readers.
 */
export function formatValidationDetail(
  evidence: RunCheckExecutionPresentation,
  extraction?: AssertionExtractionResult,
): string {
  const execution = evidence.timedOut
    ? `Timed out after ${evidence.executionMs}ms`
    : evidence.passed
      ? `Passed (exit 0, ${evidence.executionMs}ms)`
      : `Failed (exit ${evidence.exitCode}, ${evidence.executionMs}ms)`;

  if (extraction?.status !== 'extracted') return execution;
  const summary = extraction.summary;
  return (
    `${execution}; assertions: ${summary.passedCount} passed, ${summary.failedCount} failed, ` +
    `${summary.erroredCount} errored, ${summary.skippedCount} skipped`
  );
}

/**
 * The user-visible check status follows FlowGuard's classified validation
 * result. A successful subprocess must never be presented as a passing check
 * when structured evidence classified it as blocked or inconclusive.
 */
export function formatRunCheckStatus(
  kind: string,
  result: RunCheckClassificationPresentation,
  evidence: RunCheckExecutionPresentation,
): string {
  if (result.passed) {
    const extraction = result.assertionExtraction;
    if (extraction?.status === 'extracted' && extraction.summary.skippedCount > 0) {
      return `Check '${kind}' passed with ${extraction.summary.skippedCount} skipped assertion(s).`;
    }
    return `Check '${kind}' passed.`;
  }
  if (evidence.timedOut) return `Check '${kind}' timed out.`;
  if (evidence.passed) return `Check '${kind}' ${result.outcome}.`;
  return `Check '${kind}' failed (exit ${evidence.exitCode}).`;
}

export function resolveRunCheckDispatchAuthority(
  activated: { obligation: { obligationId: string } | null },
  persisted: SessionState,
): ReviewDispatchAuthority | null | string {
  if (!activated.obligation) return null;
  const authority = resolveReviewDispatchAuthority(
    persisted.reviewAssurance,
    activated.obligation.obligationId,
  );
  return authority.kind === 'blocked'
    ? formatBlocked(authority.code, { reason: authority.reason })
    : authority.authority;
}

export function formatRunCheckResponse(input: {
  kind: string;
  candidateId?: string | undefined;
  evidence: CheckEvidencePresentation;
  validationResult: ValidationResult;
  derivedRepairGuidance: ReturnType<typeof deriveRepairGuidance> | undefined;
  originalState: SessionState;
  executionObservation: ValidationExecutionObservation;
  advanced: Exclude<ReturnType<typeof autoAdvance>, { kind: 'overflow' }>;
  finalState: SessionState;
  authority: ReviewDispatchAuthority | null;
  policy: FlowGuardPolicy;
}): ToolResult {
  const finalValidation =
    input.originalState.phase === 'IMPL_VALIDATION'
      ? input.finalState.implValidation
      : input.finalState.validation;
  const remainingChecks = input.finalState.activeChecks.filter(
    (checkId) => !finalValidation.some((result) => result.checkId === checkId && result.passed),
  );
  const reviewInstruction = input.authority
    ? buildImplementationReviewInstruction(input.authority)
    : null;
  return JSON.stringify(
    enrichWithWorkflowDirective(
      {
        phase: input.finalState.phase,
        status: formatRunCheckStatus(input.kind, input.validationResult, input.evidence),
        evidence: {
          kind: input.evidence.kind,
          ...(input.candidateId ? { candidateId: input.candidateId } : {}),
          command: input.evidence.command,
          exitCode: input.evidence.exitCode,
          passed: input.evidence.passed,
          executionMs: input.evidence.executionMs,
          outputDigest: input.evidence.outputDigest,
          timedOut: input.evidence.timedOut,
        },
        executionObservedStateDigest: input.executionObservation.executionObservedStateDigest,
        preCommitStateDigest: input.executionObservation.preCommitStateDigest,
        committedStateDigest: hashText(canonicalJsonStringify(input.finalState)),
        stateChangedDuringExecution:
          input.executionObservation.executionObservedStateDigest !==
          input.executionObservation.preCommitStateDigest,
        derivedRepairGuidance: input.derivedRepairGuidance,
        remainingChecks,
        ...(input.authority ? reviewObligationResponseFields(input.authority) : {}),
        ...(reviewInstruction ? { reviewDispatch: reviewInstruction.reviewDispatch } : {}),
        ...(reviewInstruction ? { reviewInvocation: reviewInstruction } : {}),
        _audit: { transitions: input.advanced.transitions },
      },
      input.finalState,
    ),
  );
}
