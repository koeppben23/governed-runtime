/**
 * @module integration/tools/simple-tools
 * @description Simple FlowGuard tools that delegate directly to rails.
 *
 * Contains: ticket, review, abort_session, archive.
 * These tools follow the pattern: resolve workspace -> read state -> call rail -> persist.
 *
 * The more complex tools (status, decision, validate) have been extracted to
 * their own modules: status-tool.ts, decision-tool.ts, validate-tool.ts.
 *
 * @version v6
 */

import { z } from 'zod';

import type { ToolDefinition } from './helpers.js';
import {
  withMutableSession,
  resolveWorkspacePaths,
  formatBlocked,
  formatError,
  formatRailResult,
  persistAndFormat,
  appendNextAction,
} from './helpers.js';

// State & Machine
import { TERMINAL } from '../../machine/topology.js';

// Rails
import { executeTicket } from '../../rails/ticket.js';
import { executeReview, executeReviewFlow } from '../../rails/review.js';
import { executeAbort } from '../../rails/abort.js';

// Adapters
import { readState, writeReport } from '../../adapters/persistence.js';
import { ActorClaimError } from '../../adapters/actor.js';

// Workspace
import { archiveSession, verifyArchive } from '../../adapters/workspace/index.js';

import { writeStateWithArtifacts } from './helpers.js';

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
      const { sessDir, state, ctx } = await withMutableSession(context);

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
      if (err instanceof ActorClaimError) {
        return formatBlocked(err.code);
      }
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
      const { sessDir, state, ctx } = await withMutableSession(context);

      // 1. Execute review flow rail (READY → REVIEW → REVIEW_COMPLETE)
      const result = executeReviewFlow(state, ctx);

      if (result.kind === 'blocked') {
        return formatRailResult(result);
      }

      // 2. Generate the compliance report using the final state
      const now = new Date().toISOString();
      const report = await executeReview(result.state, now);

      // 3. Persist state + write report artifact
      await writeStateWithArtifacts(sessDir, result.state);
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
      const { sessDir, state, ctx } = await withMutableSession(context);

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

      // P2e: Track archiveStatus for consistency with regulated completion path.
      // Verify archive integrity and persist status on state.
      let archiveStatus: 'verified' | 'failed' = 'failed';
      try {
        const verification = await verifyArchive(fingerprint, context.sessionID);
        archiveStatus = verification.passed ? 'verified' : 'failed';
      } catch {
        // Verification failure is non-fatal for manual archive — status stays 'failed'.
      }
      const archivedState = { ...state, archiveStatus };
      await writeStateWithArtifacts(sessDir, archivedState);

      return appendNextAction(
        JSON.stringify({
          phase: state.phase,
          status: 'Session archived successfully.',
          archivePath,
          archiveStatus,
        }),
        archivedState,
      );
    } catch (err) {
      return formatError(err);
    }
  },
};
