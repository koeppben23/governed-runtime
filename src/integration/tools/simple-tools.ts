/**
 * @module integration/tools/simple-tools
 * @description Simple FlowGuard tools that delegate directly to rails.
 *
 * Contains: status, ticket, decision, validate, review, abort_session, archive.
 * These tools follow the pattern: resolve workspace -> read state -> call rail -> persist.
 *
 * @version v3
 */

import { z } from 'zod';

import type { ToolDefinition } from './helpers';
import {
  resolveWorkspacePaths,
  requireState,
  resolvePolicyFromState,
  createPolicyContext,
  formatEval,
  formatBlocked,
  formatError,
  formatRailResult,
  persistAndFormat,
  appendNextAction,
} from './helpers';

// State & Machine
import type { SessionState } from '../../state/schema';
import { evaluate } from '../../machine/evaluate';
import { isCommandAllowed, Command } from '../../machine/commands';
import { TERMINAL } from '../../machine/topology';

// Rails
import { executeTicket } from '../../rails/ticket';
import { executeReviewDecision } from '../../rails/review-decision';
import { executeReview, executeReviewFlow } from '../../rails/review';
import { executeAbort } from '../../rails/abort';

// Rail helpers
import { autoAdvance } from '../../rails/types';

// Adapters
import { readState, readConfig, writeState, writeReport } from '../../adapters/persistence';

// Workspace
import { archiveSession } from '../../adapters/workspace';

// Artifacts
import { writeMadrArtifact } from '../artifacts/madr-writer';

// Evidence types
import type { CheckId, ValidationResult } from '../../state/evidence';

// Config
import { evaluateCompleteness } from '../../audit/completeness';
import { resolveContextIdentity } from '../identity';
import { evaluateApprovalConstraints, resolveActorRoles } from '../rbac';
import type { PolicyMode } from '../../config/policy';

function parsePolicyMode(value: string): PolicyMode | null {
  if (value === 'solo' || value === 'team' || value === 'team-ci' || value === 'regulated') {
    return value;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_status — Read-Only State Check
// ═══════════════════════════════════════════════════════════════════════════════

export const status: ToolDefinition = {
  description:
    'Read the current FlowGuard session state. Returns phase, evidence summary, ' +
    'policy info, completeness matrix, and next action. ' +
    'Does NOT mutate state. Use this to understand where the workflow is before taking action.',
  args: {},
  async execute(_args, context) {
    try {
      const { sessDir } = await resolveWorkspacePaths(context);
      const state = await readState(sessDir);

      if (!state) {
        return JSON.stringify({
          phase: null,
          status: 'No FlowGuard session found.',
          next: 'Run /hydrate to bootstrap a session.',
        });
      }

      const policy = resolvePolicyFromState(state);
      const ev = evaluate(state, policy);
      const completeness = evaluateCompleteness(state);

      return appendNextAction(
        JSON.stringify({
          phase: state.phase,
          sessionId: state.id,
          policyMode: state.policySnapshot?.mode ?? 'unknown',
          initiatedBy: state.initiatedBy,
          profileId: state.activeProfile?.id ?? 'none',
          profileName: state.activeProfile?.name ?? 'None',
          profileRules: (() => {
            const base = state.activeProfile?.ruleContent ?? '';
            const phaseExtra = state.activeProfile?.phaseRuleContent?.[state.phase];
            return phaseExtra ? base + '\n\n' + phaseExtra : base;
          })(),
          hasTicket: state.ticket !== null,
          hasPlan: state.plan !== null,
          planVersion: state.plan ? state.plan.history.length + 1 : 0,
          selfReviewIteration: state.selfReview?.iteration ?? null,
          selfReviewConverged: state.selfReview
            ? state.selfReview.iteration >= state.selfReview.maxIterations ||
              (state.selfReview.revisionDelta === 'none' && state.selfReview.verdict === 'approve')
            : null,
          validationResults: state.validation.map((v) => ({
            checkId: v.checkId,
            passed: v.passed,
          })),
          hasImplementation: state.implementation !== null,
          implReviewIteration: state.implReview?.iteration ?? null,
          implReviewConverged: state.implReview
            ? state.implReview.iteration >= state.implReview.maxIterations ||
              (state.implReview.revisionDelta === 'none' && state.implReview.verdict === 'approve')
            : null,
          hasReviewDecision: state.reviewDecision !== null,
          reviewVerdict: state.reviewDecision?.verdict ?? null,
          error: state.error,
          evalKind: ev.kind,
          next: formatEval(ev),
          completeness: {
            overallComplete: completeness.overallComplete,
            fourEyes: completeness.fourEyes,
            summary: completeness.summary,
          },
        }),
        state,
      );
    } catch (err) {
      return formatError(err);
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_ticket — Record Task
// ═══════════════════════════════════════════════════════════════════════════════

export const ticket: ToolDefinition = {
  description:
    'Record the task/ticket description for the FlowGuard session. ' +
    'Clears all downstream evidence (plan, validation, implementation). ' +
    'Allowed in READY and TICKET phases.',
  args: {
    text: z.string().describe('The task or ticket description. Must be non-empty.'),
    source: z
      .enum(['user', 'external'])
      .default('user')
      .describe("Source of the ticket: 'user' (typed in chat) or 'external' (from issue tracker)."),
  },
  async execute(args, context) {
    try {
      const { sessDir } = await resolveWorkspacePaths(context);
      const state = await requireState(sessDir);
      const policy = resolvePolicyFromState(state);
      const ctx = createPolicyContext(policy);

      const result = executeTicket(
        state,
        {
          text: args.text,
          source: args.source,
        },
        ctx,
      );

      return await persistAndFormat(sessDir, result);
    } catch (err) {
      return formatError(err);
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_decision — Human Verdict at User Gates
// ═══════════════════════════════════════════════════════════════════════════════

export const decision: ToolDefinition = {
  description:
    'Record a human review decision at a User Gate (PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW). ' +
    "Verdicts: 'approve' (proceed), 'changes_requested' (revise), 'reject' (restart from ticket). " +
    'This tool ONLY works at PLAN_REVIEW, EVIDENCE_REVIEW, and ARCH_REVIEW phases. ' +
    'In regulated mode, four-eyes principle is enforced: the reviewer must differ from the session initiator.',
  args: {
    verdict: z
      .enum(['approve', 'changes_requested', 'reject'])
      .describe(
        "Review verdict. 'approve' advances the workflow. " +
          "'changes_requested' returns to revision. " +
          "'reject' restarts from TICKET (or READY for architecture flow).",
      ),
    rationale: z.string().default('').describe('Reason for the decision. Recorded in audit trail.'),
  },
  async execute(args, context) {
    try {
      const { sessDir, wsDir } = await resolveWorkspacePaths(context);
      const state = await requireState(sessDir);
      const policy = resolvePolicyFromState(state);
      const ctx = createPolicyContext(policy);

      const effectiveMode = parsePolicyMode(state.policySnapshot.mode);
      if (!effectiveMode) {
        return formatBlocked('INVALID_POLICY_MODE', { mode: state.policySnapshot.mode });
      }

      let config;
      try {
        config = await readConfig(wsDir);
      } catch (err) {
        if (err instanceof Error && 'code' in err) {
          const code = String((err as { code: unknown }).code);
          if (
            code === 'READ_FAILED' ||
            code === 'PARSE_FAILED' ||
            code === 'SCHEMA_VALIDATION_FAILED'
          ) {
            return formatBlocked(code, {
              message: err.message,
            });
          }
        }
        return formatError(err);
      }

      const identityResult = resolveContextIdentity(context, config, effectiveMode, ctx.now());
      if (!identityResult.ok) {
        return formatBlocked(identityResult.blocked.code, identityResult.blocked.vars);
      }

      const roleResolution = resolveActorRoles(identityResult.value.assertion, config);
      const constraintBlocked = evaluateApprovalConstraints({
        mode: effectiveMode,
        initiatedBy: state.initiatedBy,
        decidedBy: identityResult.value.assertion.subjectId,
        actorRoles: roleResolution.roles,
        config,
      });
      if (constraintBlocked) {
        return formatBlocked(constraintBlocked.code, constraintBlocked.vars);
      }

      const result = executeReviewDecision(
        state,
        {
          verdict: args.verdict,
          rationale: args.rationale,
          decidedBy: identityResult.value.assertion.subjectId,
        },
        ctx,
      );

      // Write MADR artifact when architecture flow completes
      if (
        result.kind === 'ok' &&
        result.state.phase === 'ARCH_COMPLETE' &&
        result.state.architecture
      ) {
        await writeMadrArtifact(sessDir, result.state.architecture);
      }

      return await persistAndFormat(sessDir, result);
    } catch (err) {
      return formatError(err);
    }
  },
};

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
        }),
      )
      .describe('Array of validation check results. Must cover all activeChecks for the session.'),
  },
  async execute(args, context) {
    try {
      const { sessDir } = await resolveWorkspacePaths(context);
      const state = await requireState(sessDir);
      const policy = resolvePolicyFromState(state);
      const ctx = createPolicyContext(policy);

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

      // Record results with timestamps
      const now = ctx.now();
      const validationResults = args.results.map(
        (r: { checkId: string; passed: boolean; detail: string }) => ({
          checkId: r.checkId as CheckId,
          passed: r.passed,
          detail: r.detail,
          executedAt: now,
        }),
      );

      const nextState: SessionState = {
        ...state,
        validation: validationResults,
        error: null,
      };

      // Evaluate + autoAdvance (ALL_PASSED -> IMPLEMENTATION, CHECK_FAILED -> PLAN)
      const evalFn = (s: SessionState) => evaluate(s, policy);
      const {
        state: finalState,
        evalResult: ev,
        transitions,
      } = autoAdvance(nextState, evalFn, ctx);
      await writeState(sessDir, finalState);

      const allPassed = validationResults.every((r: ValidationResult) => r.passed);
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

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_review — Standalone Review Flow (READY → REVIEW → REVIEW_COMPLETE)
// ═══════════════════════════════════════════════════════════════════════════════

export const review: ToolDefinition = {
  description:
    'Start the standalone review flow. Transitions READY → REVIEW → REVIEW_COMPLETE. ' +
    'Generates a compliance review report with evidence completeness matrix ' +
    'and four-eyes principle status. Produces a flowguard-review-report.v1 artifact ' +
    'written to the session directory. Only allowed in READY phase.',
  args: {},
  async execute(_args, context) {
    try {
      const { sessDir } = await resolveWorkspacePaths(context);
      const state = await requireState(sessDir);
      const policy = resolvePolicyFromState(state);
      const ctx = createPolicyContext(policy);

      // 1. Execute review flow rail (READY → REVIEW → REVIEW_COMPLETE)
      const result = executeReviewFlow(state, ctx);

      if (result.kind === 'blocked') {
        return formatRailResult(result);
      }

      // 2. Generate the compliance report using the final state
      const now = new Date().toISOString();
      const report = await executeReview(result.state, now);

      // 3. Persist state + write report artifact
      await writeState(sessDir, result.state);
      await writeReport(sessDir, report);

      return appendNextAction(
        JSON.stringify({
          phase: result.state.phase,
          status: 'Review flow complete. Report generated.',
          overallStatus: report.overallStatus,
          policyMode: result.state.policySnapshot?.mode ?? 'unknown',
          completeness: {
            overallComplete: report.completeness.overallComplete,
            fourEyes: report.completeness.fourEyes,
            summary: report.completeness.summary,
            slots: report.completeness.slots.map((s) => ({
              slot: s.slot,
              label: s.label,
              status: s.status,
              detail: s.detail,
            })),
          },
          findingsCount: report.findings.length,
          findings: report.findings,
          validationSummary: report.validationSummary,
          _audit: { transitions: result.transitions },
        }),
        result.state,
      );
    } catch (err) {
      return formatError(err);
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_abort_session — Emergency Termination
// ═══════════════════════════════════════════════════════════════════════════════

export const abort_session: ToolDefinition = {
  description:
    'Emergency termination of the FlowGuard session. Bypasses the state machine ' +
    'and directly sets phase to COMPLETE with an ABORTED error marker. ' +
    'Use only when the session cannot or should not continue. Irreversible.',
  args: {
    reason: z
      .string()
      .default('Session aborted by user')
      .describe('Reason for aborting. Recorded in audit trail.'),
  },
  async execute(args, context) {
    try {
      const { sessDir } = await resolveWorkspacePaths(context);
      const state = await requireState(sessDir);
      const policy = resolvePolicyFromState(state);
      const ctx = createPolicyContext(policy);

      const result = executeAbort(
        state,
        {
          reason: args.reason,
          actor: context.sessionID,
        },
        ctx,
      );

      return await persistAndFormat(sessDir, result);
    } catch (err) {
      return formatError(err);
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_archive — Archive Completed Session
// ═══════════════════════════════════════════════════════════════════════════════

export const archive: ToolDefinition = {
  description:
    'Archive a completed FlowGuard session as a tar.gz file. ' +
    "Creates a compressed archive in the workspace's sessions/archive/ directory. " +
    'Only works on terminal sessions (COMPLETE, ARCH_COMPLETE, REVIEW_COMPLETE). ' +
    'Uses system tar (available on Windows 10+, macOS, Linux).',
  args: {},
  async execute(_args, context) {
    try {
      const { fingerprint, sessDir } = await resolveWorkspacePaths(context);
      const state = await readState(sessDir);

      if (!state) {
        return formatBlocked('NO_SESSION');
      }

      if (!TERMINAL.has(state.phase)) {
        return formatBlocked('COMMAND_NOT_ALLOWED', {
          command: '/archive',
          phase: state.phase,
        });
      }

      const archivePath = await archiveSession(fingerprint, context.sessionID);

      return appendNextAction(
        JSON.stringify({
          phase: state.phase,
          status: 'Session archived successfully.',
          archivePath,
        }),
        state,
      );
    } catch (err) {
      return formatError(err);
    }
  },
};
