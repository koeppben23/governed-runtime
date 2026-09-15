/**
 * @module integration/review/standard-review-pipeline
 * @description Standard review pipeline for plan, implementation, and architecture reviews.
 *
 * Creates review obligations, builds prompts, invokes the reviewer subagent,
 * handles success/failure paths, enforces review gates, records evidence,
 * and emits audit events.
 */

import { ReviewFindings as ReviewFindingsSchema } from '../../state/evidence.js';
import type { ReviewObligationType } from '../../state/evidence.js';
import type { CapturedFindings } from './enforcement/types.js';
import { recordPluginReview } from './enforcement/enforcement.js';
import { prepareReviewerFindingsForValidation } from './enforcement/prepare-findings.js';
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  findBindableAttempt,
  isCurrentReviewGeneration,
  hashFindings,
  hashText,
} from './assurance.js';
import { buildMutatedOutput, type ReviewerSuccessResult } from './orchestrator.js';
import { selectReviewerProfileRules } from './prompt-builders.js';
import { getToolArgs, strictBlockedOutput } from '../plugin-helpers.js';
import { TOOL_FLOWGUARD_PLAN, TOOL_FLOWGUARD_ARCHITECTURE } from '../tool-names.js';
import { obligationTypeForTool } from './obligation-tools.js';
import { updateObligation } from './obligation-state.js';
import { recordAssuranceWithAudit } from './shared-helpers.js';
import type { PipelineContext } from './pipeline-types.js';
import type { EvidenceRecordResult } from './pipeline-types.js';
import { buildSdkEvidenceAuditIntents } from './sdk-evidence-recorder.js';
import {
  validatePipelineAttestation,
  recordEvidenceOrBlockReuse,
  blockReviewOutcomeHelper,
  isOutputAlreadyBlocked,
  buildToolPrompt,
  buildAttemptFailedLogger,
  buildAttemptSucceededLogger,
  buildReviewDiscoveryContextForPipeline,
} from './shared-helpers.js';

// ─── Standard Review Pipeline ────────────────────────────────────────────────

export async function runStandardReviewPipeline(
  ctx: PipelineContext,
  toolName: string,
  input: unknown,
): Promise<void> {
  const { deps, sessionState, output } = ctx;

  const obligationType = obligationTypeForTool(toolName);
  if (!obligationType) {
    output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      reason: `unsupported reviewable tool for review orchestration: ${toolName}`,
    });
    deps.log.warn('orchestrator', 'unsupported reviewable tool — blocked', { tool: toolName });
    return;
  }

  // Hard subject-authority gate: no exact obligation ⇒ no reviewer execution.
  // A missing or type-mismatched obligation must never let the pipeline fall
  // back to mutable implementation identity (the prompt derives its anchor
  // contract from the obligation; without it there is no frozen subject).
  const exactObligation = sessionState.reviewAssurance?.obligations.find(
    (o) => o.obligationId === ctx.reviewCtx.obligationId,
  );
  if (!exactObligation || exactObligation.obligationType !== obligationType) {
    output.output = strictBlockedOutput('REVIEW_MATERIAL_INTEGRITY_FAILED', {
      reason: `review orchestration requires an exact ${obligationType} review obligation for ${ctx.reviewCtx.obligationId}`,
    });
    deps.log.warn('orchestrator', 'missing or mismatched review obligation — blocked', {
      tool: toolName,
      obligationId: ctx.reviewCtx.obligationId,
      obligationType,
    });
    return;
  }

  if (
    !isCurrentReviewGeneration(exactObligation) ||
    ctx.reviewCtx.criteriaVersion !== exactObligation.criteriaVersion ||
    ctx.reviewCtx.mandateDigest !== exactObligation.mandateDigest
  ) {
    output.output = strictBlockedOutput('REVIEW_GENERATION_MISMATCH', {
      obligationId: exactObligation.obligationId,
      reason:
        `review obligation generation ${exactObligation.criteriaVersion}/${exactObligation.mandateDigest} ` +
        `is not executable by the current runtime ${REVIEW_CRITERIA_VERSION}/${REVIEW_MANDATE_DIGEST}; ` +
        're-hydrate or create a fresh review obligation',
    });
    return;
  }

  const assuranceResult = await recordObligationHandshake(ctx, obligationType);
  if (blockOnAuditFailure(ctx, assuranceResult)) return;

  const prompt = await buildStandardPromptAndLog(ctx, toolName, input);
  if (!prompt) return;

  const reviewerResult = await spawnStandardReviewer(ctx, toolName, prompt);
  await handleStandardReviewerResult(ctx, {
    toolName,
    reviewerResult,
    prompt,
    obligationType,
  });
}

async function recordObligationHandshake(
  ctx: PipelineContext,
  obligationType: ReviewObligationType,
): ReturnType<typeof recordAssuranceWithAudit> {
  const { deps, sessionState, sessDir, reviewCtx } = ctx;
  return recordAssuranceWithAudit(
    {
      updateReviewAssurance: (sessDir, update, semanticIntents) =>
        deps.updateReviewAssurance(sessDir, update, semanticIntents),
    },
    {
      sessDir,
      stateMutation: (s, now2) =>
        updateObligation(s, reviewCtx.obligationId, (item) => ({
          ...item,
          pluginHandshakeAt: now2,
        })),
      auditEventName: 'review:obligation_created',
      auditDetail: {
        obligationId: reviewCtx.obligationId,
        obligationType,
        iteration: reviewCtx.iteration,
        planVersion: reviewCtx.planVersion,
        criteriaVersion: reviewCtx.criteriaVersion,
        mandateDigest: reviewCtx.mandateDigest,
        reviewProfile: sessionState.policySnapshot.reviewProfile,
        profileSource: 'policy_default',
      },
    },
  );
}

function blockOnAuditFailure(
  ctx: PipelineContext,
  assuranceResult: Awaited<ReturnType<typeof recordAssuranceWithAudit>>,
): boolean {
  if (assuranceResult.auditOk || !assuranceResult.block) return false;
  ctx.output.output = strictBlockedOutput('AUDIT_PERSISTENCE_FAILED', {
    reason: assuranceResult.reason ?? 'audit write failed',
  });
  return true;
}

async function spawnStandardReviewer(
  ctx: PipelineContext,
  toolName: string,
  prompt: string,
): ReturnType<PipelineContext['deps']['adapter']['spawnReviewer']> {
  return ctx.deps.adapter.spawnReviewer({
    prompt,
    parentSessionId: ctx.sessionId,
    onAttemptFailed: buildAttemptFailedLogger(ctx.deps, toolName, ctx.sessionId),
    onAttemptSucceeded: buildAttemptSucceededLogger(ctx.deps, toolName),
  });
}

interface StandardReviewerResultOpts {
  toolName: string;
  reviewerResult: Awaited<ReturnType<PipelineContext['deps']['adapter']['spawnReviewer']>>;
  prompt: string;
  obligationType: ReviewObligationType;
}

async function handleStandardReviewerResult(
  ctx: PipelineContext,
  opts: StandardReviewerResultOpts,
): Promise<void> {
  const { reviewerResult, obligationType } = opts;
  if (reviewerResult?.blocked) {
    if (reviewerResult.code === 'REVIEWER_INVOCATION_EXHAUSTED') {
      await handleReviewerFailure(ctx, obligationType);
      return;
    }
    ctx.output.output = strictBlockedOutput(reviewerResult.code, {
      reason: reviewerResult.reason ?? 'review invocation blocked by host transport contract',
      reviewInvocation: JSON.stringify(reviewerResult.reviewInvocation ?? {}),
    });
    return;
  }
  if (!reviewerResult) {
    await handleReviewerFailure(ctx, obligationType);
    return;
  }
  await handleReviewerSuccess(ctx, { ...opts, reviewerResult });
}

function buildToolArgsDiagnostics(
  toolName: string,
  toolArgs: Record<string, unknown>,
  planText: string,
  adrText: string,
): Record<string, unknown> {
  if (toolName === TOOL_FLOWGUARD_PLAN && typeof toolArgs.planText === 'string') {
    return {
      toolArgsPlanTextLength: toolArgs.planText.length,
      planTextMismatch: toolArgs.planText !== planText,
    };
  }
  if (toolName === TOOL_FLOWGUARD_ARCHITECTURE && typeof toolArgs.adrText === 'string') {
    return {
      toolArgsAdrTextLength: toolArgs.adrText.length,
      adrTextMismatch: toolArgs.adrText !== adrText,
    };
  }
  return {};
}

async function buildStandardPromptAndLog(
  ctx: PipelineContext,
  toolName: string,
  input: unknown,
): Promise<string | null> {
  const { deps, sessionState, reviewCtx, parsedOutput, sessionId } = ctx;
  const ticketText = sessionState.ticket?.text ?? '';
  const planText = sessionState.plan?.current?.body ?? '';
  const adrText = sessionState.architecture?.adrText ?? '';
  const adrTitle = sessionState.architecture?.title ?? '';
  const toolArgs = getToolArgs(input);

  const planRules = selectReviewerProfileRules(sessionState.activeProfile, 'PLAN_REVIEW');
  const implRules = selectReviewerProfileRules(sessionState.activeProfile, 'IMPL_REVIEW');
  const archRules = selectReviewerProfileRules(sessionState.activeProfile, 'ARCH_REVIEW');
  const discoveryContext = await buildReviewDiscoveryContextForPipeline(ctx);

  const prompt = buildToolPrompt({
    toolName,
    texts: { planText, ticketText, adrText, adrTitle },
    reviewCtx,
    parsedOutput,
    sessionState,
    rules: { planRules, implRules, archRules },
    deps,
    discoveryContext,
  });
  if (!prompt) return null;

  deps.log.info('orchestrator', 'invoking reviewer subagent', {
    tool: toolName,
    sessionId,
    iteration: reviewCtx.iteration,
    planVersion: reviewCtx.planVersion,
    planTextLength: planText.length,
    planTextSource: 'sessionState',
    ...buildToolArgsDiagnostics(toolName, toolArgs, planText, adrText),
  });

  return prompt;
}

// ─── Standard Pipeline: Success Handler ──────────────────────────────────────

interface ReviewSuccessOpts {
  toolName: string;
  reviewerResult: ReviewerSuccessResult;
  prompt: string;
  obligationType: ReviewObligationType;
}

async function handleReviewerSuccess(ctx: PipelineContext, opts: ReviewSuccessOpts): Promise<void> {
  const { toolName, reviewerResult, prompt, obligationType } = opts;
  const { deps, output, sessionId, rawOutput } = ctx;

  if (!reviewerResult.findings) {
    await handleUnparseableReviewerResult(ctx, opts);
    return;
  }

  const canonicalReviewerResult = await prepareStandardReviewerResult(ctx, reviewerResult);
  if (!canonicalReviewerResult) return;
  const parsedFindings = ReviewFindingsSchema.parse(canonicalReviewerResult.findings);

  const gateBlocked = await enforceStandardGate(
    ctx,
    canonicalReviewerResult,
    parsedFindings,
    prompt,
    obligationType,
  );
  if (gateBlocked) return;

  if (isOutputAlreadyBlocked(output)) return;

  const mutated = buildMutatedOutput(rawOutput, canonicalReviewerResult);
  if (mutated) {
    await finalizeReviewOutput(ctx, {
      toolName,
      reviewerResult: canonicalReviewerResult,
      mutated,
    });
  } else {
    deps.log.warn('orchestrator', 'review output mutation failed — blocking', {
      tool: toolName,
      sessionId,
    });
    output.output = strictBlockedOutput('STRICT_REVIEW_ORCHESTRATION_FAILED', {
      reason: 'output mutation failed',
    });
  }
}

async function handleUnparseableReviewerResult(
  ctx: PipelineContext,
  opts: ReviewSuccessOpts,
): Promise<void> {
  const { deps, sessionId } = ctx;
  const { toolName, reviewerResult } = opts;
  deps.log.warn('orchestrator', 'reviewer returned unparseable response — blocking', {
    tool: toolName,
    sessionId,
    childSessionId: reviewerResult.sessionId,
    rawResponseLength: reviewerResult.rawResponse.length,
  });
  await blockReviewOutcomeHelper(deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
    reason: 'reviewer response was not parseable as ReviewFindings',
  });
}

async function prepareStandardReviewerResult(
  ctx: PipelineContext,
  reviewerResult: ReviewerSuccessResult,
): Promise<(ReviewerSuccessResult & { findings: Record<string, unknown> }) | null> {
  const prepared = prepareReviewerFindingsForValidation({
    rawFindings: reviewerResult.findings!,
    obligationId: ctx.reviewCtx.obligationId,
    hostConstants: {
      mandateDigest: ctx.reviewCtx.mandateDigest,
      criteriaVersion: ctx.reviewCtx.criteriaVersion,
    },
    hostProvenance: {
      childSessionId: reviewerResult.sessionId,
      reviewedAt: reviewerResult.fulfilledAt ?? new Date().toISOString(),
    },
  });
  if (!prepared.ok) {
    await blockReviewOutcomeHelper(ctx.deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
      reason: 'reviewer response did not match ReviewFindings schema',
    });
    return null;
  }
  const parsed = ReviewFindingsSchema.safeParse(prepared.findings);
  if (!parsed.success) {
    await blockReviewOutcomeHelper(ctx.deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
      reason: 'reviewer response did not match ReviewFindings schema',
    });
    return null;
  }
  return { ...reviewerResult, findings: prepared.findings };
}

function applyStandardEvidenceResult(ctx: PipelineContext, result: EvidenceRecordResult): boolean {
  const { output, reviewCtx } = ctx;
  if (result === 'reused') {
    output.output = strictBlockedOutput('SUBAGENT_EVIDENCE_REUSED', {
      obligationId: reviewCtx.obligationId,
    });
    return true;
  }
  if (result === 'missing') {
    output.output = strictBlockedOutput('REVIEW_MATERIAL_INTEGRITY_FAILED', {
      reason: `no exact review obligation resolved for ${reviewCtx.obligationId}; evidence was not recorded`,
    });
    return true;
  }
  if (result === 'lineage_unavailable') {
    output.output = strictBlockedOutput('REVIEW_ATTEMPT_UNAVAILABLE', {
      obligationId: reviewCtx.obligationId,
      reason: 'SDK review evidence could not bind to the pre-authorized review attempt',
    });
    return true;
  }
  return false;
}

async function enforceStandardGate(
  ctx: PipelineContext,
  reviewerResult: ReviewerSuccessResult & { findings: Record<string, unknown> },
  findings: {
    reviewMode?: string;
    attestation?: Record<string, unknown> | null;
    overallVerdict?: string;
  },
  prompt: string,
  obligationType: ReviewObligationType,
): Promise<boolean> {
  const { deps, sessDir, reviewCtx, sessionState, output, sessionId } = ctx;

  const attestation = validatePipelineAttestation(findings, {
    obligationId: reviewCtx.obligationId,
    criteriaVersion: reviewCtx.criteriaVersion,
    mandateDigest: reviewCtx.mandateDigest,
    iteration: reviewCtx.iteration,
    planVersion: reviewCtx.planVersion,
    checkReviewedBy: false,
    checkUnableToReview: true,
  });

  if (!attestation.valid) {
    await blockReviewOutcomeHelper(deps, ctx, attestation.code, attestation.detail);
    return true;
  }

  const attempt = findBindableAttempt(sessionState.reviewAssurance, reviewCtx.obligationId);
  if (!attempt) {
    output.output = strictBlockedOutput('REVIEW_ATTEMPT_UNAVAILABLE', {
      obligationId: reviewCtx.obligationId,
      reason: 'SDK review completion has no pre-authorized bindable review attempt',
    });
    return true;
  }

  const promptHash = hashText(prompt);
  const findingsHash = hashFindings(reviewerResult.findings);
  const invokedAt = reviewerResult.invokedAt ?? ctx.now;
  const fulfilledAt = reviewerResult.fulfilledAt ?? new Date().toISOString();

  const result = await recordEvidenceOrBlockReuse(deps, sessDir, {
    obligationId: reviewCtx.obligationId,
    obligationType,
    sessionId,
    childSessionId: reviewerResult.sessionId,
    attemptId: attempt.attemptId,
    promptHash,
    findingsHash,
    invokedAt,
    fulfilledAt,
    reviewerResult,
    semanticIntents: (result, state, occurredAt) =>
      buildSdkEvidenceAuditIntents({
        ctx,
        result,
        obligationType,
        promptHash,
        findingsHash,
        reviewerResult,
        state,
        occurredAt,
        reviewProfile: state.policySnapshot.reviewProfile,
      }),
  });

  return applyStandardEvidenceResult(ctx, result);
}

interface FinalizeOutputOpts {
  toolName: string;
  reviewerResult: ReviewerSuccessResult & { findings: Record<string, unknown> };
  mutated: string;
}

async function finalizeReviewOutput(ctx: PipelineContext, opts: FinalizeOutputOpts): Promise<void> {
  const { toolName, reviewerResult, mutated } = opts;
  const { deps, output, sessionId, now } = ctx;

  const eState = deps.getEnforcementState(sessionId);
  const captured: CapturedFindings = {
    overallVerdict:
      typeof reviewerResult.findings.overallVerdict === 'string'
        ? reviewerResult.findings.overallVerdict
        : 'unknown',
    blockingIssuesCount: Array.isArray(reviewerResult.findings.blockingIssues)
      ? reviewerResult.findings.blockingIssues.length
      : 0,
    sessionId: reviewerResult.sessionId,
    rawFindings: reviewerResult.findings,
  };

  recordPluginReview(eState, toolName, reviewerResult.sessionId, captured, now);
  output.output = mutated;

  deps.log.info('orchestrator', 'reviewer invocation succeeded', {
    tool: toolName,
    sessionId,
    childSessionId: reviewerResult.sessionId,
    verdict: reviewerResult.findings.overallVerdict,
  });
}

// ─── Standard Pipeline: Failure Handler ──────────────────────────────────────

async function handleReviewerFailure(ctx: PipelineContext, obligationType: string): Promise<void> {
  const { deps, sessDir, sessionId, reviewCtx, parsedOutput, sessionState, output } = ctx;
  const phase = String(parsedOutput.phase ?? sessionState.phase);

  deps.log.warn('orchestrator', 'reviewer invocation failed — blocking', {
    tool: obligationType,
    sessionId,
  });

  await deps.blockReviewOutcome(
    { sessDir, sessionId, phase },
    reviewCtx.obligationId,
    'STRICT_REVIEW_ORCHESTRATION_FAILED',
    { reason: 'reviewer invocation failed' },
    output,
  );
}
