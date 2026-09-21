/**
 * @module integration/tools/validation/run-check-tool
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
import type { ToolDefinition, ToolResult, WorkspaceToolContext } from '../helpers.js';
import { formatError } from '../error-format.js';
import { formatBlocked } from '../../blocked-result.js';
import {
  withReadOnlySession,
  formatAutoAdvanceOverflow,
  enrichWithWorkflowDirective,
  getWorktree,
  writeStateWithArtifactsAndAuditOperationsAlreadyLocked,
  requireStateForMutation,
  resolvePolicyFromState,
  createPolicyContext,
} from '../helpers.js';

import type { SessionState } from '../../../state/schema.js';
import type { FlowGuardPolicy } from '../../../config/policy.js';
import { evaluate } from '../../../machine/evaluate.js';
import { IntegrationInvariantError } from '../../errors.js';
import {
  type FullCheckScopeAttestation,
  type VerificationCandidate,
  VerificationCandidateKindSchema,
  type VerificationCandidateKind,
} from '../../../state/discovery-schemas.js';
import { autoAdvance } from '../../../rails/types.js';
import { executeCheck } from '../../../verification/executor.js';
import { deriveRepairGuidance } from '../../../verification/repair-guidance.js';
import type {
  AssertionExtractionResult,
  ValidationExecutionObservation,
  ValidationOutcome,
  ValidationResult,
} from '../../../state/evidence-validation.js';
import {
  prepareVerificationExecution,
  type PreparedVerificationExecution,
} from '../../../verification/verification-execution.js';
import { completeAssertionExtraction } from '../../../verification/assertion-extractor.js';
import { withSessionWriteLockRetry, PersistenceError } from '../../../adapters/lock-retry.js';
import { REASON_LOCK_TIMEOUT_EXHAUSTED } from '../../../shared/flowguard-identifiers.js';
import { getAdapterLogger, getLogTraceFields } from '../../../logging/adapter-logger.js';
import { TOOL_FLOWGUARD_RUN_CHECK } from '../../tool-names.js';
import {
  resolveReviewDispatchAuthority,
  reviewObligationResponseFields,
} from '../../review/dispatch/dispatch-authority.js';
import type { ReviewDispatchAuthority } from '../../review/dispatch/dispatch-authority.js';
import {
  activateReviewObligationAndPersist,
  buildImplementationReviewInstruction,
  materializeImplReviewContract,
  nextImplementationReviewIteration,
} from '../implementation/implement-shared.js';
import {
  attestExecutionSubject,
  reattestExecutionSubject,
  type ExecutionSubjectInput,
  type ExecutionSubjectAttestation,
} from '../../../verification/execution-subject.js';
import { canonicalJsonStringify } from '../../../shared/canonical-json.js';
import { hashText } from '../../../shared/hashing.js';
import { validateRunCheckRequest } from './run-check-request.js';
import { resolveExecutionSubjectInputs } from '../execution-subject-input-resolution.js';
import { formatRunCheckStatus } from './run-check-presentation.js';
import {
  buildNextValidationState,
  buildValidationAttempt,
  buildValidationResult,
  classifyValidationOutcome,
  freezeValidationSubject,
  mergeValidationResult,
  validationSubjectBlock,
  type CheckEvidence,
  type ValidationSubject,
} from './run-check-result.js';
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
  context: WorkspaceToolContext,
): Promise<PhaseAResult> {
  const { sessDir, state } = await withReadOnlySession(context);
  if (!state) {
    throw new IntegrationInvariantError(
      'NO_SESSION',
      'No FlowGuard session found — run /hydrate first.',
    );
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

/**
 * Execute one verification check through the full production path: candidate
 * resolution, execution-subject attestation, evidence persistence, and
 * phase-aware auto-advance. Exported so the automatic validation runner
 * (`auto-validation.ts`) can execute checks without the `/run_check` tool
 * surface and without recursion through the tool definition.
 */
export async function executeRunCheckPhased(
  kind: VerificationCandidateKind,
  candidateId: string | undefined,
  context: WorkspaceToolContext,
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
  candidateId?: string | undefined;
  evidence: Awaited<ReturnType<typeof executeCheck>>;
  extraction?: AssertionExtractionResult | undefined;
  attemptId: string;
  subject: ValidationSubject;
  subjectInputs: readonly ExecutionSubjectInput[];
  worktree: string;
  preAttestation: ExecutionSubjectAttestation;
  implementationDigest: string;
  changedFiles: readonly string[];
  outcome: ValidationOutcome;
  fullCheckScopeAttestation?: FullCheckScopeAttestation | undefined;
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
  candidateId?: string | undefined;
  evidence: Awaited<ReturnType<typeof executeCheck>>;
  derivedRepairGuidance: ReturnType<typeof deriveRepairGuidance>;
  outcome: ValidationOutcome;
  extraction?: AssertionExtractionResult | undefined;
  fullCheckScopeAttestation?: FullCheckScopeAttestation | undefined;
  attemptId: string;
  subject: ValidationSubject;
  sessDir: string;
  sessionId: string;
  executionObservedStateDigest: string;
  classificationReasonOverride?: string | undefined;
  worktree: string;
}

// The lock-retry callback keeps execution and persistence intentionally
// separated: the callback re-reads and revalidates under the lock, then
// finalizes the already-executed check against that fresh state.
interface RevalidatedCheck {
  readonly freshState: SessionState;
  readonly freshPolicy: FlowGuardPolicy;
  readonly nextState: SessionState;
  readonly railCtx: ReturnType<typeof createPolicyContext>;
  readonly validationResult: ValidationResult;
  readonly executionObservation: ValidationExecutionObservation;
  readonly advanced: Exclude<ReturnType<typeof autoAdvance>, { kind: 'overflow' }>;
}

type CheckRevalidation = string | RevalidatedCheck;

async function revalidateCheckUnderLock(input: PersistCheckInput): Promise<CheckRevalidation> {
  // Re-read fresh state under lock and revalidate
  const freshState = await requireStateForMutation(input.sessDir);
  const freshPolicy = resolvePolicyFromState(freshState);
  const railCtx = createPolicyContext(freshPolicy);

  const reGuard = validateRunCheckRequest(input.kind, input.candidateId, freshState);
  if (typeof reGuard === 'string') {
    // State changed under us; do not persist stale result.
    return reGuard;
  }
  const subjectBlock = validationSubjectBlock(freshState, input.subject);
  if (subjectBlock) return subjectBlock;

  // Host-observed continuity binding, persisted with the attempt: the state
  // observed before the command ran and the state re-read under this lock.
  const executionObservation: ValidationExecutionObservation = {
    executionObservedStateDigest: input.executionObservedStateDigest,
    preCommitStateDigest: hashText(canonicalJsonStringify(freshState)),
  };

  const validationResult = buildValidationResult({
    checkId: reGuard.checkId,
    candidateId: reGuard.candidate.candidateId,
    evidence: input.evidence,
    outcome: input.outcome,
    derivedRepairGuidance: input.derivedRepairGuidance,
    extraction: input.extraction,
    fullCheckScopeAttestation: input.fullCheckScopeAttestation,
    classificationReasonOverride: input.classificationReasonOverride,
  });
  const allResults = mergeValidationResult(freshState, validationResult);
  const validationAttempt = buildValidationAttempt(
    input.subject,
    validationResult,
    input.attemptId,
    executionObservation,
  );
  const nextState = buildNextValidationState(freshState, allResults, validationAttempt);
  const advanced = autoAdvance(nextState, (s) => evaluate(s, railCtx.policy), railCtx);
  if (advanced.kind === 'overflow') return formatAutoAdvanceOverflow(advanced);

  return {
    freshState,
    freshPolicy,
    nextState,
    railCtx,
    validationResult,
    executionObservation,
    advanced,
  };
}

async function finalizeCheckUnderLock(input: {
  readonly worktree: string;
  readonly sessDir: string;
  readonly kind: VerificationCandidateKind;
  readonly sessionId: string;
  readonly evidence: Awaited<ReturnType<typeof executeCheck>>;
  readonly derivedRepairGuidance: ReturnType<typeof deriveRepairGuidance> | undefined;
  readonly logger: ReturnType<typeof getAdapterLogger>;
  readonly revalidated: RevalidatedCheck;
}): Promise<ToolResult> {
  const {
    freshState,
    freshPolicy,
    nextState,
    railCtx,
    validationResult,
    executionObservation,
    advanced,
  } = input.revalidated;
  const stateWithMaterializedContract = await materializeImplReviewContract(
    advanced.state,
    freshState.binding.worktree,
  );
  const activation = await activateReviewObligationAndPersist({
    state: stateWithMaterializedContract,
    preAdvanceState: nextState,
    iteration: nextImplementationReviewIteration(advanced.state),
    planVersion: (advanced.state.plan?.history.length ?? 0) + 1,
    now: railCtx.now(),
    worktree: input.worktree,
    sessDir: input.sessDir,
    locked: true,
    persistPreAdvance: true,
  });
  if ('response' in activation) return activation.response;
  const { activated } = activation;
  const persisted = await writeStateWithArtifactsAndAuditOperationsAlreadyLocked(
    input.sessDir,
    activated.state,
    advanced.transitions,
  );
  const authorityResult = checkDispatchAuthority(activated, persisted);
  if (typeof authorityResult === 'string') return authorityResult;
  input.logger.info('tool', 'check_persisted', {
    sessionId: input.sessionId,
    checkId: input.kind,
    passed: validationResult.passed,
    outcome: validationResult.outcome,
    ...getLogTraceFields(),
  });

  return formatRunCheckResponse({
    kind: input.kind,
    candidateId: validationResult.candidateId,
    evidence: input.evidence,
    validationResult,
    derivedRepairGuidance: input.derivedRepairGuidance,
    originalState: freshState,
    executionObservation,
    advanced,
    finalState: persisted,
    authority: authorityResult?.authority ?? null,
    policy: freshPolicy,
  });
}

async function persistCheckResultWithRetry(input: PersistCheckInput): Promise<ToolResult> {
  const logger = getAdapterLogger();
  return withSessionWriteLockRetry(
    input.sessDir,
    async () => {
      const revalidated = await revalidateCheckUnderLock(input);
      if (typeof revalidated === 'string') return revalidated;
      return finalizeCheckUnderLock({
        worktree: input.worktree,
        sessDir: input.sessDir,
        kind: input.kind,
        sessionId: input.sessionId,
        evidence: input.evidence,
        derivedRepairGuidance: input.derivedRepairGuidance,
        logger,
        revalidated,
      });
    },
    {
      delaysMs: [...RUN_CHECK_RETRY_DELAYS_MS],
      onRetry: (attempt, delayMs, err) => {
        if (attempt !== 1 && attempt !== RUN_CHECK_RETRIES) return;
        logger.warn(TOOL_FLOWGUARD_RUN_CHECK, 'Lock contention — retrying persistence', {
          sessionId: input.sessionId,
          checkId: input.kind,
          attempt,
          delayMs,
          retries: RUN_CHECK_RETRIES,
          errorCode: err.code,
          causedBy: 'session_write_lock_contention',
          ...getLogTraceFields(),
        });
        logger.warn('tool', 'lock_health', {
          sessionId: input.sessionId,
          checkId: input.kind,
          lockContended: true,
          retries: RUN_CHECK_RETRIES,
          ...getLogTraceFields(),
        });
      },
    },
  );
}

// ─── Response Formatting ──────────────────────────────────────────────────────

function buildRunCheckReviewInstruction(authority: ReviewDispatchAuthority | null) {
  return authority ? buildImplementationReviewInstruction(authority) : null;
}

function checkDispatchAuthority(
  activated: Extract<
    Awaited<ReturnType<typeof activateReviewObligationAndPersist>>,
    { activated: unknown }
  >['activated'],
  persisted: SessionState,
) {
  if (!activated.obligation) return null;
  const authority = resolveReviewDispatchAuthority(
    persisted.reviewAssurance,
    activated.obligation.obligationId,
  );
  if (authority.kind === 'blocked') {
    return formatBlocked(authority.code, { reason: authority.reason });
  }
  return authority;
}

function formatRunCheckResponse(input: {
  kind: string;
  candidateId?: string | undefined;
  evidence: CheckEvidence;
  validationResult: ValidationResult;
  derivedRepairGuidance: ReturnType<typeof deriveRepairGuidance> | undefined;
  originalState: SessionState;
  executionObservation: ValidationExecutionObservation;
  advanced: Exclude<ReturnType<typeof autoAdvance>, { kind: 'overflow' }>;
  finalState: SessionState;
  authority: ReviewDispatchAuthority | null;
  policy: FlowGuardPolicy;
}): ToolResult {
  const {
    evidence,
    derivedRepairGuidance,
    originalState,
    executionObservation,
    advanced,
    finalState,
  } = input;
  const { transitions } = advanced;
  const finalValidation =
    originalState.phase === 'IMPL_VALIDATION' ? finalState.implValidation : finalState.validation;
  const remainingChecks = finalState.activeChecks.filter(
    (checkId) => !finalValidation.some((result) => result.checkId === checkId && result.passed),
  );
  const reviewInstruction = buildRunCheckReviewInstruction(input.authority);
  return JSON.stringify(
    enrichWithWorkflowDirective(
      {
        phase: finalState.phase,
        status: formatRunCheckStatus(input.kind, input.validationResult, evidence),
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
        executionObservedStateDigest: executionObservation.executionObservedStateDigest,
        preCommitStateDigest: executionObservation.preCommitStateDigest,
        committedStateDigest: hashText(canonicalJsonStringify(finalState)),
        stateChangedDuringExecution:
          executionObservation.executionObservedStateDigest !==
          executionObservation.preCommitStateDigest,
        derivedRepairGuidance,
        remainingChecks,
        ...(input.authority ? reviewObligationResponseFields(input.authority) : {}),
        ...(reviewInstruction ? { reviewDispatch: reviewInstruction.reviewDispatch } : {}),
        ...(reviewInstruction ? { reviewInvocation: reviewInstruction } : {}),
        _audit: { transitions },
      },
      finalState,
    ),
  );
}
