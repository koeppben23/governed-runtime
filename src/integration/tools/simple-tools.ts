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

// Crypto — fingerprint generation
import { createHash } from 'node:crypto';

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
import { executeReview, startReviewFlow, type ReviewExecutors } from '../../rails/review.js';
import { autoAdvance, createPolicyEvalFn } from '../../rails/types.js';
import { executeAbort } from '../../rails/abort.js';

// Evidence schemas for external reference handling
import {
  InputOriginSchema,
  ExternalReferenceSchema,
  ReviewFindings,
} from '../../state/evidence.js';
import type { ReviewReferenceInput } from '../../rails/review.js';

// Review assurance (mandate digest, obligation lifecycle)
import {
  REVIEW_MANDATE_DIGEST,
  REVIEW_CRITERIA_VERSION,
  createReviewObligation,
  appendReviewObligation,
  findLatestPendingReviewObligation,
  findReviewObligationById,
  consumeReviewObligation,
  validateStrictAttestation,
  ensureReviewAssurance,
  buildInvocationEvidence,
  hasEvidenceReuse,
  hashFindings,
  hashText,
  appendInvocationEvidence,
  fulfillObligation,
} from '../review-assurance.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';

// Presentation
import { PHASE_LABELS } from '../../presentation/phase-labels.js';
import { buildReviewReportCard } from '../../presentation/review-report-card.js';
import { materializeReviewCardArtifact } from '../../adapters/workspace/evidence-artifacts.js';

// Adapters
import { writeReport, reportPath } from '../../adapters/persistence.js';
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

/**
 * Compute an input fingerprint for a content-aware /review call.
 * All content fields are included so that different combinations
 * (e.g. prNumber=42+text=A vs. prNumber=42+text=B) get different fingerprints.
 */
function fingerprintReviewInput(args: {
  prNumber?: number;
  branch?: string;
  url?: string;
  text?: string;
  inputOrigin?: string;
  references?: unknown;
}): string {
  const payload = JSON.stringify({
    prNumber: args.prNumber,
    branch: args.branch,
    url: args.url,
    textHash: args.text
      ? createHash('sha256').update(args.text, 'utf-8').digest('hex').slice(0, 16)
      : undefined,
    inputOrigin: args.inputOrigin,
    references: args.references
      ? createHash('sha256')
          .update(JSON.stringify(args.references), 'utf-8')
          .digest('hex')
          .slice(0, 16)
      : undefined,
  });
  return createHash('sha256').update(payload, 'utf-8').digest('hex');
}

/**
 * Canonical recovery payload for any blocked /review response that requires the
 * primary agent to re-invoke the flowguard-reviewer subagent. Includes the
 * exact attestation values the subagent must populate so the agent never has
 * to guess `mandateDigest`, `criteriaVersion`, or `toolObligationId`.
 *
 * `toolObligationId` is the UUID of the ReviewObligation created for this
 * content-aware /review call. Every content-aware /review now creates a real
 * obligation before sending a blocked response.
 */
function buildRequiredReviewAttestationPayload(obligationId: string): {
  requiredReviewAttestation: {
    reviewedBy: string;
    mandateDigest: string;
    criteriaVersion: string;
    toolObligationId: string;
  };
  reviewerSubagentType: string;
  recovery: string[];
} {
  return {
    requiredReviewAttestation: {
      reviewedBy: REVIEWER_SUBAGENT_TYPE,
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: obligationId,
    },
    reviewerSubagentType: REVIEWER_SUBAGENT_TYPE,
    recovery: [
      'Load the referenced content (PR diff via gh CLI, URL via webfetch, or use manual text).',
      'Call Task tool with subagent_type: "flowguard-reviewer" and provide the content in the prompt.',
      'Pass the requiredReviewAttestation values to the subagent so it populates attestation.reviewedBy, attestation.mandateDigest, attestation.criteriaVersion, and attestation.toolObligationId exactly as provided.',
      'Instruct the subagent to return a complete ReviewFindings object (reviewMode, reviewedBy, reviewedAt, attestation, blockingIssues, majorRisks, missingVerification, scopeCreep, unknowns).',
      'Parse the subagent response as a ReviewFindings object - do NOT convert it to an array and do NOT drop attestation fields.',
      'Re-run flowguard_review with analysisFindings set to the complete ReviewFindings object. In strict mode, copied attestation fields alone are diagnostic context only; FlowGuard must persist matching ReviewInvocationEvidence before the findings satisfy governance.',
    ],
  };
}

function formatBlockedWithAttestation(code: string, message: string, obligationId: string): string {
  return JSON.stringify({
    error: true,
    code,
    message,
    ...buildRequiredReviewAttestationPayload(obligationId),
  });
}

function formatMissingContentAnalysis(obligationId: string): string {
  return formatBlockedWithAttestation(
    'CONTENT_ANALYSIS_REQUIRED',
    'Content-aware /review requires subagent analysis. Call the flowguard-reviewer subagent via Task tool to analyze the provided content, then re-run flowguard_review with the complete ReviewFindings object. Manual JSON/attestation copy alone is not sufficient in strict mode; FlowGuard must persist matching ReviewInvocationEvidence.',
    obligationId,
  );
}

function formatSubagentReviewNotInvoked(detail: string, obligationId: string): string {
  return formatBlockedWithAttestation(
    'SUBAGENT_REVIEW_NOT_INVOKED',
    `Supplied analysisFindings did not pass subagent attestation: ${detail}. Re-run the flowguard-reviewer subagent with the requiredReviewAttestation values and submit the complete ReviewFindings object. Copied attestation fields are diagnostic context only until FlowGuard persists matching ReviewInvocationEvidence.`,
    obligationId,
  );
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

      // 1. Transition READY → REVIEW (no autoAdvance — report must be written first, P8b).
      let result = startReviewFlow(state, ctx);

      if (result.kind === 'blocked') {
        return formatRailResult(result);
      }

      // 2. Generate the compliance report using the final state
      const now = new Date().toISOString();
      let refInput = buildReviewReferenceInput(args);

      // Content-aware review requires analysisFindings.
      // When absent, create or reuse a pending review obligation for this
      // specific input and return a blocked response so the agent gets the
      // canonical attestation values.
      const hasContentInput = hasReviewContentInput(args);
      if (hasContentInput && args.analysisFindings === undefined) {
        // Compute an input fingerprint so that different review inputs
        // (e.g. prNumber=42 vs. prNumber=99) get different obligations.
        const fingerprint = fingerprintReviewInput(args);
        const assurance = state.reviewAssurance;
        let obligation = findLatestPendingReviewObligation(assurance, 'review', fingerprint);
        if (!obligation) {
          obligation = createReviewObligation({
            obligationType: 'review',
            iteration: 1,
            planVersion: 1,
            now,
            metadata: { fingerprint },
          });
          const augmentedState = {
            ...state,
            reviewAssurance: appendReviewObligation(assurance, obligation),
          };
          await writeStateWithArtifacts(sessDir, augmentedState);
        }

        return formatMissingContentAnalysis(obligation.obligationId);
      }

      // If analysisFindings provided, resolve the obligation it targets.
      // Priority: attestation.toolObligationId (set by the blocked response or
      // the plugin-orchestrator). Fallback: fingerprint + pending status (for
      // manual submissions that predate the obligation).
      let validatedReviewObligation: ReturnType<typeof findLatestPendingReviewObligation> = null;
      if (args.analysisFindings !== undefined) {
        const findings = args.analysisFindings as Record<string, unknown>;
        const reviewMode = findings.reviewMode as string;
        const fingerprint = fingerprintReviewInput(args);
        const assurance = state.reviewAssurance;

        // Resolve the obligation by its canonical UUID if the attestation
        // carries one (both blocked response and plugin-orchestrator set it).
        const attToolObligationId = (findings.attestation as Record<string, unknown> | undefined)
          ?.toolObligationId as string | undefined;
        const obligationById = attToolObligationId
          ? findReviewObligationById(assurance, attToolObligationId)
          : null;
        let obligation =
          obligationById ?? findLatestPendingReviewObligation(assurance, 'review', fingerprint);

        if (!obligation) {
          obligation = createReviewObligation({
            obligationType: 'review',
            iteration: 1,
            planVersion: 1,
            now,
            metadata: { fingerprint },
          });
          const augmentedState = {
            ...state,
            reviewAssurance: appendReviewObligation(assurance, obligation),
          };
          await writeStateWithArtifacts(sessDir, augmentedState);

          return formatSubagentReviewNotInvoked(
            'no review obligation found — a fresh obligation has been created. Re-submit your findings with the toolObligationId from the returned requiredReviewAttestation.',
            obligation.obligationId,
          );
        }

        // Guard consumed obligations (single-use enforcement).
        if (obligation.status === 'consumed') {
          return formatSubagentReviewNotInvoked(
            'this review obligation has already been consumed. Start a fresh /review to create a new obligation.',
            obligation.obligationId,
          );
        }

        if (reviewMode !== 'subagent') {
          return formatSubagentReviewNotInvoked(
            'reviewMode is not "subagent" — findings did not come from the flowguard-reviewer subagent',
            obligation.obligationId,
          );
        }

        // Delegate to the central validateStrictAttestation gate that /plan,
        // /architecture, and /implement use. This avoids duplicating attestation
        // logic and guarantees the same enforcement.
        const verdict = validateStrictAttestation(
          findings as unknown as Parameters<typeof validateStrictAttestation>[0],
          {
            obligationId: obligation.obligationId,
            iteration: obligation.iteration,
            planVersion: obligation.planVersion,
          },
        );

        if (verdict) {
          return formatSubagentReviewNotInvoked(
            `validateStrictAttestation returned ${verdict}`,
            obligation.obligationId,
          );
        }

        // Track the exact obligation that passed validation so it — and only it —
        // is consumed on success. This prevents consuming a different pending
        // obligation belonging to another review input.
        validatedReviewObligation = obligation;

        // Record invocation evidence from accepted subagent-attested findings.
        // This reconstructs audit evidence from the fields in analysisFindings —
        // childSessionId comes from the subagent's attested reviewedBy.sessionId
        // (not from a host-side subagent invocation intercept, so this is
        // attested/reconstructed evidence, not host-captured evidence).
        if (args.analysisFindings) {
          const findings = args.analysisFindings as Record<string, unknown>;
          const childSessionId = String(
            (findings.reviewedBy as Record<string, unknown>).sessionId ?? '',
          );
          if (!childSessionId) {
            return formatSubagentReviewNotInvoked(
              'Subagent findings must include reviewedBy.sessionId.',
              obligation.obligationId,
            );
          }

          const findingsHash = hashFindings(findings);
          const promptHash = hashText(fingerprintReviewInput(args));

          // Plugin-orchestrator path: if host-orchestrated evidence already
          // exists for this obligation, the submitted findings MUST match it
          // exactly. No downgrade to manual path — the host already captured
          // authoritative evidence.
          const assurance = ensureReviewAssurance(result.state.reviewAssurance);
          const hostInvForObligation = assurance.invocations.find(
            (inv) =>
              inv.obligationId === obligation.obligationId && inv.source === 'host-orchestrated',
          );

          if (hostInvForObligation) {
            // Host-orchestrated evidence exists for this obligation.
            // Only accept findings that match it exactly.
            if (
              hostInvForObligation.findingsHash !== findingsHash ||
              hostInvForObligation.childSessionId !== childSessionId
            ) {
              return formatBlockedWithAttestation(
                'SUBAGENT_MANDATE_MISMATCH',
                'Submitted findings do not match the host-orchestrated reviewer findings for this obligation. Re-submit with the exact pluginReviewFindings provided by the plugin.',
                obligation.obligationId,
              );
            }
            // Exact match — evidence already recorded by plugin, skip creation.
          } else {
            // No host-orchestrated evidence — manual path.
            if (hasEvidenceReuse(assurance.invocations, childSessionId, findingsHash)) {
              return formatBlockedWithAttestation(
                'SUBAGENT_EVIDENCE_REUSED',
                'The submitted subagent findings have already been used for a prior review obligation.',
                obligation.obligationId,
              );
            }

            // Manual path: create agent-submitted-attested evidence.
            const invocation = buildInvocationEvidence({
              obligationId: obligation.obligationId,
              obligationType: 'review',
              parentSessionId: context.sessionID,
              childSessionId,
              promptHash,
              findingsHash,
              invokedAt: now,
              fulfilledAt: now,
              source: 'agent-submitted-attested',
            });

            result = {
              ...result,
              state: {
                ...result.state,
                reviewAssurance: appendInvocationEvidence(
                  fulfillObligation(
                    ensureReviewAssurance(result.state.reviewAssurance),
                    obligation.obligationId,
                    invocation.invocationId,
                    now,
                  ),
                  invocation,
                ),
              },
            };
          }
          // Consumption happens below via validatedReviewObligation.
        }

        // Skip the external content reload: the subagent has already analysed
        // the source content. Preserve every other refInput field for provenance.
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

      // Consume exactly the obligation that passed attestation validation.
      // This prevents a race where two different review inputs (`prNumber=42`
      // and `prNumber=99`) each have a pending obligation, and consuming the
      // wrong one breaks the other review chain.
      if (validatedReviewObligation) {
        result = {
          ...result,
          state: {
            ...result.state,
            reviewAssurance: consumeReviewObligation(
              ensureReviewAssurance(result.state.reviewAssurance),
              validatedReviewObligation,
              now,
            ),
          },
        };
      }

      // 3. Write report — if this fails, no REVIEW_COMPLETE state is persisted.
      await writeReport(sessDir, report);

      // 4. Set reviewReportPath on state, then autoAdvance REVIEW → REVIEW_COMPLETE.
      //    The reviewDone guard (P8b) requires reviewReportPath to be set,
      //    proving the report was actually persisted before advancing.
      const stateWithReportPath = {
        ...result.state,
        reviewReportPath: reportPath(sessDir),
      };
      const evalFn = createPolicyEvalFn(ctx);
      const { state: finalState, transitions: advanceTransitions } = autoAdvance(
        stateWithReportPath,
        evalFn,
        ctx,
      );
      // Merge transitions from startReviewFlow + autoAdvance
      const allTransitions = [
        ...(result.kind === 'ok' ? result.transitions : []),
        ...advanceTransitions,
      ];

      await writeStateWithArtifacts(sessDir, finalState);

      // Build the review report card as a markdown presentation layer.
      const assurance = ensureReviewAssurance(result.state.reviewAssurance);
      const boundInvocation = validatedReviewObligation
        ? assurance.invocations.find(
            (inv) => inv.obligationId === validatedReviewObligation.obligationId,
          )
        : undefined;
      const findingsForCard = args.analysisFindings
        ? (args.analysisFindings as Record<string, unknown>)
        : undefined;
      const reviewCard = buildReviewReportCard({
        phase: finalState.phase,
        phaseLabel: PHASE_LABELS[finalState.phase],
        overallStatus: report.overallStatus,
        findings: report.findings ?? [],
        completeness: {
          overallComplete: report.completeness.overallComplete,
          fourEyes: report.completeness.fourEyes?.satisfied ?? false,
          summary:
            `${report.completeness.summary.complete}/${report.completeness.summary.total} complete, ` +
            `${report.completeness.summary.missing} missing`,
        },
        inputOrigin: args.inputOrigin as string | undefined,
        references: args.references as Array<{ ref: string; type: string }> | undefined,
        obligationId: validatedReviewObligation?.obligationId,
        invocationSource: boundInvocation?.source,
        reviewerSessionId:
          boundInvocation?.childSessionId ??
          ((findingsForCard?.reviewedBy as Record<string, unknown>)?.sessionId as
            | string
            | undefined),
      });

      // Materialize the review card as an immutable evidence artifact.
      const artifactErr = await materializeReviewCardArtifact(
        sessDir,
        'review-report-card',
        reviewCard,
        result.state,
        validatedReviewObligation?.obligationId ??
          // Fallback: content-derived digest so two different review cards
          // in the same session still get different artifact files.
          createHash('sha256').update(reviewCard, 'utf-8').digest('hex').slice(0, 16),
      );
      const artifactWarning = artifactErr ?? undefined;

      return appendNextAction(
        JSON.stringify({
          reviewCard,
          phase: finalState.phase,
          ...(artifactWarning && { artifactWarning }),
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
          _audit: { transitions: allTransitions },
        }),
        finalState,
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
