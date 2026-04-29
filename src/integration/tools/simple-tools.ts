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
  formatBlocked,
  formatError,
  formatRailResult,
  persistAndFormat,
  appendNextAction,
} from './helpers.js';

// Rails
import { executeTicket } from '../../rails/ticket.js';
import { executeReview, executeReviewFlow } from '../../rails/review.js';
import { executeAbort } from '../../rails/abort.js';

// Evidence schemas for external reference handling
import { InputOriginSchema, ExternalReferenceSchema } from '../../state/evidence.js';

// Adapters
import { writeReport } from '../../adapters/persistence.js';
import { ActorClaimError } from '../../adapters/actor.js';

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
    inputOrigin: InputOriginSchema.optional().describe(
      'Where the text content originated. Set to "external_reference" when text was extracted ' +
        'from a URL, "manual_text" when typed, "mixed" when both manual and external.',
    ),
    references: z
      .array(ExternalReferenceSchema)
      .optional()
      .describe(
        'External references for this ticket (Jira URL, GitHub issue, Confluence doc, etc.). ' +
          'Each reference has ref (URL/ID), type (ticket/issue/pr/branch/commit/url/doc/other), ' +
          'optional title, source platform, and extractedAt timestamp.',
      ),
  },
  async execute(args, context) {
    try {
      const { sessDir, state, ctx } = await withMutableSession(context);

      const result = executeTicket(
        state,
        {
          text: args.text,
          source: args.source,
          inputOrigin: args.inputOrigin,
          references: args.references,
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
  args: {
    inputOrigin: InputOriginSchema.optional().describe(
      'Where the review content originated. Set to "pr" when reviewing a pull request, ' +
        '"branch" for branch review, "external_reference" for URL-based review, ' +
        '"manual_text" for text-only review.',
    ),
    references: z
      .array(ExternalReferenceSchema)
      .optional()
      .describe(
        'External references for this review (PR URL, branch name, commit SHA, etc.). ' +
          'Each reference has ref (URL/ID), type (ticket/issue/pr/branch/commit/url/doc/other), ' +
          'optional title, source platform, and extractedAt timestamp.',
      ),
  },
  async execute(args, context) {
    try {
      const { sessDir, state, ctx } = await withMutableSession(context);

      // 1. Execute review flow rail (READY → REVIEW → REVIEW_COMPLETE)
      const result = executeReviewFlow(state, ctx);

      if (result.kind === 'blocked') {
        return formatRailResult(result);
      }

      // 2. Generate the compliance report using the final state
      const now = new Date().toISOString();
      const refInput =
        args.inputOrigin || args.references
          ? {
              inputOrigin: args.inputOrigin,
              references: args.references,
            }
          : undefined;
      const report = await executeReview(result.state, now, undefined, refInput);

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
          references: report.references,
          inputOrigin: report.inputOrigin,
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
// archive — extracted to archive-tool.ts (P2b)
export { archive } from './archive-tool.js';
