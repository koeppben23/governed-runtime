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
import { executeReview, executeReviewFlow, type ReviewExecutors } from '../../rails/review.js';
import { executeAbort } from '../../rails/abort.js';

// Evidence schemas for external reference handling
import {
  InputOriginSchema,
  ExternalReferenceSchema,
  ReviewFindings,
} from '../../state/evidence.js';
import type { ReviewReferenceInput } from '../../rails/review.js';

// Review assurance (mandate digest)
import { REVIEW_MANDATE_DIGEST, REVIEW_CRITERIA_VERSION } from '../review-assurance.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';

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

function buildReviewReferenceInput(args: {
  inputOrigin?: ReviewReferenceInput['inputOrigin'];
  references?: ReviewReferenceInput['references'];
  text?: string;
  prNumber?: number;
  branch?: string;
  url?: string;
}): ReviewReferenceInput | undefined {
  const hasContent =
    args.inputOrigin || args.references || args.text || args.prNumber || args.branch || args.url;
  if (!hasContent) return undefined;
  return {
    inputOrigin: args.inputOrigin,
    references: args.references,
    text: args.text,
    prNumber: args.prNumber,
    branch: args.branch,
    url: args.url,
  };
}

function hasReviewContentInput(args: {
  text?: string;
  prNumber?: number;
  branch?: string;
  url?: string;
}): boolean {
  return (
    args.text !== undefined ||
    args.prNumber !== undefined ||
    args.branch !== undefined ||
    args.url !== undefined
  );
}

function formatMissingContentAnalysis(): string {
  return JSON.stringify({
    error: true,
    code: 'CONTENT_ANALYSIS_REQUIRED',
    message:
      'Content-aware /review requires subagent analysis. Call the flowguard-reviewer subagent via Task tool to analyze the provided content.',
    recovery: [
      'Load the referenced content (PR diff via gh CLI, URL via webfetch, or use manual text).',
      'Call Task tool with subagent_type: "flowguard-reviewer" and provide the content in the prompt.',
      'Instruct the subagent to return findings as JSON with blockingIssues and majorRisks arrays.',
      'Parse the subagent response and map findings to analysisFindings format.',
      'Re-run flowguard_review with analysisFindings populated.',
    ],
  });
}

function formatBlockedReviewReport(report: unknown): string {
  const blockedReport = report as {
    code: string;
    reason: string;
    recovery: readonly string[];
    quickFix?: string;
  };
  return JSON.stringify({
    error: true,
    code: blockedReport.code,
    message: blockedReport.reason,
    recovery: blockedReport.recovery,
    quickFix: blockedReport.quickFix,
  });
}

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
    text: z.string().optional().describe('Direct text blob to analyze during /review.'),
    prNumber: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('GitHub PR number to load via gh CLI and analyze during /review.'),
    branch: z.string().optional().describe('Git branch name to load via gh CLI and analyze.'),
    url: z.string().url().optional().describe('URL to fetch and analyze during /review.'),
    analysisFindings: ReviewFindings.optional().describe(
      'Complete findings from flowguard-reviewer subagent analysis. ' +
        'Required when content-aware fields (text/prNumber/branch/url) are provided. ' +
        'Must include reviewMode="subagent", reviewedBy, and valid attestation with ' +
        'mandateDigest and criteriaVersion.',
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
      let refInput = buildReviewReferenceInput(args);

      // Content-aware review requires analysisFindings
      const hasContentInput = hasReviewContentInput(args);
      if (hasContentInput && args.analysisFindings === undefined) {
        return formatMissingContentAnalysis();
      }

      // P0 #2 + P0 #3: If analysisFindings provided, validate and skip external content load
      if (args.analysisFindings !== undefined) {
        // Validate analysisFindings - must be proper ReviewFindings from flowguard-reviewer
        const findings = args.analysisFindings as Record<string, unknown>;
        const reviewMode = findings.reviewMode as string;
        const attestation = findings.attestation as Record<string, unknown> | undefined;

        // Must be from subagent
        if (reviewMode !== 'subagent') {
          return formatBlocked('SUBAGENT_REVIEW_NOT_INVOKED');
        }

        // Must have valid attestation with all required fields
        if (!attestation) {
          return formatBlocked('SUBAGENT_REVIEW_NOT_INVOKED');
        }

        // Verify attestation fields (no spoofable sessionId check)
        if (attestation.reviewedBy !== REVIEWER_SUBAGENT_TYPE) {
          return formatBlocked('SUBAGENT_REVIEW_NOT_INVOKED');
        }
        if (attestation.mandateDigest !== REVIEW_MANDATE_DIGEST) {
          return formatBlocked('SUBAGENT_REVIEW_NOT_INVOKED');
        }
        if (attestation.criteriaVersion !== REVIEW_CRITERIA_VERSION) {
          return formatBlocked('SUBAGENT_REVIEW_NOT_INVOKED');
        }

        // P0 #3: Keep ALL refInput fields for provenance, just add skipExternalContentLoad
        if (refInput) {
          refInput = { ...refInput, skipExternalContentLoad: true };
        }
      }

      // Create executors with analyze function that maps ReviewFindings to report format
      // Severity mapping
      const severityMap: Record<string, 'info' | 'warning' | 'error'> = {
        critical: 'error',
        major: 'error',
        minor: 'warning',
        info: 'info',
        error: 'error',
        warning: 'warning',
      };

      // Helper: Map ReviewFindings to report findings
      function mapReviewFindingsToReport(analysisFindings: Record<string, unknown>): Array<{
        severity: 'info' | 'warning' | 'error';
        category: string;
        message: string;
        location?: string;
      }> {
        const findings = analysisFindings;

        // Extract all finding types from ReviewFindings
        const allFindings: Array<Record<string, unknown>> = [
          ...((findings.blockingIssues as Array<Record<string, unknown>>) ?? []),
          ...((findings.majorRisks as Array<Record<string, unknown>>) ?? []),
          ...((findings.missingVerification as string[]) ?? []).map((message) => ({
            severity: 'warning' as const,
            category: 'missing-verification',
            message,
          })),
          ...((findings.scopeCreep as string[]) ?? []).map((message) => ({
            severity: 'warning' as const,
            category: 'scope-creep',
            message,
          })),
          ...((findings.unknowns as string[]) ?? []).map((message) => ({
            severity: 'info' as const,
            category: 'unknown',
            message,
          })),
        ];

        return allFindings
          .filter((f) => f.severity && f.category && f.message)
          .map((f) => ({
            severity: severityMap[f.severity as string] ?? 'warning',
            category: f.category as string,
            message: f.message as string,
            ...(f.location ? { location: f.location as string } : {}),
          }));
      }

      const executors: ReviewExecutors = {
        analyze: async () => {
          if (!args.analysisFindings) return [];
          return mapReviewFindingsToReport(args.analysisFindings as Record<string, unknown>);
        },
      };

      const report = await executeReview(result.state, now, executors, refInput);

      if ('kind' in report && report.kind === 'blocked') {
        return formatBlockedReviewReport(report);
      }

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
