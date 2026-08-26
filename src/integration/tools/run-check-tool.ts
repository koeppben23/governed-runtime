/**
 * @module integration/tools/run-check-tool
 * @description FlowGuard run_check tool — execute verification commands with evidence.
 *
 * Replaces flowguard_validate (agent self-report) with runtime-executed verification.
 * FlowGuard runs the command itself and produces cryptographic execution evidence.
 *
 * Flow:
 * 1. Agent calls flowguard_run_check with { kind } (the verification kind to run)
 * 2. FlowGuard looks up the command from session's verificationCandidates
 * 3. FlowGuard executes the command as a subprocess (OUTSIDE the session write lock)
 * 4. Evidence (exitCode, outputDigest, executionMs) is recorded in state under lock
 *    with exponential-backoff retry on transient lock contention (#504)
 * 5. When all activeChecks pass → advance to IMPLEMENTATION
 *
 * Design:
 * - Single check per call (allows agent to observe results between checks)
 * - Commands come ONLY from verificationCandidates (never from agent input)
 * - Agent cannot fabricate pass/fail — only runtime evidence is accepted
 * - Check execution is decoupled from state persistence so slow subprocesses
 *   (e.g. build) do not starve concurrent checks of the session write lock
 *
 * @version v2 (#504 — separate check execution from lock acquisition)
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from './helpers.js';
import { formatError } from './error-format.js';
import {
  withReadOnlySession,
  formatBlocked,
  formatEval,
  formatAutoAdvanceOverflow,
  appendNextAction,
  getWorktree,
  writeStateWithArtifactsAndAuditOperationsAlreadyLocked,
  requireStateForMutation,
  resolvePolicyFromState,
  createPolicyContext,
} from './helpers.js';

import type { SessionState } from '../../state/schema.js';
import type { FlowGuardPolicy } from '../../config/policy.js';
import { evaluate } from '../../machine/evaluate.js';
import {
  type AssertionCapability,
  type FullCheckScopeAttestation,
  type VerificationCandidate,
  VerificationCandidateKindSchema,
  type VerificationCandidateKind,
} from '../../state/discovery-schemas.js';
import { autoAdvance } from '../../rails/types.js';
import { executeCheck } from '../../verification/executor.js';
import { deriveRepairGuidance } from '../../verification/repair-guidance.js';
import type {
  AssertionExtractionResult,
  ValidationAttempt,
  ValidationResult,
  ValidationOutcome,
} from '../../state/evidence-validation.js';
import { isExecutionError } from '../../state/evidence-validation.js';
import type { ReviewObligation } from '../../state/evidence.js';
import {
  prepareVerificationExecution,
  type PreparedVerificationExecution,
} from '../../verification/verification-execution.js';
import { completeAssertionExtraction } from '../../verification/assertion-extractor.js';
import { withSessionWriteLockRetry, PersistenceError } from '../../adapters/lock-retry.js';
import { REASON_LOCK_TIMEOUT_EXHAUSTED } from '../../shared/flowguard-identifiers.js';
import { getAdapterLogger, getLogTraceFields } from '../../logging/adapter-logger.js';
import { reviewObligationResponseFields } from '../review/assurance.js';
import {
  resolveRuntimeReviewPlatform,
  resolveReviewOrchestrationMode,
} from '../review/orchestration-mode.js';
import { buildPendingReviewInstruction } from '../review/pending-instruction.js';
import { resolveAttemptObservationCapability } from '../review/assurance.js';
import { buildReviewerProofContext } from '../review/proof-context.js';
import {
  activateReviewObligationAndPersist,
  materializeImplReviewContract,
  nextImplementationReviewIteration,
} from './implement-shared.js';
import {
  attestExecutionSubject,
  reattestExecutionSubject,
  type ExecutionSubjectInput,
  type ExecutionSubjectAttestation,
} from '../../verification/execution-subject.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { hashText } from '../../shared/hashing.js';
import { validateRunCheckRequest } from './run-check-request.js';
import { resolveExecutionSubjectInputs } from './execution-subject-input-resolution.js';
const RUN_CHECK_RETRY_DELAYS_MS = [100, 200, 400] as const;
const RUN_CHECK_RETRIES = RUN_CHECK_RETRY_DELAYS_MS.length;

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_run_check — Execute Verification Command with Evidence
// ═══════════════════════════════════════════════════════════════════════════════

export const run_check: ToolDefinition = {
  description:
    'Execute a verification check. FlowGuard runs the command from verificationCandidates ' +
    'and records cryptographic execution evidence (exit code, output digest, duration). ' +
    'Specify which check kind to run. The command is NOT user-supplied — it comes from ' +
    "the session's discovery-derived verificationCandidates. " +
    'After all activeChecks pass → advance to IMPLEMENTATION.',
  args: {
    kind: VerificationCandidateKindSchema.describe(
      'Which verification kind to execute (e.g., "lint", "test", "typecheck", "build").',
    ),
    candidateId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional exact verification candidate identity. Must belong to the requested kind.',
      ),
  },
  async execute(args, context) {
    try {
      return await executeRunCheckPhased(
        args.kind as VerificationCandidateKind,
        args.candidateId as string | undefined,
        context,
      );
    } catch (err) {
      if (err instanceof PersistenceError && err.code === 'LOCK_TIMEOUT_EXHAUSTED') {
        getAdapterLogger().error('tool', 'lock_exhausted', {
          sessionId: context.sessionID,
          checkId: args.kind,
          errorCode: 'LOCK_TIMEOUT_EXHAUSTED',
          causedBy: 'validation result persistence could not acquire session write lock',
          retries: RUN_CHECK_RETRIES,
          ...getLogTraceFields(),
        });
        return formatBlocked(REASON_LOCK_TIMEOUT_EXHAUSTED, {
          operation: 'validation_result_persistence',
          retries: String(RUN_CHECK_RETRIES),
          message: err.message,
        });
      }
      return formatError(err);
    }
  },
};

// ─── Phased Execution ─────────────────────────────────────────────────────────

// Validate, execute outside the lock, then revalidate and persist under the lock.

type PhaseAResult =
  | string
  | {
      sessDir: string;
      state: SessionState;
      executionObservedStateDigest: string;
      guard: { checkId: string; candidate: VerificationCandidate };
      subject: ReturnType<typeof freezeValidationSubject>;
      preAttestation: ExecutionSubjectAttestation;
      worktree: string;
      subjectInputs: readonly ExecutionSubjectInput[];
    };

async function validateAndAttest(
  kind: VerificationCandidateKind,
  candidateId: string | undefined,
  context: ToolContext,
): Promise<PhaseAResult> {
  const { sessDir, state } = await withReadOnlySession(context);
  if (!state) {
    throw Object.assign(new Error('No FlowGuard session found — run /hydrate first.'), {
      code: 'NO_SESSION',
    });
  }

  const guard = validateRunCheckRequest(kind, candidateId, state);
  if (typeof guard === 'string') return guard;
  const subject = freezeValidationSubject(state);

  const worktree = getWorktree(context);
  const subjectResolution = resolveExecutionSubjectInputs(state, guard.candidate);
  if (subjectResolution.kind === 'unavailable') {
    return formatBlocked('VERIFICATION_SUBJECT_CHANGED', {
      component: 'execution_surface',
      phase: 'pre_execution',
      detail: subjectResolution.detail,
    });
  }
  const subjectInputs = subjectResolution.inputs;

  const result = await attestExecutionSubject(
    subjectInputs,
    worktree,
    subject.scope === 'implementation' ? subject.implementationDigest : subject.planDigest,
    subject.scope === 'implementation' ? (state.implementation?.changedFiles ?? []) : [],
  );
  if (result.kind === 'subject_changed') {
    return formatBlocked('VERIFICATION_SUBJECT_CHANGED', {
      component: result.component,
      phase: 'pre_execution',
      detail: result.detail,
    });
  }

  return {
    sessDir,
    state,
    executionObservedStateDigest: hashText(canonicalJsonStringify(state)),
    guard,
    subject,
    preAttestation: result.attestation,
    worktree,
    subjectInputs,
  };
}

async function executeRunCheckPhased(
  kind: VerificationCandidateKind,
  candidateId: string | undefined,
  context: ToolContext,
): Promise<ToolResult> {
  // ── Phase A: Validate + attest (read-only, no lock) ──
  const phaseA = await validateAndAttest(kind, candidateId, context);
  if (typeof phaseA === 'string') return phaseA;

  const {
    sessDir,
    state,
    executionObservedStateDigest,
    guard,
    subject,
    preAttestation,
    worktree,
    subjectInputs,
  } = phaseA;

  // ── Phase B: Execute check (NO lock — subprocess runs independently) ──
  const attemptId = randomUUID();
  let prepared: PreparedVerificationExecution | undefined;
  let fullCommand = guard.candidate.command;
  if (guard.candidate.assertionCapability === 'structured' && guard.candidate.assertionReport) {
    prepared = await prepareVerificationExecution(guard.candidate, getWorktree(context), attemptId);
    fullCommand = prepared.command;
  }
  const evidence = await executeCheck({
    kind,
    command: fullCommand,
    cwd: getWorktree(context),
  });
  let extraction: AssertionExtractionResult | undefined;
  if (prepared) {
    extraction = await completeAssertionExtraction(prepared, evidence, getWorktree(context));
  }
  const outcome = classifyValidationOutcome(
    evidence,
    extraction,
    guard.candidate.assertionCapability,
  );

  // ── Post-execution attestation + persist ──
  return persistAfterAttestation({
    kind,
    candidateId: guard.candidate.candidateId,
    evidence,
    extraction,
    attemptId,
    subject,
    subjectInputs,
    worktree,
    preAttestation,
    implementationDigest:
      subject.scope === 'implementation' ? subject.implementationDigest : subject.planDigest,
    changedFiles:
      subject.scope === 'implementation' ? (state.implementation?.changedFiles ?? []) : [],
    outcome,
    fullCheckScopeAttestation:
      guard.candidate.assertionCapability === 'structured'
        ? guard.candidate.fullCheckScopeAttestation
        : undefined,
    sessDir,
    sessionId: context.sessionID,
    executionObservedStateDigest,
  });
}

async function persistAfterAttestation(params: {
  kind: VerificationCandidateKind;
  candidateId?: string;
  evidence: Awaited<ReturnType<typeof executeCheck>>;
  extraction?: AssertionExtractionResult;
  attemptId: string;
  subject: ValidationSubject;
  subjectInputs: readonly ExecutionSubjectInput[];
  worktree: string;
  preAttestation: ExecutionSubjectAttestation;
  implementationDigest: string;
  changedFiles: readonly string[];
  outcome: ValidationOutcome;
  fullCheckScopeAttestation?: FullCheckScopeAttestation;
  sessDir: string;
  sessionId: string;
  executionObservedStateDigest: string;
}): Promise<ToolResult> {
  const postAttestation = await reattestExecutionSubject(
    params.subjectInputs,
    params.worktree,
    params.preAttestation,
    params.implementationDigest,
    params.changedFiles,
  );
  if (postAttestation.kind === 'subject_changed') {
    return persistCheckResultWithRetry({
      kind: params.kind,
      candidateId: params.candidateId,
      evidence: params.evidence,
      derivedRepairGuidance: deriveRepairGuidance(params.evidence, 'blocked'),
      outcome: 'blocked',
      extraction: params.extraction,
      fullCheckScopeAttestation: params.fullCheckScopeAttestation,
      attemptId: params.attemptId,
      subject: params.subject,
      sessDir: params.sessDir,
      sessionId: params.sessionId,
      executionObservedStateDigest: params.executionObservedStateDigest,
      classificationReasonOverride: `VERIFICATION_SUBJECT_CHANGED: ${postAttestation.detail}`,
      worktree: params.worktree,
    });
  }

  // ── Phase C: Persist with lock retry ──
  return persistCheckResultWithRetry({
    kind: params.kind,
    candidateId: params.candidateId,
    evidence: params.evidence,
    derivedRepairGuidance: deriveRepairGuidance(params.evidence, params.outcome),
    outcome: params.outcome,
    extraction: params.extraction,
    fullCheckScopeAttestation: params.fullCheckScopeAttestation,
    attemptId: params.attemptId,
    subject: params.subject,
    sessDir: params.sessDir,
    sessionId: params.sessionId,
    executionObservedStateDigest: params.executionObservedStateDigest,
    worktree: params.worktree,
  });
}

// ─── Lock-Retry Persistence ───────────────────────────────────────────────────

interface PersistCheckInput {
  kind: VerificationCandidateKind;
  candidateId?: string;
  evidence: Awaited<ReturnType<typeof executeCheck>>;
  derivedRepairGuidance: ReturnType<typeof deriveRepairGuidance>;
  outcome: ValidationOutcome;
  extraction?: AssertionExtractionResult;
  fullCheckScopeAttestation?: FullCheckScopeAttestation;
  attemptId: string;
  subject: ValidationSubject;
  sessDir: string;
  sessionId: string;
  executionObservedStateDigest: string;
  classificationReasonOverride?: string;
  worktree: string;
}

// The lock-retry callback keeps execution and persistence intentionally separated.
// eslint-disable-next-line max-lines-per-function
async function persistCheckResultWithRetry(input: PersistCheckInput): Promise<ToolResult> {
  const {
    kind,
    candidateId,
    evidence,
    derivedRepairGuidance,
    outcome,
    extraction,
    fullCheckScopeAttestation,
    attemptId,
    subject,
    sessDir,
    sessionId,
    executionObservedStateDigest,
    classificationReasonOverride,
    worktree,
  } = input;
  const logger = getAdapterLogger();
  return withSessionWriteLockRetry(
    sessDir,
    async () => {
      // Re-read fresh state under lock and revalidate
      const freshState = await requireStateForMutation(sessDir);
      const freshPolicy = resolvePolicyFromState(freshState);
      const railCtx = createPolicyContext(freshPolicy);

      const reGuard = validateRunCheckRequest(kind, candidateId, freshState);
      if (typeof reGuard === 'string') {
        // State changed under us; do not persist stale result.
        return reGuard;
      }
      const subjectBlock = validationSubjectBlock(freshState, subject);
      if (subjectBlock) return subjectBlock;

      const validationResult = buildValidationResult({
        checkId: reGuard.checkId,
        candidateId: reGuard.candidate.candidateId,
        evidence,
        outcome,
        derivedRepairGuidance,
        extraction,
        fullCheckScopeAttestation,
        classificationReasonOverride,
      });
      const allResults = mergeValidationResult(freshState, validationResult);
      const validationAttempt = buildValidationAttempt(subject, validationResult, attemptId);
      const nextState = buildNextValidationState(freshState, allResults, validationAttempt);
      const advanced = autoAdvance(nextState, (s) => evaluate(s, railCtx.policy), railCtx);
      if (advanced.kind === 'overflow') return formatAutoAdvanceOverflow(advanced);

      const stateWithMaterializedContract = await materializeImplReviewContract(
        advanced.state,
        freshState.binding.worktree,
      );
      const activation = await activateReviewObligationAndPersist({
        state: stateWithMaterializedContract,
        preAdvanceState: nextState,
        subagentEnabled: freshPolicy.selfReview?.subagentEnabled ?? false,
        iteration: nextImplementationReviewIteration(advanced.state),
        planVersion: (advanced.state.plan?.history.length ?? 0) + 1,
        now: railCtx.now(),
        worktree,
        sessDir,
        locked: true,
        persistPreAdvance: true,
      });
      if ('response' in activation) return activation.response;
      const { activated } = activation;
      const persisted = await writeStateWithArtifactsAndAuditOperationsAlreadyLocked(
        sessDir,
        activated.state,
        advanced.transitions,
      );
      logger.info('tool', 'check_persisted', {
        sessionId,
        checkId: kind,
        passed: validationResult.passed,
        outcome: validationResult.outcome,
        ...getLogTraceFields(),
      });

      return formatRunCheckResponse({
        kind,
        candidateId: validationResult.candidateId,
        evidence,
        derivedRepairGuidance,
        originalState: freshState,
        executionObservedStateDigest,
        advanced,
        finalState: persisted,
        nextObligation: activated.obligation,
        policy: freshPolicy,
      });
    },
    {
      delaysMs: [...RUN_CHECK_RETRY_DELAYS_MS],
      onRetry: (attempt, delayMs, err) => {
        if (attempt !== 1 && attempt !== RUN_CHECK_RETRIES) return;
        logger.warn('flowguard_run_check', 'Lock contention — retrying persistence', {
          sessionId,
          checkId: kind,
          attempt,
          delayMs,
          retries: RUN_CHECK_RETRIES,
          errorCode: err.code,
          causedBy: 'session_write_lock_contention',
          ...getLogTraceFields(),
        });
        logger.warn('tool', 'lock_health', {
          sessionId,
          checkId: kind,
          lockContended: true,
          retries: RUN_CHECK_RETRIES,
          ...getLogTraceFields(),
        });
      },
    },
  );
}

// ─── Result Construction ──────────────────────────────────────────────────────

type CheckEvidence = Awaited<ReturnType<typeof executeCheck>>;

function buildValidationResult(params: {
  checkId: string;
  candidateId?: string;
  evidence: CheckEvidence;
  outcome: ValidationOutcome;
  derivedRepairGuidance: ReturnType<typeof deriveRepairGuidance>;
  extraction?: AssertionExtractionResult;
  fullCheckScopeAttestation?: FullCheckScopeAttestation;
  classificationReasonOverride?: string;
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
    detail: formatValidationDetail(evidence),
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

function classifyValidationOutcome(
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

function formatValidationDetail(evidence: CheckEvidence): string {
  if (evidence.timedOut) return `Timed out after ${evidence.executionMs}ms`;
  if (evidence.passed) return `Passed (exit 0, ${evidence.executionMs}ms)`;
  return `Failed (exit ${evidence.exitCode}, ${evidence.executionMs}ms)`;
}

function mergeValidationResult(
  state: SessionState,
  validationResult: ValidationResult,
): ValidationResult[] {
  // Post-implementation checks (IMPL_VALIDATION) accumulate in implValidation; the
  // pre-implementation baseline run (VALIDATION) accumulates in validation.
  const slot = state.phase === 'IMPL_VALIDATION' ? state.implValidation : state.validation;
  return [...slot.filter((v) => v.checkId !== validationResult.checkId), validationResult];
}

type ValidationSubject =
  | { readonly scope: 'baseline'; readonly planDigest: string }
  | { readonly scope: 'implementation'; readonly implementationDigest: string };

function freezeValidationSubject(state: SessionState): ValidationSubject {
  if (state.phase === 'VALIDATION') {
    return {
      scope: 'baseline',
      planDigest: state.plan!.current.digest,
    };
  }
  return {
    scope: 'implementation',
    implementationDigest: state.implementation!.digest,
  };
}

function validationSubjectMatches(state: SessionState, subject: ValidationSubject): boolean {
  return subject.scope === 'baseline'
    ? state.phase === 'VALIDATION' && state.plan?.current.digest === subject.planDigest
    : state.phase === 'IMPL_VALIDATION' &&
        state.implementation?.digest === subject.implementationDigest;
}

function validationSubjectBlock(state: SessionState, subject: ValidationSubject): string | null {
  return validationSubjectMatches(state, subject)
    ? null
    : formatBlocked('VALIDATION_SUBJECT_CHANGED');
}

function buildValidationAttempt(
  subject: ValidationSubject,
  result: ValidationResult,
  attemptId: string,
): ValidationAttempt {
  return { attemptId, ...subject, result };
}

function buildNextValidationState(
  state: SessionState,
  validation: ValidationResult[],
  validationAttempt: ValidationAttempt,
): SessionState {
  const hasExecutionError = validation.some(isExecutionError);

  if (state.phase === 'IMPL_VALIDATION') {
    // Post-implementation validation writes to implValidation. A genuine failure
    // routes IMPL_VALIDATION → IMPLEMENTATION (the delivered CODE is wrong, not the
    // plan); clear implementation so the agent must re-run /implement and the machine
    // does not immediately re-fire IMPL_COMPLETE into an advance loop. Execution
    // errors (timeout/not-found) stay in IMPL_VALIDATION for a retry.
    const genuinelyFailed = validation.some((result) => !result.passed) && !hasExecutionError;
    return {
      ...state,
      implValidation: validation,
      validationAttempts: [...state.validationAttempts, validationAttempt],
      error: null,
      ...(genuinelyFailed ? { implementation: null } : {}),
    };
  }

  // F5: preserve plan evidence when the non-pass is an execution error (timeout /
  // command-not-found). The machine stays in VALIDATION (CHECK_ERRORED) for a retry
  // rather than routing to PLAN, so the approved plan must survive.
  const clearPlanEvidence = validation.some((result) => !result.passed) && !hasExecutionError;
  return {
    ...state,
    validation,
    validationAttempts: [...state.validationAttempts, validationAttempt],
    error: null,
    ...(clearPlanEvidence ? { selfReview: null, reviewDecision: null } : {}),
  };
}

// ─── Response Formatting ──────────────────────────────────────────────────────

function formatRunCheckResponse(input: {
  kind: string;
  candidateId?: string;
  evidence: CheckEvidence;
  derivedRepairGuidance: ReturnType<typeof deriveRepairGuidance> | undefined;
  originalState: SessionState;
  executionObservedStateDigest: string;
  advanced: Exclude<ReturnType<typeof autoAdvance>, { kind: 'overflow' }>;
  finalState: SessionState;
  nextObligation: ReviewObligation | null;
  policy: FlowGuardPolicy;
}): ToolResult {
  const {
    kind,
    evidence,
    derivedRepairGuidance,
    originalState,
    executionObservedStateDigest,
    advanced,
    finalState,
  } = input;
  const { evalResult: ev, transitions } = advanced;
  const finalValidation =
    originalState.phase === 'IMPL_VALIDATION' ? finalState.implValidation : finalState.validation;
  const remainingChecks = finalState.activeChecks.filter(
    (checkId) => !finalValidation.some((result) => result.checkId === checkId && result.passed),
  );
  const platform = resolveRuntimeReviewPlatform();
  const mode = resolveReviewOrchestrationMode({
    platform,
    reviewInvocationPolicy: input.policy.reviewInvocationPolicy,
    nativeReviewerAvailable: platform !== 'unknown',
    manualAttestedAllowed: input.policy.reviewInvocationPolicy !== 'host_task_required',
  });
  const reviewInstruction = input.nextObligation
    ? buildPendingReviewInstruction({
        mode,
        platform,
        reviewKind: 'implementation',
        obligation: input.nextObligation,
        iteration: input.nextObligation.iteration,
        planVersion: input.nextObligation.planVersion,
        subjectLabel: 'implementation summary, changed files, approved plan text, and ticket text',
        proofContext: buildReviewerProofContext(finalState),
        observationCapability:
          resolveAttemptObservationCapability(
            finalState.reviewAssurance,
            input.nextObligation.obligationId,
          ) ?? undefined,
      })
    : null;
  return appendNextAction(
    JSON.stringify({
      phase: finalState.phase,
      status: formatRunCheckStatus(kind, evidence),
      evidence: {
        kind: evidence.kind,
        ...(input.candidateId ? { candidateId: input.candidateId } : {}),
        command: evidence.command,
        exitCode: evidence.exitCode,
        passed: evidence.passed,
        executionMs: evidence.executionMs,
        outputDigest: evidence.outputDigest,
        timedOut: evidence.timedOut,
      },
      executionObservedStateDigest,
      preCommitStateDigest: hashText(canonicalJsonStringify(originalState)),
      committedStateDigest: hashText(canonicalJsonStringify(finalState)),
      stateChangedDuringExecution:
        executionObservedStateDigest !== hashText(canonicalJsonStringify(originalState)),
      derivedRepairGuidance,
      remainingChecks,
      ...reviewObligationResponseFields(input.nextObligation),
      next: reviewInstruction?.next ?? formatEval(ev),
      ...(reviewInstruction ? { reviewInvocation: reviewInstruction.reviewInvocation } : {}),
      _audit: { transitions },
    }),
    finalState,
  );
}

function formatRunCheckStatus(kind: string, evidence: CheckEvidence): string {
  if (evidence.passed) return `Check '${kind}' passed.`;
  if (evidence.timedOut) return `Check '${kind}' timed out.`;
  return `Check '${kind}' failed (exit ${evidence.exitCode}).`;
}
