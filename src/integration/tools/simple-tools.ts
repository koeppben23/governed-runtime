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

import type { ToolContext, ToolDefinition } from './helpers.js';
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
import type { ReviewObligation } from '../../state/evidence-review.js';
import type { SessionState } from '../../state/schema.js';
import type { ReviewReferenceInput } from '../../rails/review.js';

// Review assurance (mandate digest, obligation lifecycle)
import {
  REVIEW_MANDATE_DIGEST,
  REVIEW_CRITERIA_VERSION,
  createReviewObligation,
  appendReviewObligation,
  findLatestPendingReviewObligation,
  findReviewObligationById,
  findAcceptedInvocationForFindings,
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
import { PHASE_LABELS, buildReviewReportCard } from '../../presentation/index.js';
import { materializeReviewCardArtifact } from '../../adapters/workspace/index.js';

// Adapters
import { writeReport, reportPath } from '../../adapters/persistence.js';
import { ActorClaimError } from '../../adapters/actor.js';

import { writeStateWithArtifacts } from './helpers.js';

async function safeExecute(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ActorClaimError) {
      return formatBlocked(err.code);
    }
    return formatError(err);
  }
}

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
    return safeExecute(async () => {
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
      return persistAndFormat(sessDir, result);
    });
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
      `Call Task tool with subagent_type: "${REVIEWER_SUBAGENT_TYPE}" and provide the content in the prompt.`,
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
    `Content-aware /review requires subagent analysis. Call the ${REVIEWER_SUBAGENT_TYPE} subagent via Task tool to analyze the provided content, then re-run flowguard_review with the complete ReviewFindings object. Manual JSON/attestation copy alone is not sufficient in strict mode; FlowGuard must persist matching ReviewInvocationEvidence.`,
    obligationId,
  );
}

function formatSubagentReviewNotInvoked(detail: string, obligationId: string): string {
  return formatBlockedWithAttestation(
    'SUBAGENT_REVIEW_NOT_INVOKED',
    `Supplied analysisFindings did not pass subagent attestation: ${detail}. Re-run the ${REVIEWER_SUBAGENT_TYPE} subagent with the requiredReviewAttestation values and submit the complete ReviewFindings object. Copied attestation fields are diagnostic context only until FlowGuard persists matching ReviewInvocationEvidence.`,
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

type ReviewToolArgs = {
  inputOrigin?: ReviewReferenceInput['inputOrigin'];
  references?: ReviewReferenceInput['references'];
  text?: string;
  prNumber?: number;
  branch?: string;
  url?: string;
  analysisFindings?: ReviewFindings;
};

type StartedReviewResult = Extract<ReturnType<typeof startReviewFlow>, { kind: 'ok' }>;

type ReviewExecutionContext = {
  args: ReviewToolArgs;
  context: ToolContext;
  now: string;
  policy: string;
};

type ReviewPreparation = {
  result: StartedReviewResult;
  refInput?: ReviewReferenceInput;
  validatedReviewObligation: ReviewObligation | null;
};

type ReviewReportResult = Exclude<Awaited<ReturnType<typeof executeReview>>, { kind: 'blocked' }>;

const reviewSeverityMap: Record<string, 'info' | 'warning' | 'error'> = {
  critical: 'error',
  major: 'error',
  minor: 'warning',
  info: 'info',
  error: 'error',
  warning: 'warning',
};

async function persistReviewObligation(
  sessDir: string,
  state: SessionState,
  obligation: ReviewObligation,
): Promise<void> {
  await writeStateWithArtifacts(sessDir, {
    ...state,
    reviewAssurance: appendReviewObligation(state.reviewAssurance, obligation),
  });
}

async function ensureMissingAnalysisObligation(
  sessDir: string,
  state: SessionState,
  args: ReviewToolArgs,
  now: string,
): Promise<string | null> {
  if (!hasReviewContentInput(args) || args.analysisFindings !== undefined) return null;
  const fingerprint = fingerprintReviewInput(args);
  let obligation = findLatestPendingReviewObligation(state.reviewAssurance, 'review', fingerprint);
  if (!obligation) {
    obligation = createReviewObligation({
      obligationType: 'review',
      iteration: 1,
      planVersion: 1,
      now,
      metadata: { fingerprint },
    });
    await persistReviewObligation(sessDir, state, obligation);
  }
  return formatMissingContentAnalysis(obligation.obligationId);
}

async function resolveSubmittedReviewObligation(
  sessDir: string,
  state: SessionState,
  args: ReviewToolArgs,
  now: string,
): Promise<{ obligation: ReviewObligation; blocked?: string }> {
  const findings = args.analysisFindings as Record<string, unknown>;
  const attToolObligationId = (findings.attestation as Record<string, unknown> | undefined)
    ?.toolObligationId as string | undefined;
  const obligationById = attToolObligationId
    ? findReviewObligationById(state.reviewAssurance, attToolObligationId)
    : null;
  const fingerprint = fingerprintReviewInput(args);
  let obligation =
    obligationById ??
    findLatestPendingReviewObligation(state.reviewAssurance, 'review', fingerprint);

  if (!obligation) {
    obligation = createReviewObligation({
      obligationType: 'review',
      iteration: 1,
      planVersion: 1,
      now,
      metadata: { fingerprint },
    });
    await persistReviewObligation(sessDir, state, obligation);
    return {
      obligation,
      blocked: formatSubagentReviewNotInvoked(
        'no review obligation found — a fresh obligation has been created. Re-submit your findings with the toolObligationId from the returned requiredReviewAttestation.',
        obligation.obligationId,
      ),
    };
  }
  return { obligation };
}

function validateSubmittedReviewFindings(
  args: ReviewToolArgs,
  obligation: ReviewObligation,
): string | null {
  if (obligation.status === 'consumed') {
    return formatSubagentReviewNotInvoked(
      'this review obligation has already been consumed. Start a fresh /review to create a new obligation.',
      obligation.obligationId,
    );
  }

  const findings = args.analysisFindings as Record<string, unknown>;
  if ((findings.reviewMode as string) !== 'subagent') {
    return formatSubagentReviewNotInvoked(
      `reviewMode is not "subagent" — findings did not come from the ${REVIEWER_SUBAGENT_TYPE} subagent`,
      obligation.obligationId,
    );
  }

  const verdict = validateStrictAttestation(
    findings as unknown as Parameters<typeof validateStrictAttestation>[0],
    {
      obligationId: obligation.obligationId,
      iteration: obligation.iteration,
      planVersion: obligation.planVersion,
    },
  );
  return verdict
    ? formatSubagentReviewNotInvoked(
        `validateStrictAttestation returned ${verdict}`,
        obligation.obligationId,
      )
    : null;
}

function validateTextCompatInvocation(
  findings: Record<string, unknown>,
  obligation: ReviewObligation,
  hostInvForObligation: ReturnType<typeof ensureReviewAssurance>['invocations'][number] | undefined,
): string | null {
  const submittedReviewOutput = findings.pluginReviewOutput as Record<string, unknown> | undefined;
  if (submittedReviewOutput?.reviewOutputMode !== 'text_compat') return null;
  if (hostInvForObligation?.reviewOutputMode !== 'text_compat') {
    return formatBlockedWithAttestation(
      'SUBAGENT_MANDATE_MISMATCH',
      'Submitted text-compat findings require matching host-orchestrated ReviewInvocationEvidence with reviewOutputMode: text_compat.',
      obligation.obligationId,
    );
  }
  if (
    hostInvForObligation.reviewAssuranceLevel !== 'text_compat_lower' ||
    hostInvForObligation.structuredOutputUsed !== false ||
    !hostInvForObligation.extractionMethod
  ) {
    return formatBlockedWithAttestation(
      'SUBAGENT_MANDATE_MISMATCH',
      'Submitted text-compat findings require complete lower-assurance invocation metadata.',
      obligation.obligationId,
    );
  }
  return null;
}

function validateHostInvocationEvidence(input: {
  hostInvForObligation: ReturnType<typeof ensureReviewAssurance>['invocations'][number];
  findingsHash: string;
  childSessionId: string;
  policy: string;
  context: ToolContext;
  obligation: ReviewObligation;
}): string | null {
  const { hostInvForObligation, findingsHash, childSessionId, policy, context, obligation } = input;
  const policyMismatch =
    policy === 'host_task_required' &&
    (hostInvForObligation.invocationMode !== 'host_subagent_task' ||
      hostInvForObligation.hostVisible !== true ||
      hostInvForObligation.parentSessionId !== context.sessionID ||
      hostInvForObligation.criteriaVersion !== obligation.criteriaVersion ||
      hostInvForObligation.mandateDigest !== obligation.mandateDigest);
  if (
    hostInvForObligation.findingsHash === findingsHash &&
    hostInvForObligation.childSessionId === childSessionId &&
    !policyMismatch
  )
    return null;
  return formatBlockedWithAttestation(
    'SUBAGENT_MANDATE_MISMATCH',
    'Submitted findings do not match the host-orchestrated reviewer findings for this obligation. Re-submit with the exact pluginReviewFindings provided by the plugin.',
    obligation.obligationId,
  );
}

function buildManualInvocationState(input: {
  result: StartedReviewResult;
  obligation: ReviewObligation;
  context: ToolContext;
  childSessionId: string;
  findingsHash: string;
  promptHash: string;
  now: string;
}): StartedReviewResult {
  const { result, obligation, context, childSessionId, findingsHash, promptHash, now } = input;
  const invocation = buildInvocationEvidence({
    obligationId: obligation.obligationId,
    obligationType: 'review',
    parentSessionId: context.sessionID,
    childSessionId,
    invocationMode: 'manual_attested',
    hostVisible: false,
    promptHash,
    findingsHash,
    invokedAt: now,
    fulfilledAt: now,
    source: 'agent-submitted-attested',
  });
  return {
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

function recordSubmittedReviewInvocation(
  result: StartedReviewResult,
  obligation: ReviewObligation,
  exec: ReviewExecutionContext,
): { result: StartedReviewResult; blocked?: string } {
  const findings = exec.args.analysisFindings as Record<string, unknown>;
  const childSessionId = String((findings.reviewedBy as Record<string, unknown>).sessionId ?? '');
  if (!childSessionId) {
    return {
      result,
      blocked: formatSubagentReviewNotInvoked(
        'Subagent findings must include reviewedBy.sessionId.',
        obligation.obligationId,
      ),
    };
  }

  const findingsHash = hashFindings(findings);
  const assurance = ensureReviewAssurance(result.state.reviewAssurance);
  const hostInvForObligation = assurance.invocations.find(
    (inv) => inv.obligationId === obligation.obligationId && inv.source === 'host-orchestrated',
  );
  const textCompatBlock = validateTextCompatInvocation(findings, obligation, hostInvForObligation);
  if (textCompatBlock) return { result, blocked: textCompatBlock };
  if (hostInvForObligation) {
    return {
      result,
      blocked:
        validateHostInvocationEvidence({
          hostInvForObligation,
          findingsHash,
          childSessionId,
          policy: exec.policy,
          context: exec.context,
          obligation,
        }) ?? undefined,
    };
  }
  return recordManualReviewInvocation({
    result,
    obligation,
    exec,
    childSessionId,
    findingsHash,
    assurance,
  });
}

function recordManualReviewInvocation(input: {
  result: StartedReviewResult;
  obligation: ReviewObligation;
  exec: ReviewExecutionContext;
  childSessionId: string;
  findingsHash: string;
  assurance: ReturnType<typeof ensureReviewAssurance>;
}): { result: StartedReviewResult; blocked?: string } {
  const { result, obligation, exec, childSessionId, findingsHash, assurance } = input;
  if (exec.policy === 'host_task_required') {
    return {
      result,
      blocked: formatBlockedWithAttestation(
        'HOST_SUBAGENT_TASK_REQUIRED',
        `This policy requires host-visible Task-tool evidence for ${REVIEWER_SUBAGENT_TYPE}; manual-attested /review findings are not accepted.`,
        obligation.obligationId,
      ),
    };
  }
  if (hasEvidenceReuse(assurance.invocations, childSessionId, findingsHash)) {
    return {
      result,
      blocked: formatBlockedWithAttestation(
        'SUBAGENT_EVIDENCE_REUSED',
        'The submitted subagent findings have already been used for a prior review obligation.',
        obligation.obligationId,
      ),
    };
  }
  return {
    result: buildManualInvocationState({
      result,
      obligation,
      context: exec.context,
      childSessionId,
      findingsHash,
      promptHash: hashText(fingerprintReviewInput(exec.args)),
      now: exec.now,
    }),
  };
}

async function prepareReviewExecution(
  sessDir: string,
  state: SessionState,
  result: StartedReviewResult,
  exec: ReviewExecutionContext,
): Promise<ReviewPreparation | string> {
  const missingAnalysis = await ensureMissingAnalysisObligation(
    sessDir,
    state,
    exec.args,
    exec.now,
  );
  if (missingAnalysis) return missingAnalysis;

  let refInput = buildReviewReferenceInput(exec.args);
  if (exec.args.analysisFindings === undefined) {
    return { result, refInput, validatedReviewObligation: null };
  }

  const resolved = await resolveSubmittedReviewObligation(sessDir, state, exec.args, exec.now);
  if (resolved.blocked) return resolved.blocked;
  const validationBlock = validateSubmittedReviewFindings(exec.args, resolved.obligation);
  if (validationBlock) return validationBlock;
  const recorded = recordSubmittedReviewInvocation(result, resolved.obligation, exec);
  if (recorded.blocked) return recorded.blocked;
  if (refInput) refInput = { ...refInput, skipExternalContentLoad: true };
  return { result: recorded.result, refInput, validatedReviewObligation: resolved.obligation };
}

function mapReviewFindingsToReport(analysisFindings: Record<string, unknown>): Array<{
  severity: 'info' | 'warning' | 'error';
  category: string;
  message: string;
  location?: string;
}> {
  const allFindings: Array<Record<string, unknown>> = [
    ...((analysisFindings.blockingIssues as Array<Record<string, unknown>>) ?? []),
    ...((analysisFindings.majorRisks as Array<Record<string, unknown>>) ?? []),
    ...((analysisFindings.missingVerification as string[]) ?? []).map((message) => ({
      severity: 'warning' as const,
      category: 'missing-verification',
      message,
    })),
    ...((analysisFindings.scopeCreep as string[]) ?? []).map((message) => ({
      severity: 'warning' as const,
      category: 'scope-creep',
      message,
    })),
    ...((analysisFindings.unknowns as string[]) ?? []).map((message) => ({
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

function buildReviewExecutors(args: ReviewToolArgs): ReviewExecutors {
  return {
    analyze: async () => {
      if (!args.analysisFindings) return [];
      return mapReviewFindingsToReport(args.analysisFindings);
    },
  };
}

function consumeValidatedReviewObligation(
  result: StartedReviewResult,
  obligation: ReviewObligation | null,
  args: ReviewToolArgs,
  now: string,
): StartedReviewResult {
  if (!obligation) return result;
  return {
    ...result,
    state: {
      ...result.state,
      reviewAssurance: consumeReviewObligation(
        ensureReviewAssurance(result.state.reviewAssurance),
        obligation,
        now,
        findAcceptedInvocationForFindings(
          result.state.reviewAssurance,
          obligation,
          args.analysisFindings,
        )?.invocationId,
      ),
    },
  };
}

async function persistReviewCompletion(
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

async function buildReviewCompletionResponse(input: {
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
    ((args.analysisFindings?.reviewedBy as Record<string, unknown> | undefined)?.sessionId as
      | string
      | undefined)
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
      validatedReviewObligation?.obligationId ??
        createHash('sha256').update(reviewCard, 'utf-8').digest('hex').slice(0, 16),
    )) ?? undefined
  );
}

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
      `Complete findings from ${REVIEWER_SUBAGENT_TYPE} subagent analysis. ` +
        'Required when content-aware fields (text/prNumber/branch/url) are provided. ' +
        'Must include reviewMode="subagent", reviewedBy, and valid attestation with ' +
        'mandateDigest and criteriaVersion.',
    ),
  },
  async execute(args, context) {
    try {
      const { sessDir, state, ctx } = await withMutableSession(context);
      const now = new Date().toISOString();
      let result = startReviewFlow(state, ctx);

      if (result.kind === 'blocked') return formatRailResult(result);

      const prepared = await prepareReviewExecution(sessDir, state, result, {
        args,
        context,
        now,
        policy: state.policySnapshot?.reviewInvocationPolicy ?? 'host_task_required',
      });
      if (typeof prepared === 'string') return prepared;

      result = prepared.result;
      const reviewResult = await executeReview(
        result.state,
        now,
        buildReviewExecutors(args),
        prepared.refInput,
      );
      if (reviewResult.kind === 'blocked') {
        return formatBlockedReviewReport(reviewResult);
      }
      result = consumeValidatedReviewObligation(
        result,
        prepared.validatedReviewObligation,
        args,
        now,
      );
      const completion = await persistReviewCompletion(sessDir, result, reviewResult, ctx);
      return buildReviewCompletionResponse({
        sessDir,
        args,
        result,
        report: reviewResult,
        validatedReviewObligation: prepared.validatedReviewObligation,
        ...completion,
      });
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
    return safeExecute(async () => {
      const { sessDir, state, ctx } = await withMutableSession(context);
      const result = executeAbort(state, { reason: args.reason, actor: context.sessionID }, ctx);
      return persistAndFormat(sessDir, result);
    });
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// archive — extracted to archive-tool.ts (P2b)
export { archive } from './archive-tool.js';
