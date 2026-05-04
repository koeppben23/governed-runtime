/**
 * @module integration/tools/validate-tool
 * @description FlowGuard validate tool — record validation check results.
 *
 * The LLM executes checks (test analysis, rollback safety, etc.) and reports
 * results here. After recording: ALL_PASSED → IMPLEMENTATION, CHECK_FAILED → PLAN.
 *
 * @version v1
 */

import { z } from 'zod';

import type { ToolDefinition } from './helpers.js';
import {
  withMutableSession,
  formatBlocked,
  formatError,
  formatEval,
  appendNextAction,
  writeStateWithArtifacts,
} from './helpers.js';

// State & Machine
import type { SessionState } from '../../state/schema.js';
import { evaluate } from '../../machine/evaluate.js';
import { isCommandAllowed, Command } from '../../machine/commands.js';

// Rail helpers
import { autoAdvance } from '../../rails/types.js';

// Evidence types
import type { ValidationResult } from '../../state/evidence.js';

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_validate — Record Validation Check Results
// ═══════════════════════════════════════════════════════════════════════════════

export const validate: ToolDefinition = {
  description:
    'Record validation check results. The LLM executes the checks (test analysis, ' +
    'rollback safety analysis, etc.) and reports results here. ' +
    "Provide an array of check results. Check IDs must match the session's activeChecks. " +
    'After recording: ALL_PASSED -> advance to IMPLEMENTATION, CHECK_FAILED -> return to PLAN.',
  args: {
    results: z
      .array(
        z.object({
          checkId: z
            .string()
            .min(1)
            .describe('Which validation check this result is for (must match activeChecks).'),
          passed: z.boolean().describe('Whether the check passed.'),
          detail: z.string().describe('Detailed explanation of the check result.'),
          evidenceType: z
            .enum(['command_output', 'ci_run', 'manual_review', 'external_reference'])
            .optional()
            .describe('How this check was executed (P10a: evidence metadata).'),
          command: z
            .string()
            .optional()
            .describe('The command that was run (if evidenceType is command_output).'),
          evidenceSummary: z
            .string()
            .optional()
            .describe('Summary of the evidence (test output, CI URL, review notes).'),
        }),
      )
      .describe('Array of validation check results. Must cover all activeChecks for the session.'),
  },
  async execute(args, context) {
    try {
      const { sessDir, state, ctx } = await withMutableSession(context);

      // Admissibility
      if (!isCommandAllowed(state.phase, Command.VALIDATE)) {
        return formatBlocked('COMMAND_NOT_ALLOWED', {
          command: '/validate',
          phase: state.phase,
        });
      }

      if (state.activeChecks.length === 0) {
        return formatBlocked('NO_ACTIVE_CHECKS');
      }

      // Validate that all active checks are covered
      const submittedIds = new Set(
        args.results.map((r: { checkId: string; passed: boolean; detail: string }) => r.checkId),
      );
      const missing = state.activeChecks.filter((id) => !submittedIds.has(id));
      if (missing.length > 0) {
        return formatBlocked('MISSING_CHECKS', {
          checks: missing.join(', '),
        });
      }

      // Record results with timestamps and evidence metadata (P10a)
      const now = ctx.now();
      const validationResults = args.results.map(
        (r: {
          checkId: string;
          passed: boolean;
          detail: string;
          evidenceType?: string;
          command?: string;
          evidenceSummary?: string;
        }) => ({
          checkId: r.checkId,
          passed: r.passed,
          detail: r.detail,
          executedAt: now,
          ...(r.evidenceType
            ? { evidenceType: r.evidenceType as ValidationResult['evidenceType'] }
            : {}),
          ...(r.command ? { command: r.command } : {}),
          ...(r.evidenceSummary ? { evidenceSummary: r.evidenceSummary } : {}),
        }),
      );

      const allPassed = validationResults.every((r: ValidationResult) => r.passed);
      const nextState: SessionState = {
        ...state,
        validation: validationResults,
        error: null,
        ...(allPassed ? {} : { selfReview: null, reviewDecision: null }),
      };

      // Evaluate + autoAdvance (ALL_PASSED -> IMPLEMENTATION, CHECK_FAILED -> PLAN)
      const evalFn = (s: SessionState) => evaluate(s, ctx.policy);
      const {
        state: finalState,
        evalResult: ev,
        transitions,
      } = autoAdvance(nextState, evalFn, ctx);
      await writeStateWithArtifacts(sessDir, finalState);

      const failedChecks = validationResults
        .filter((r: ValidationResult) => !r.passed)
        .map((r: ValidationResult) => r.checkId);

      return appendNextAction(
        JSON.stringify({
          phase: finalState.phase,
          status: allPassed
            ? 'All validation checks passed.'
            : `Validation failed: ${failedChecks.join(', ')}.`,
          results: validationResults.map((r: ValidationResult) => ({
            checkId: r.checkId,
            passed: r.passed,
          })),
          next: formatEval(ev),
          _audit: { transitions },
        }),
        finalState,
      );
    } catch (err) {
      return formatError(err);
    }
  },
};
