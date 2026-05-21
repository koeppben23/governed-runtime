/**
 * @module integration/tools/review-tool/completion
 * @description Review report building, persistence, card materialization, and response formatting.
 *
 * Extracted from simple-tools.ts for single-responsibility compliance.
 *
 * @version v1
 */

import { createHash } from 'node:crypto';

import type { SessionState } from '../../../state/schema.js';
import type { ReviewObligation } from '../../../state/evidence.js';
import type { ReviewExecutors } from '../../../rails/review.js';
import { autoAdvance, createPolicyEvalFn } from '../../../rails/types.js';
import { PHASE_LABELS, buildReviewReportCard } from '../../../presentation/index.js';
import { materializeReviewCardArtifact } from '../../../adapters/workspace/index.js';
import { writeReport, reportPath } from '../../../adapters/persistence.js';
import { writeStateWithArtifacts, appendNextAction } from '../helpers.js';
import { ensureReviewAssurance } from '../../review/assurance.js';
import type { ReviewToolArgs, StartedReviewResult, ReviewReportResult } from './types.js';

// ─── Severity mapping ────────────────────────────────────────────────────────

const reviewSeverityMap: Record<string, 'info' | 'warning' | 'error'> = {
  critical: 'error',
  major: 'error',
  minor: 'warning',
  info: 'info',
  error: 'error',
  warning: 'warning',
};

// ─── Report building ─────────────────────────────────────────────────────────

export function mapReviewFindingsToReport(reviewFindings: Record<string, unknown>): Array<{
  severity: 'info' | 'warning' | 'error';
  category: string;
  message: string;
  location?: string;
}> {
  const allFindings: Array<Record<string, unknown>> = [
    ...((reviewFindings.blockingIssues as Array<Record<string, unknown>>) ?? []),
    ...((reviewFindings.majorRisks as Array<Record<string, unknown>>) ?? []),
    ...((reviewFindings.missingVerification as string[]) ?? []).map((message) => ({
      severity: 'warning' as const,
      category: 'missing-verification',
      message,
    })),
    ...((reviewFindings.scopeCreep as string[]) ?? []).map((message) => ({
      severity: 'warning' as const,
      category: 'scope-creep',
      message,
    })),
    ...((reviewFindings.unknowns as string[]) ?? []).map((message) => ({
      severity: 'info' as const,
      category: 'unknown',
      message,
    })),
  ];

  return allFindings
    .filter((f) => f.severity && f.category && f.message)
    .map((f) => ({
      severity: reviewSeverityMap[f.severity as string] ?? 'warning',
      category: f.category as string,
      message: f.message as string,
      ...(f.location ? { location: f.location as string } : {}),
    }));
}

export function buildReviewExecutors(args: ReviewToolArgs): ReviewExecutors {
  return {
    analyze: async () => {
      if (!args.reviewFindings) return [];
      return mapReviewFindingsToReport(args.reviewFindings);
    },
  };
}

// ─── Blocked report formatting ───────────────────────────────────────────────

export function formatBlockedReviewReport(report: unknown): string {
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

// ─── Persistence ─────────────────────────────────────────────────────────────

export async function persistReviewCompletion(
  sessDir: string,
  result: StartedReviewResult,
  report: ReviewReportResult,
  ctx: Parameters<typeof createPolicyEvalFn>[0],
): Promise<{ finalState: SessionState; allTransitions: StartedReviewResult['transitions'] }> {
  await writeReport(sessDir, report);
  const stateWithReportPath = { ...result.state, reviewReportPath: reportPath(sessDir) };
  const { state: finalState, transitions: advanceTransitions } = autoAdvance(
    stateWithReportPath,
    createPolicyEvalFn(ctx),
    ctx,
  );
  await writeStateWithArtifacts(sessDir, finalState);
  return { finalState, allTransitions: [...result.transitions, ...advanceTransitions] };
}

// ─── Review card construction ────────────────────────────────────────────────

function findBoundReviewInvocation(
  result: StartedReviewResult,
  obligation: ReviewObligation | null,
): ReturnType<typeof ensureReviewAssurance>['invocations'][number] | undefined {
  if (!obligation) return undefined;
  return ensureReviewAssurance(result.state.reviewAssurance).invocations.find(
    (inv) => inv.obligationId === obligation.obligationId,
  );
}

function reviewCardCompleteness(report: ReviewReportResult): {
  overallComplete: boolean;
  fourEyes: boolean;
  summary: string;
} {
  return {
    overallComplete: report.completeness.overallComplete,
    fourEyes: report.completeness.fourEyes?.satisfied ?? false,
    summary:
      `${report.completeness.summary.complete}/${report.completeness.summary.total} complete, ` +
      `${report.completeness.summary.missing} missing`,
  };
}

function reviewCardInvocationFields(
  boundInvocation: ReturnType<typeof ensureReviewAssurance>['invocations'][number] | undefined,
  args: ReviewToolArgs,
): {
  invocationSource?: string;
  invocationMode?: string;
  hostVisible?: boolean;
  reviewOutputMode?: string;
  structuredOutputUsed?: boolean;
  reviewAssuranceLevel?: string;
  extractionMethod?: string;
  reviewerSessionId?: string;
} {
  return {
    invocationSource: boundInvocation?.source,
    invocationMode: boundInvocation?.invocationMode,
    hostVisible: boundInvocation?.hostVisible,
    reviewOutputMode: boundInvocation?.reviewOutputMode,
    structuredOutputUsed: boundInvocation?.structuredOutputUsed,
    reviewAssuranceLevel: boundInvocation?.reviewAssuranceLevel,
    extractionMethod: boundInvocation?.extractionMethod,
    reviewerSessionId: reviewerSessionId(boundInvocation, args),
  };
}

function reviewerSessionId(
  boundInvocation: ReturnType<typeof ensureReviewAssurance>['invocations'][number] | undefined,
  args: ReviewToolArgs,
): string | undefined {
  return (
    boundInvocation?.childSessionId ??
    ((args.reviewFindings?.reviewedBy as Record<string, unknown> | undefined)?.sessionId as
      | string
      | undefined)
  );
}

function buildStandaloneReviewCard(input: {
  args: ReviewToolArgs;
  result: StartedReviewResult;
  finalState: SessionState;
  report: ReviewReportResult;
  validatedReviewObligation: ReviewObligation | null;
}): string {
  const { args, result, finalState, report, validatedReviewObligation } = input;
  const boundInvocation = findBoundReviewInvocation(result, validatedReviewObligation);
  return buildReviewReportCard({
    phase: finalState.phase,
    phaseLabel: PHASE_LABELS[finalState.phase],
    overallStatus: report.overallStatus,
    findings: report.findings ?? [],
    completeness: reviewCardCompleteness(report),
    inputOrigin: args.inputOrigin,
    references: args.references as Array<{ ref: string; type: string }> | undefined,
    obligationId: validatedReviewObligation?.obligationId,
    ...reviewCardInvocationFields(boundInvocation, args),
  });
}

async function materializeStandaloneReviewCard(input: {
  sessDir: string;
  result: StartedReviewResult;
  reviewCard: string;
  validatedReviewObligation: ReviewObligation | null;
}): Promise<{ code: string; message: string } | undefined> {
  const { sessDir, result, reviewCard, validatedReviewObligation } = input;
  return (
    (await materializeReviewCardArtifact(
      sessDir,
      'review-report-card',
      reviewCard,
      result.state,
      validatedReviewObligation?.obligationId ??
        createHash('sha256').update(reviewCard, 'utf-8').digest('hex').slice(0, 16),
    )) ?? undefined
  );
}

// ─── Response formatting ─────────────────────────────────────────────────────

function formatReviewCompletionResponse(input: {
  result: StartedReviewResult;
  finalState: SessionState;
  report: ReviewReportResult;
  allTransitions: StartedReviewResult['transitions'];
  reviewCard: string;
  artifactWarning?: { code: string; message: string };
}): string {
  const { result, finalState, report, allTransitions, reviewCard, artifactWarning } = input;
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
}

export async function buildReviewCompletionResponse(input: {
  sessDir: string;
  args: ReviewToolArgs;
  result: StartedReviewResult;
  finalState: SessionState;
  report: ReviewReportResult;
  allTransitions: StartedReviewResult['transitions'];
  validatedReviewObligation: ReviewObligation | null;
}): Promise<string> {
  const { sessDir, args, result, finalState, report, allTransitions, validatedReviewObligation } =
    input;
  const reviewCard = buildStandaloneReviewCard({
    args,
    result,
    finalState,
    report,
    validatedReviewObligation,
  });
  const artifactWarning = await materializeStandaloneReviewCard({
    sessDir,
    result,
    reviewCard,
    validatedReviewObligation,
  });
  return formatReviewCompletionResponse({
    finalState,
    result,
    report,
    allTransitions,
    reviewCard,
    artifactWarning,
  });
}
