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

import type { ToolContext, ToolDefinition, ToolResult } from './helpers.js';
import {
  withReadOnlySession,
  formatBlocked,
  formatError,
  formatEval,
  formatAutoAdvanceOverflow,
  appendNextAction,
  getWorktree,
  writeStateWithArtifactsAlreadyLocked,
  requireStateForMutation,
  resolvePolicyFromState,
  createPolicyContext,
} from './helpers.js';

// State & Machine
import type { SessionState } from '../../state/schema.js';
import type { FlowGuardPolicy } from '../../config/policy.js';
import { evaluate } from '../../machine/evaluate.js';
import { isCommandAllowed, Command } from '../../machine/commands.js';
import { evaluateValidationEvidence } from '../../machine/validation-evidence.js';
import {
  VerificationCandidateKindSchema,
  type VerificationCandidateKind,
} from '../../state/discovery-schemas.js';

// Rail helpers
import { autoAdvance } from '../../rails/types.js';

// Verification executor
import { executeCheck } from '../../verification/executor.js';
import { deriveRepairGuidance } from '../../verification/repair-guidance.js';

// Evidence types
import type { ValidationAttempt, ValidationResult } from '../../state/evidence-validation.js';
import { isExecutionError } from '../../state/evidence-validation.js';
import type { ReviewObligation } from '../../state/evidence.js';

// Adapter — lock retry
import { withSessionWriteLockRetry, PersistenceError } from '../../adapters/lock-retry.js';

// Identifiers
import { REASON_LOCK_TIMEOUT_EXHAUSTED } from '../../shared/flowguard-identifiers.js';

// Logging
import { getAdapterLogger, getLogTraceFields } from '../../logging/adapter-logger.js';
import { reviewObligationResponseFields } from '../review/assurance.js';
import {
  resolveRuntimeReviewPlatform,
  resolveReviewOrchestrationMode,
} from '../review/orchestration-mode.js';
import { buildPendingReviewInstruction } from '../review/pending-instruction.js';
import {
  activateImplementationReviewObligation,
  nextImplementationReviewIteration,
} from './implement-shared.js';
import { materializeApprovedPlanContract } from '../proofgraph/materialize-contract.js';

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
  },
  async execute(args, context) {
    try {
      return await executeRunCheckPhased(args.kind as VerificationCandidateKind, context);
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

/**
 * Execute run_check in three phases:
 *
 * A. Validate request (read state, no lock)
 * B. Execute check (subprocess, NO lock — prevents slow checks from starving
 *    concurrent run_check calls)
 * C. Persist result under lock with retry (revalidate fresh state under lock,
 *    merge evidence, auto-advance, atomic write)
 */
async function executeRunCheckPhased(
  kind: VerificationCandidateKind,
  context: ToolContext,
): Promise<ToolResult> {
  // ── Phase A: Validate request (read-only, no lock) ──
  const { sessDir, state } = await withReadOnlySession(context);
  if (!state) {
    throw Object.assign(new Error('No FlowGuard session found — run /hydrate first.'), {
      code: 'NO_SESSION',
    });
  }

  const guard = validateRunCheckRequest(kind, state);
  if (typeof guard === 'string') return guard;
  const subject = freezeValidationSubject(state);

  // ── Phase B: Execute check (NO lock — subprocess runs independently) ──
  const evidence = await executeCheck({
    kind,
    command: guard.candidate.command,
    cwd: getWorktree(context),
  });
  const derivedRepairGuidance = evidence.passed ? undefined : deriveRepairGuidance(evidence);

  // ── Phase C: Persist with lock retry ──
  return persistCheckResultWithRetry({
    kind,
    evidence,
    derivedRepairGuidance,
    subject,
    sessDir,
    sessionId: context.sessionID,
  });
}

// ─── Lock-Retry Persistence ───────────────────────────────────────────────────

interface PersistCheckInput {
  kind: VerificationCandidateKind;
  evidence: Awaited<ReturnType<typeof executeCheck>>;
  derivedRepairGuidance: ReturnType<typeof deriveRepairGuidance> | undefined;
  subject: ValidationSubject;
  sessDir: string;
  sessionId: string;
}

// The lock-retry callback keeps execution and persistence intentionally separated.
// eslint-disable-next-line max-lines-per-function
async function persistCheckResultWithRetry(input: PersistCheckInput): Promise<ToolResult> {
  const { kind, evidence, derivedRepairGuidance, subject, sessDir, sessionId } = input;
  const logger = getAdapterLogger();
  return withSessionWriteLockRetry(
    sessDir,
    async () => {
      // Re-read fresh state under lock and revalidate
      const freshState = await requireStateForMutation(sessDir);
      const freshPolicy = resolvePolicyFromState(freshState);
      const railCtx = createPolicyContext(freshPolicy);

      const reGuard = validateRunCheckRequest(kind, freshState);
      if (typeof reGuard === 'string') {
        // State changed under us; do not persist stale result.
        return reGuard;
      }
      const subjectBlock = validationSubjectBlock(freshState, subject);
      if (subjectBlock) return subjectBlock;

      const validationResult = buildValidationResult(
        reGuard.checkId,
        evidence,
        derivedRepairGuidance,
      );
      const allResults = mergeValidationResult(freshState, validationResult);
      const passedIds = new Set(allResults.filter((v) => v.passed).map((v) => v.checkId));
      const validationAttempt = buildValidationAttempt(subject, validationResult);
      const nextState = buildNextValidationState(
        freshState,
        allResults,
        passedIds,
        validationAttempt,
      );
      const advanced = autoAdvance(nextState, (s) => evaluate(s, railCtx.policy), railCtx);
      if (advanced.kind === 'overflow') return formatAutoAdvanceOverflow(advanced);

      const stateWithMaterializedContract =
        advanced.state.phase === 'IMPL_REVIEW'
          ? {
              ...advanced.state,
              proofContract: materializeApprovedPlanContract(advanced.state),
            }
          : advanced.state;
      const activated = activateImplementationReviewObligation(stateWithMaterializedContract, {
        subagentEnabled: freshPolicy.selfReview?.subagentEnabled ?? false,
        iteration: nextImplementationReviewIteration(advanced.state),
        planVersion: (advanced.state.plan?.history.length ?? 0) + 1,
        now: railCtx.now(),
      });
      await writeStateWithArtifactsAlreadyLocked(sessDir, activated.state);
      logger.info('tool', 'check_persisted', {
        sessionId,
        checkId: kind,
        passed: evidence.passed,
        ...getLogTraceFields(),
      });

      return formatRunCheckResponse({
        kind,
        evidence,
        derivedRepairGuidance,
        originalState: freshState,
        passedIds,
        advanced,
        finalState: activated.state,
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

// ─── Request Validation ───────────────────────────────────────────────────────

function validateRunCheckRequest(
  kind: VerificationCandidateKind,
  state: SessionState,
): string | { checkId: string; candidate: { kind: VerificationCandidateKind; command: string } } {
  if (!isCommandAllowed(state.phase, Command.VALIDATE)) {
    return formatBlocked('COMMAND_NOT_ALLOWED', { command: '/run_check', phase: state.phase });
  }
  if (state.phase === 'VALIDATION' && !state.plan) {
    return formatBlocked('PLAN_REQUIRED', { action: 'baseline validation' });
  }
  if (state.phase === 'IMPL_VALIDATION' && !state.implementation) {
    return formatBlocked('IMPLEMENTATION_EVIDENCE_REQUIRED');
  }
  const activeChecksBlock = blockWhenNoActiveChecks(state);
  if (activeChecksBlock) return activeChecksBlock;
  const candidates = state.verificationCandidates ?? [];
  const candidate = candidates.find((c) => c.kind === kind);
  if (!candidate) {
    return formatBlocked('CHECK_KIND_NOT_AVAILABLE', {
      kind,
      available: candidates.map((c) => c.kind).join(', ') || 'none',
    });
  }
  if (!state.activeChecks.includes(kind)) {
    return formatBlocked('CHECK_NOT_ACTIVE', {
      checkId: kind,
      activeChecks: state.activeChecks.join(', '),
    });
  }
  return { checkId: kind, candidate };
}

function blockWhenNoActiveChecks(state: SessionState): string | null {
  if (state.activeChecks.length > 0) return null;
  const evidence = evaluateValidationEvidence(state);
  return evidence.blocked && evidence.code !== null
    ? formatBlocked(evidence.code)
    : formatBlocked('NO_ACTIVE_CHECKS');
}

// ─── Result Construction ──────────────────────────────────────────────────────

type CheckEvidence = Awaited<ReturnType<typeof executeCheck>>;

function buildValidationResult(
  checkId: string,
  evidence: CheckEvidence,
  derivedRepairGuidance: ReturnType<typeof deriveRepairGuidance> | undefined,
): ValidationResult {
  return {
    checkId,
    passed: evidence.passed,
    detail: formatValidationDetail(evidence),
    executedAt: evidence.startedAt,
    kind: evidence.kind,
    command: evidence.command,
    exitCode: evidence.exitCode,
    executionMs: evidence.executionMs,
    outputDigest: evidence.outputDigest,
    timedOut: evidence.timedOut,
    derivedRepairGuidance,
  };
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
): ValidationAttempt {
  return { attemptId: crypto.randomUUID(), ...subject, result };
}

function buildNextValidationState(
  state: SessionState,
  validation: ValidationResult[],
  passedIds: Set<string>,
  validationAttempt: ValidationAttempt,
): SessionState {
  const allPassed = state.activeChecks.every((id) => passedIds.has(id));
  const hasExecutionError = validation.some(isExecutionError);

  if (state.phase === 'IMPL_VALIDATION') {
    // Post-implementation validation writes to implValidation. A genuine failure
    // routes IMPL_VALIDATION → IMPLEMENTATION (the delivered CODE is wrong, not the
    // plan); clear implementation so the agent must re-run /implement and the machine
    // does not immediately re-fire IMPL_COMPLETE into an advance loop. Execution
    // errors (timeout/not-found) stay in IMPL_VALIDATION for a retry.
    const genuinelyFailed = !allPassed && !hasExecutionError;
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
  const clearPlanEvidence = !allPassed && !hasExecutionError;
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
  evidence: CheckEvidence;
  derivedRepairGuidance: ReturnType<typeof deriveRepairGuidance> | undefined;
  originalState: SessionState;
  passedIds: Set<string>;
  advanced: Exclude<ReturnType<typeof autoAdvance>, { kind: 'overflow' }>;
  finalState: SessionState;
  nextObligation: ReviewObligation | null;
  policy: FlowGuardPolicy;
}): ToolResult {
  const { kind, evidence, derivedRepairGuidance, originalState, passedIds, advanced, finalState } =
    input;
  const { evalResult: ev, transitions } = advanced;
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
      })
    : null;
  return appendNextAction(
    JSON.stringify({
      phase: finalState.phase,
      status: formatRunCheckStatus(kind, evidence),
      evidence: {
        kind: evidence.kind,
        command: evidence.command,
        exitCode: evidence.exitCode,
        passed: evidence.passed,
        executionMs: evidence.executionMs,
        outputDigest: evidence.outputDigest,
        timedOut: evidence.timedOut,
      },
      derivedRepairGuidance,
      remainingChecks: originalState.activeChecks.filter((id) => !passedIds.has(id)),
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
