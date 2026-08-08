/**
 * @module integration/tools/review-tool/completion
 * @description Review report building, persistence, card materialization, and response formatting.
 *
 * Extracted from simple-tools.ts for single-responsibility compliance.
 *
 * @version v1
 */

import { hashTextShort } from '../../../shared/hashing.js';

import type { SessionState } from '../../../state/schema.js';
import type { ReviewObligation } from '../../../state/evidence.js';
import type { ReviewExecutors } from '../../../rails/review.js';
import { autoAdvance, createPolicyEvalFn } from '../../../rails/types.js';
import type { AutoAdvanceOverflow } from '../../../rails/types.js';
import {
  PHASE_LABELS,
  buildProductNextAction,
  buildReviewReportCard,
} from '../../../presentation/index.js';
import type { PresentationRenderOptions } from '../../../presentation/glyph-profile.js';
import { materializeReviewCardArtifact } from '../../../adapters/workspace/index.js';
import { readConfig } from '../../../adapters/persistence-config.js';
import { writeReport, reportPath } from '../../../adapters/persistence.js';
import { writeStateWithArtifacts, appendNextAction } from '../helpers.js';
import { ensureReviewAssurance } from '../../review/assurance.js';
import { resolveNextAction } from '../../../machine/next-action.js';
import { projectCompletionProofStatus } from '../../proofgraph/proof-summary-projectors.js';
import { NATIVE_ATTESTATION_REJECTION_FIELD } from '../../../shared/flowguard-identifiers.js';
import type {
  NativeAttestationRejection,
  ReviewToolArgs,
  StartedReviewResult,
  ReviewReportResult,
} from './types.js';

// ─── Severity mapping ────────────────────────────────────────────────────────

const reviewSeverityMap: Record<string, 'info' | 'warning' | 'error'> = {
  critical: 'error',
  major: 'error',
  minor: 'warning',
  info: 'info',
  error: 'error',
  warning: 'warning',
};

// ─── Challenge projection ────────────────────────────────────────────────────

/**
 * Severity of a challenge outcome, from the author's point of view.
 *
 * `contradicted` / `fail` mean the reviewer's falsification attempt SUCCEEDED:
 * the claim under test did not hold. That is the most actionable result a review
 * produces. `not_verified` means the attempt could not be carried out, which is
 * an open risk rather than a confirmed defect. `supported` / `pass` record that
 * the claim withstood the attempt.
 */
const CHALLENGE_OUTCOME_SEVERITY: Record<string, 'info' | 'warning' | 'error'> = {
  contradicted: 'error',
  fail: 'error',
  not_verified: 'warning',
  supported: 'info',
  pass: 'info',
};

/**
 * Project reviewer challenges into report findings.
 *
 * Challenges are the most substantive artifact a review produces - an
 * evidence-bound falsification attempt with a concrete scenario and at least one
 * location (`ReviewChallenge.locations` is `.min(1)`, so unlike a plain finding
 * they are always located). They were dropped entirely from the report, so the
 * author never saw them.
 */
function challengeFindings(
  reviewFindings: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const challenges = reviewFindings.challenges;
  if (!Array.isArray(challenges)) return [];
  return challenges.flatMap((entry) => challengeFinding(entry));
}

/** Project one challenge, or nothing when it lacks the fields a reader needs. */
function challengeFinding(entry: unknown): Array<Record<string, unknown>> {
  if (typeof entry !== 'object' || entry === null) return [];
  const challenge = entry as Record<string, unknown>;
  const outcome = stringField(challenge.outcome);
  const scenario = stringField(challenge.scenario);
  if (!outcome || !scenario) return [];
  const claim = stringField(challenge.claim);
  const location = challengeLocation(challenge.locations);
  return [
    {
      severity: CHALLENGE_OUTCOME_SEVERITY[outcome] ?? 'warning',
      category: stringField(challenge.kind) || 'challenge',
      message: `[${outcome}] ${scenario}${claim ? ` - claim under test: ${claim}` : ''}`,
      ...(location ? { location } : {}),
    },
  ];
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function challengeLocation(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.filter((entry): entry is string => typeof entry === 'string').join(', ');
}

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
    ...challengeFindings(reviewFindings),
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

export function buildReviewExecutors(
  args: ReviewToolArgs,
  effectiveReviewFindings?: Record<string, unknown>,
): ReviewExecutors {
  return {
    analyze: async () => {
      const findings = effectiveReviewFindings ?? args.reviewFindings;
      if (!findings) return [];
      return mapReviewFindingsToReport(findings);
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
): Promise<
  | { kind: 'overflow'; overflow: AutoAdvanceOverflow }
  | {
      kind: 'ok';
      finalState: SessionState;
      allTransitions: StartedReviewResult['transitions'];
    }
> {
  const stateWithReportPath = { ...result.state, reviewReportPath: reportPath(sessDir) };
  const advanced = autoAdvance(stateWithReportPath, createPolicyEvalFn(ctx), ctx);
  // #428: fail closed on overflow BEFORE any persistence — do not write the
  // report artifact or the state, so no partially-advanced session is created.
  if (advanced.kind === 'overflow') {
    return { kind: 'overflow', overflow: advanced };
  }
  const { state: finalState, transitions: advanceTransitions } = advanced;
  const finalReport = {
    ...report,
    phase: finalState.phase,
    completeness: { ...report.completeness, phase: finalState.phase },
  };
  await writeReport(sessDir, finalReport);
  await writeStateWithArtifacts(sessDir, finalState);
  return {
    kind: 'ok',
    finalState,
    allTransitions: [...result.transitions, ...advanceTransitions],
  };
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
      string | undefined)
  );
}

function buildStandaloneReviewCard(
  input: {
    args: ReviewToolArgs;
    result: StartedReviewResult;
    finalState: SessionState;
    report: ReviewReportResult;
    validatedReviewObligation: ReviewObligation | null;
  },
  options?: PresentationRenderOptions,
): string {
  const { args, result, finalState, report, validatedReviewObligation } = input;
  const boundInvocation = findBoundReviewInvocation(result, validatedReviewObligation);
  const nextAction = resolveNextAction(finalState.phase, finalState);
  return buildReviewReportCard(
    {
      phase: finalState.phase,
      phaseLabel: PHASE_LABELS[finalState.phase],
      overallStatus: report.overallStatus,
      findings: report.findings ?? [],
      completeness: reviewCardCompleteness(report),
      inputOrigin: args.inputOrigin,
      references: args.references as Array<{ ref: string; type: string }> | undefined,
      obligationId: validatedReviewObligation?.obligationId,
      proofSummary: projectCompletionProofStatus(finalState),
      productNextAction: buildProductNextAction(nextAction, finalState.phase),
      ...reviewCardInvocationFields(boundInvocation, args),
    },
    options,
  );
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
      validatedReviewObligation?.obligationId ?? hashTextShort(reviewCard, 16),
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
  presentationMarkdown: string;
  artifactWarning?: { code: string; message: string };
  nativeAttestationRejection?: NativeAttestationRejection;
}): string {
  const {
    result,
    finalState,
    report,
    allTransitions,
    reviewCard,
    presentationMarkdown,
    artifactWarning,
    nativeAttestationRejection,
  } = input;
  return appendNextAction(
    JSON.stringify({
      reviewCard,
      presentation: { markdown: presentationMarkdown },
      phase: finalState.phase,
      ...(artifactWarning && { artifactWarning }),
      ...(nativeAttestationRejection && {
        [NATIVE_ATTESTATION_REJECTION_FIELD]: nativeAttestationRejection,
      }),
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
  worktree: string;
  validatedReviewObligation: ReviewObligation | null;
  nativeAttestationRejection?: NativeAttestationRejection;
}): Promise<string> {
  const {
    sessDir,
    args,
    result,
    finalState,
    report,
    allTransitions,
    worktree,
    validatedReviewObligation,
    nativeAttestationRejection,
  } = input;
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
  const presentationMarkdown = buildStandaloneReviewCard(
    { args, result, finalState, report, validatedReviewObligation },
    { glyphProfile: (await readConfig(worktree)).presentation.opencode.glyphProfile },
  );
  return formatReviewCompletionResponse({
    finalState,
    result,
    report,
    allTransitions,
    reviewCard,
    presentationMarkdown,
    artifactWarning,
    nativeAttestationRejection,
  });
}
