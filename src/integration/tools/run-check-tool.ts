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
 * 3. FlowGuard executes the command as a subprocess
 * 4. Evidence (exitCode, outputDigest, executionMs) is recorded in state
 * 5. When all activeChecks pass → advance to IMPLEMENTATION
 *
 * Design:
 * - Single check per call (allows agent to observe results between checks)
 * - Commands come ONLY from verificationCandidates (never from agent input)
 * - Agent cannot fabricate pass/fail — only runtime evidence is accepted
 *
 * @version v1
 */

import type { MutableSession, ToolContext, ToolDefinition, ToolResult } from './helpers.js';
import {
  withMutableSessionTransaction,
  formatBlocked,
  formatError,
  formatEval,
  formatAutoAdvanceOverflow,
  appendNextAction,
  getWorktree,
  writeStateWithArtifactsAlreadyLocked,
} from './helpers.js';

// State & Machine
import type { SessionState } from '../../state/schema.js';
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
import type { ValidationResult } from '../../state/evidence-validation.js';

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
      return await withMutableSessionTransaction(context, (session) =>
        executeRunCheckTransaction(args.kind as VerificationCandidateKind, context, session),
      );
    } catch (err) {
      return formatError(err);
    }
  },
};

async function executeRunCheckTransaction(
  kind: VerificationCandidateKind,
  context: ToolContext,
  session: MutableSession,
): Promise<ToolResult> {
  const guard = validateRunCheckRequest(kind, session.state);
  if (typeof guard === 'string') return guard;

  const evidence = await executeCheck({
    kind,
    command: guard.candidate.command,
    cwd: getWorktree(context),
  });
  const derivedRepairGuidance = evidence.passed ? undefined : deriveRepairGuidance(evidence);
  const validationResult = buildValidationResult(guard.checkId, evidence, derivedRepairGuidance);
  const allResults = mergeValidationResult(session.state, validationResult);
  const passedIds = new Set(allResults.filter((v) => v.passed).map((v) => v.checkId));
  const nextState = buildNextValidationState(session.state, allResults, passedIds);
  const advanced = autoAdvance(nextState, (s) => evaluate(s, session.ctx.policy), session.ctx);
  if (advanced.kind === 'overflow') return formatAutoAdvanceOverflow(advanced);
  await writeStateWithArtifactsAlreadyLocked(session.sessDir, advanced.state);
  return formatRunCheckResponse({
    kind,
    evidence,
    derivedRepairGuidance,
    originalState: session.state,
    passedIds,
    advanced,
  });
}

function validateRunCheckRequest(
  kind: VerificationCandidateKind,
  state: SessionState,
): string | { checkId: string; candidate: { kind: VerificationCandidateKind; command: string } } {
  if (!isCommandAllowed(state.phase, Command.VALIDATE)) {
    return formatBlocked('COMMAND_NOT_ALLOWED', { command: '/run_check', phase: state.phase });
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

function buildValidationResult(
  checkId: string,
  evidence: Awaited<ReturnType<typeof executeCheck>>,
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

function formatValidationDetail(evidence: Awaited<ReturnType<typeof executeCheck>>): string {
  if (evidence.timedOut) return `Timed out after ${evidence.executionMs}ms`;
  if (evidence.passed) return `Passed (exit 0, ${evidence.executionMs}ms)`;
  return `Failed (exit ${evidence.exitCode}, ${evidence.executionMs}ms)`;
}

function mergeValidationResult(
  state: SessionState,
  validationResult: ValidationResult,
): ValidationResult[] {
  return [
    ...state.validation.filter((v) => v.checkId !== validationResult.checkId),
    validationResult,
  ];
}

function buildNextValidationState(
  state: SessionState,
  validation: ValidationResult[],
  passedIds: Set<string>,
): SessionState {
  const allPassed = state.activeChecks.every((id) => passedIds.has(id));
  return {
    ...state,
    validation,
    error: null,
    ...(allPassed ? {} : { selfReview: null, reviewDecision: null }),
  };
}

function formatRunCheckResponse(input: {
  kind: string;
  evidence: Awaited<ReturnType<typeof executeCheck>>;
  derivedRepairGuidance: ReturnType<typeof deriveRepairGuidance> | undefined;
  originalState: SessionState;
  passedIds: Set<string>;
  advanced: Exclude<ReturnType<typeof autoAdvance>, { kind: 'overflow' }>;
}): ToolResult {
  const { kind, evidence, derivedRepairGuidance, originalState, passedIds, advanced } = input;
  const { state: finalState, evalResult: ev, transitions } = advanced;
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
      next: formatEval(ev),
      _audit: { transitions },
    }),
    finalState,
  );
}

function formatRunCheckStatus(
  kind: string,
  evidence: Awaited<ReturnType<typeof executeCheck>>,
): string {
  if (evidence.passed) return `Check '${kind}' passed.`;
  if (evidence.timedOut) return `Check '${kind}' timed out.`;
  return `Check '${kind}' failed (exit ${evidence.exitCode}).`;
}
