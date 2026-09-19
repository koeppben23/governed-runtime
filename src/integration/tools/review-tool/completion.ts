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
import type {
  FrozenReviewSubject,
  PeerReviewCoverage,
  ReviewFindings,
  ReviewObligation,
  ReviewReportFinding,
} from '../../../state/evidence.js';
import type { ReviewInvocationEvidence } from '../../../state/evidence-review-invocation.js';
import type { ReviewExecutors } from '../../../rails/review.js';
import { ReviewReport } from '../../../state/evidence.js';
import { resolveAuthoritativePeerReviewTask } from '../../../state/peer-review.js';
import { autoAdvance, createPolicyEvalFn } from '../../../rails/types.js';
import type { AutoAdvanceOverflow } from '../../../rails/types.js';
import { PHASE_LABELS, buildReviewReportCard } from '../../../presentation/index.js';
import type { PresentationRenderOptions } from '../../../presentation/glyph-profile.js';
import { materializeReviewCardArtifact } from '../../../adapters/workspace/index.js';
import { readConfig } from '../../../adapters/persistence-config.js';
import { writeReport, reportPath } from '../../../adapters/persistence.js';
import { writeStateWithArtifacts, enrichWithWorkflowDirective } from '../helpers.js';
import { ensureReviewAssurance } from '../../review/assurance.js';
import { resolveWorkflowDirective } from '../../../machine/workflow-directive.js';
import { projectStatusActionFromCommand } from '../../status-conclusion.js';
import { projectCompletionProofStatus } from '../../proofgraph/proof-summary-projectors.js';
import type { StartedReviewResult, ReviewReportResult } from './types.js';

const reviewSeverityMap: Record<string, 'info' | 'warning' | 'error'> = {
  critical: 'error',
  major: 'error',
  minor: 'warning',
  info: 'info',
  error: 'error',
  warning: 'warning',
};

const CHALLENGE_OUTCOME_SEVERITY: Record<string, 'info' | 'warning' | 'error'> = {
  contradicted: 'error',
  fail: 'error',
  not_verified: 'warning',
  supported: 'info',
  pass: 'info',
};

function challengeFindings(
  reviewFindings: Pick<ReviewFindings, 'challenges'>,
): ReviewReportFinding[] {
  return reviewFindings.challenges.flatMap((entry) => challengeFinding(entry));
}

function challengeFinding(entry: unknown): ReviewReportFinding[] {
  if (typeof entry !== 'object' || entry === null) return [];
  const challenge = entry as Record<string, unknown>;
  const outcome = stringField(challenge.outcome);
  const scenario = stringField(challenge.scenario);
  if (!outcome || !scenario) return [];
  const claim = stringField(challenge.claim);
  const location = challengeLocation(challenge.locations);
  return [
    {
      source: 'challenge',
      reportSeverity: CHALLENGE_OUTCOME_SEVERITY[outcome] ?? 'warning',
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

export function mapReviewFindingsToReport(reviewFindings: ReviewFindings): ReviewReportFinding[] {
  const materialFindings = [...reviewFindings.blockingIssues, ...reviewFindings.majorRisks].map(
    (finding) => ({
      source: 'material_finding' as const,
      reportSeverity: reviewSeverityMap[finding.severity] ?? 'warning',
      finding,
    }),
  );
  return [
    ...materialFindings,
    ...reviewFindings.missingVerification.map((message) => ({
      source: 'missing_verification' as const,
      reportSeverity: 'warning' as const,
      category: 'missing-verification',
      message,
    })),
    ...reviewFindings.scopeCreep.map((message) => ({
      source: 'scope_creep' as const,
      reportSeverity: 'warning' as const,
      category: 'scope-creep',
      message,
    })),
    ...reviewFindings.unknowns.map((message) => ({
      source: 'unknown' as const,
      reportSeverity: 'info' as const,
      category: 'unknown',
      message,
    })),
    ...challengeFindings(reviewFindings),
  ];
}

export function buildReviewExecutors(effectiveReviewFindings?: ReviewFindings): ReviewExecutors {
  return {
    analyze: async () => {
      if (!effectiveReviewFindings) return [];
      return mapReviewFindingsToReport(effectiveReviewFindings);
    },
  };
}

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

export async function persistReviewCompletion(
  sessDir: string,
  result: StartedReviewResult,
  report: ReviewReportResult,
  ctx: Parameters<typeof createPolicyEvalFn>[0],
  validatedReviewObligation: ReviewObligation | null,
): Promise<
  | { kind: 'overflow'; overflow: AutoAdvanceOverflow }
  | {
      kind: 'ok';
      finalState: SessionState;
      report: ReviewReport;
      allTransitions: StartedReviewResult['transitions'];
    }
> {
  const stateWithReportPath = { ...result.state, reviewReportPath: reportPath(sessDir) };
  const advanced = autoAdvance(stateWithReportPath, createPolicyEvalFn(ctx), ctx);
  if (advanced.kind === 'overflow') {
    return { kind: 'overflow', overflow: advanced };
  }
  const { state: finalState, transitions: advanceTransitions } = advanced;
  const finalReport = ReviewReport.parse({
    ...report,
    phase: finalState.phase,
    peerReviewCoverage: buildPeerReviewCoverage({
      report,
      state: finalState,
      obligation: validatedReviewObligation,
    }),
  });
  await writeReport(sessDir, finalReport);
  await writeStateWithArtifacts(sessDir, finalState);
  return {
    kind: 'ok',
    finalState,
    report: finalReport,
    allTransitions: [...result.transitions, ...advanceTransitions],
  };
}

function findBoundReviewInvocation(
  state: SessionState,
  obligation: ReviewObligation | null,
): ReviewInvocationEvidence | undefined {
  if (!obligation) return undefined;
  return ensureReviewAssurance(state.reviewAssurance).invocations.find(
    (inv) => inv.obligationId === obligation.obligationId,
  );
}

function coverageTargetResolved(report: ReviewReportResult): boolean {
  if (report.reviewKind === 'content_review') return true;
  return report.planDigest !== null || report.implDigest !== null;
}

function coverageTargetFields(subject: FrozenReviewSubject | undefined): {
  targetFrozen: boolean;
  repositoryIdentityVerified: boolean | null;
  baseSha: string | null;
  headSha: string | null;
  changedPathCount: number;
} {
  if (subject?.kind !== 'repository_change') {
    return {
      targetFrozen: subject !== undefined,
      repositoryIdentityVerified: null,
      baseSha: null,
      headSha: null,
      changedPathCount: 0,
    };
  }
  return {
    targetFrozen: true,
    repositoryIdentityVerified: true,
    baseSha: subject.baseSha,
    headSha: subject.headSha,
    changedPathCount: subject.changedPaths.length,
  };
}

function coverageObjectives(
  state: SessionState,
  obligation: ReviewObligation | null,
): {
  objectivesCovered: number;
  objectivesTotal: number;
  reviewAssurance: PeerReviewCoverage['reviewAssurance'];
} {
  const authoritative = obligation
    ? resolveAuthoritativePeerReviewTask(state.peerReviewEvidence, obligation.obligationId)
    : null;
  const objectivesTotal = authoritative?.kind === 'ok' ? authoritative.task.objectives.length : 0;
  const boundInvocation = findBoundReviewInvocation(state, obligation);
  return {
    objectivesCovered: boundInvocation ? objectivesTotal : 0,
    objectivesTotal,
    reviewAssurance: boundInvocation?.reviewAssuranceLevel ?? null,
  };
}

export function buildPeerReviewCoverage(input: {
  readonly report: ReviewReportResult;
  readonly state: SessionState;
  readonly obligation: ReviewObligation | null;
}): PeerReviewCoverage {
  const { report, state, obligation } = input;
  const subject = report.reviewKind === 'content_review' ? report.reviewSubject : undefined;
  const findings: readonly ReviewReportFinding[] = report.findings;
  return {
    targetResolved: coverageTargetResolved(report),
    ...coverageTargetFields(subject),
    ...coverageObjectives(state, obligation),
    missingVerification: findings
      .filter((finding) => finding.source === 'missing_verification')
      .map((finding) => finding.message),
  };
}

interface ReviewCardInvocationFields {
  invocationSource?: ReviewInvocationEvidence['source'];
  invocationMode?: ReviewInvocationEvidence['invocationMode'];
  hostVisible?: boolean;
  reviewOutputMode?: ReviewInvocationEvidence['reviewOutputMode'];
  structuredOutputUsed?: ReviewInvocationEvidence['structuredOutputUsed'];
  reviewAssuranceLevel?: ReviewInvocationEvidence['reviewAssuranceLevel'];
  reviewerSessionId?: string;
}

type BoundReviewInvocation =
  ReturnType<typeof ensureReviewAssurance>['invocations'][number] | undefined;

function invocationTransportFields(
  boundInvocation: BoundReviewInvocation,
): ReviewCardInvocationFields {
  return {
    ...(boundInvocation?.source !== undefined ? { invocationSource: boundInvocation.source } : {}),
    ...(boundInvocation?.invocationMode !== undefined
      ? { invocationMode: boundInvocation.invocationMode }
      : {}),
    ...(boundInvocation?.hostVisible !== undefined
      ? { hostVisible: boundInvocation.hostVisible }
      : {}),
    ...(boundInvocation?.reviewOutputMode !== undefined
      ? { reviewOutputMode: boundInvocation.reviewOutputMode }
      : {}),
  };
}

function invocationAssuranceFields(
  boundInvocation: BoundReviewInvocation,
): ReviewCardInvocationFields {
  return {
    ...(boundInvocation?.structuredOutputUsed !== undefined
      ? { structuredOutputUsed: boundInvocation.structuredOutputUsed }
      : {}),
    ...(boundInvocation?.reviewAssuranceLevel !== undefined
      ? { reviewAssuranceLevel: boundInvocation.reviewAssuranceLevel }
      : {}),
    ...(boundInvocation?.childSessionId !== undefined
      ? { reviewerSessionId: boundInvocation.childSessionId }
      : {}),
  };
}

function reviewCardInvocationFields(
  boundInvocation: BoundReviewInvocation,
): ReviewCardInvocationFields {
  return {
    ...invocationTransportFields(boundInvocation),
    ...invocationAssuranceFields(boundInvocation),
  };
}

function buildPeerReviewCard(
  input: {
    result: StartedReviewResult;
    finalState: SessionState;
    report: ReviewReport;
    validatedReviewObligation: ReviewObligation | null;
  },
  options?: PresentationRenderOptions,
): string {
  const { result, finalState, report, validatedReviewObligation } = input;
  const boundInvocation = findBoundReviewInvocation(result.state, validatedReviewObligation);
  const directive = resolveWorkflowDirective(finalState);
  const primaryCommand = directive.commands[0];
  const conclusionAction = primaryCommand
    ? projectStatusActionFromCommand(primaryCommand, 'recommended')
    : undefined;
  return buildReviewReportCard(
    {
      phase: finalState.phase,
      phaseLabel: PHASE_LABELS[finalState.phase],
      overallStatus: report.overallStatus,
      findings: report.findings ?? [],
      coverage: report.peerReviewCoverage,
      ...(report.reviewKind === 'content_review' ? { reviewSubject: report.reviewSubject } : {}),
      ...(validatedReviewObligation?.obligationId !== undefined
        ? { obligationId: validatedReviewObligation.obligationId }
        : {}),
      proofSummary: projectCompletionProofStatus(finalState),
      directive,
      ...(conclusionAction ? { conclusionAction } : {}),
      ...reviewCardInvocationFields(boundInvocation),
    },
    options,
  );
}

async function materializePeerReviewCard(input: {
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

function formatReviewCompletionResponse(input: {
  result: StartedReviewResult;
  finalState: SessionState;
  report: ReviewReport;
  allTransitions: StartedReviewResult['transitions'];
  reviewCard: string;
  presentationMarkdown: string;
  artifactWarning?: { code: string; message: string } | undefined;
}): string {
  const {
    result,
    finalState,
    report,
    allTransitions,
    reviewCard,
    presentationMarkdown,
    artifactWarning,
  } = input;
  return JSON.stringify(
    enrichWithWorkflowDirective(
      {
        reviewCard,
        presentation: { markdown: presentationMarkdown },
        phase: finalState.phase,
        ...(artifactWarning && { artifactWarning }),
        status: 'Review flow complete. Report generated.',
        overallStatus: report.overallStatus,
        policyMode: result.state.policySnapshot?.mode ?? 'unknown',
        peerReviewCoverage: report.peerReviewCoverage,
        findingsCount: report.findings.length,
        findings: report.findings,
        validationSummary: report.validationSummary,
        ...(report.reviewKind === 'content_review' && { reviewSubject: report.reviewSubject }),
        _audit: { transitions: allTransitions },
      },
      finalState,
    ),
  );
}

export async function buildReviewCompletionResponse(input: {
  sessDir: string;
  result: StartedReviewResult;
  finalState: SessionState;
  report: ReviewReport;
  allTransitions: StartedReviewResult['transitions'];
  worktree: string;
  validatedReviewObligation: ReviewObligation | null;
}): Promise<string> {
  const {
    sessDir,
    result,
    finalState,
    report,
    allTransitions,
    worktree,
    validatedReviewObligation,
  } = input;
  const reviewCard = buildPeerReviewCard({
    result,
    finalState,
    report,
    validatedReviewObligation,
  });
  const artifactWarning = await materializePeerReviewCard({
    sessDir,
    result,
    reviewCard,
    validatedReviewObligation,
  });
  const presentationMarkdown = buildPeerReviewCard(
    { result, finalState, report, validatedReviewObligation },
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
  });
}
