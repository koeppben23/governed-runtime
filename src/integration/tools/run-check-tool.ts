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

import type { ToolDefinition } from './helpers.js';
import {
  withMutableSessionTransaction,
  formatBlocked,
  formatError,
  formatEval,
  appendNextAction,
  getWorktree,
  writeStateWithArtifactsAlreadyLocked,
} from './helpers.js';

// State & Machine
import type { SessionState } from '../../state/schema.js';
import { evaluate } from '../../machine/evaluate.js';
import { isCommandAllowed, Command } from '../../machine/commands.js';
import { VerificationCandidateKindSchema } from '../../state/discovery-schemas.js';

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
      return await withMutableSessionTransaction(context, async ({ sessDir, state, ctx }) => {
        // Phase admissibility
        if (!isCommandAllowed(state.phase, Command.VALIDATE)) {
          return formatBlocked('COMMAND_NOT_ALLOWED', {
            command: '/run_check',
            phase: state.phase,
          });
        }

        if (state.activeChecks.length === 0) {
          return formatBlocked('NO_ACTIVE_CHECKS');
        }

        // Resolve the command for this kind from verificationCandidates
        const candidates = state.verificationCandidates ?? [];
        const candidate = candidates.find((c) => c.kind === args.kind);

        if (!candidate) {
          return formatBlocked('CHECK_KIND_NOT_AVAILABLE', {
            kind: args.kind,
            available: candidates.map((c) => c.kind).join(', ') || 'none',
          });
        }

        // Verify the kind maps to an active check
        const checkId = args.kind; // kind IS the checkId in the new model
        if (!state.activeChecks.includes(checkId)) {
          return formatBlocked('CHECK_NOT_ACTIVE', {
            checkId,
            activeChecks: state.activeChecks.join(', '),
          });
        }

        // Execute the command
        const worktree = getWorktree(context);
        const evidence = await executeCheck({
          kind: args.kind,
          command: candidate.command,
          cwd: worktree,
        });
        const derivedRepairGuidance = evidence.passed ? undefined : deriveRepairGuidance(evidence);

        // Build the validation result
        const validationResult: ValidationResult = {
          checkId,
          passed: evidence.passed,
          detail: evidence.timedOut
            ? `Timed out after ${evidence.executionMs}ms`
            : evidence.passed
              ? `Passed (exit 0, ${evidence.executionMs}ms)`
              : `Failed (exit ${evidence.exitCode}, ${evidence.executionMs}ms)`,
          executedAt: evidence.startedAt,
          kind: evidence.kind,
          command: evidence.command,
          exitCode: evidence.exitCode,
          executionMs: evidence.executionMs,
          outputDigest: evidence.outputDigest,
          timedOut: evidence.timedOut,
          derivedRepairGuidance,
        };

        // Merge into existing validation results (replace if same checkId exists)
        const existingResults = state.validation.filter((v) => v.checkId !== checkId);
        const allResults = [...existingResults, validationResult];

        // Check if all active checks now pass
        const passedIds = new Set(allResults.filter((v) => v.passed).map((v) => v.checkId));
        const allPassed = state.activeChecks.every((id) => passedIds.has(id));

        const nextState: SessionState = {
          ...state,
          validation: allResults,
          error: null,
          ...(allPassed ? {} : { selfReview: null, reviewDecision: null }),
        };

        // Evaluate + autoAdvance (ALL_PASSED → IMPLEMENTATION, CHECK_FAILED → PLAN)
        const evalFn = (s: SessionState) => evaluate(s, ctx.policy);
        const {
          state: finalState,
          evalResult: ev,
          transitions,
        } = autoAdvance(nextState, evalFn, ctx);
        await writeStateWithArtifactsAlreadyLocked(sessDir, finalState);

        // Build response with execution evidence
        return appendNextAction(
          JSON.stringify({
            phase: finalState.phase,
            status: evidence.passed
              ? `Check '${args.kind}' passed.`
              : evidence.timedOut
                ? `Check '${args.kind}' timed out.`
                : `Check '${args.kind}' failed (exit ${evidence.exitCode}).`,
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
            remainingChecks: state.activeChecks.filter((id) => !passedIds.has(id)),
            next: formatEval(ev),
            _audit: { transitions },
          }),
          finalState,
        );
      });
    } catch (err) {
      return formatError(err);
    }
  },
};
