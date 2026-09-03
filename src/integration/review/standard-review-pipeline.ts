/**
 * @module integration/review/standard-review-pipeline
 * @description Standard review pipeline for plan, implementation, and architecture reviews.
 *
 * Creates review obligations, builds prompts, invokes the reviewer subagent,
 * handles success/failure paths, enforces strict gates, records evidence,
 * and emits audit events.
 */

import { ReviewFindings as ReviewFindingsSchema } from '../../state/evidence.js';
import type { ReviewObligationType } from '../../state/evidence.js';
import type { SessionState } from '../../state/schema.js';
import type { CapturedFindings } from './enforcement/types.js';
import { recordPluginReview } from './enforcement/enforcement.js';
import { prepareReviewerFindingsForValidation } from './enforcement/prepare-findings.js';
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
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
import type { SemanticAuditIntent } from '../tools/audit-outbox.js';
import { REVIEWER_SUBAGENT_TYPE } from './enforcement/types.js';
import { REASON_HOST_SUBAGENT_TASK_REQUIRED } from '../../shared/flowguard-identifiers.js';
import type { PipelineContext } from './pipeline-types.js';
import type { EvidenceRecordResult } from './pipeline-types.js';
import {
  validatePipelineAttestation,
  recordEvidenceOrBlockReuse,
  blockReviewOutcomeHelper,
  isStrictEnforcementEnabled,
  getReviewerPolicies,
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

  const strictEnforcement = isStrictEnforcementEnabled(sessionState);

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

  const assuranceResult = await recordObligationHandshake(ctx, obligationType, strictEnforcement);

  if (blockOnAuditFailure(ctx, assuranceResult)) return;

  const prompt = await buildStandardPromptAndLog(ctx, toolName, input);
  if (!prompt) return;

  const reviewerResult = await spawnStandardReviewer(ctx, toolName, prompt);
  await handleStandardReviewerResult(ctx, {
    toolName,
    reviewerResult,
    prompt,
    obligationType,
    strictEnforcement,
  });
}

async function recordObligationHandshake(
  ctx: PipelineContext,
  obligationType: ReviewObligationType,
  _strictEnforcement: boolean,
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
        // Freeze provenance: the mandatory review profile is frozen at
        // obligation creation. 'policy_default' is the only source in this wave.
        reviewProfile: getReviewerPolicies(sessionState).reviewProfile,
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
  const policies = getReviewerPolicies(ctx.sessionState);
  return ctx.deps.adapter.spawnReviewer({
    prompt,
    parentSessionId: ctx.sessionId,
    reviewOutputPolicy: policies.reviewOutputPolicy,
    reviewInvocationPolicy: policies.reviewInvocationPolicy,
    onAttemptFailed: buildAttemptFailedLogger(ctx.deps, toolName, ctx.sessionId),
    onAttemptSucceeded: buildAttemptSucceededLogger(ctx.deps, toolName),
  });
}

interface StandardReviewerResultOpts {
  toolName: string;
  reviewerResult: Awaited<ReturnType<PipelineContext['deps']['adapter']['spawnReviewer']>>;
  prompt: string;
  obligationType: ReviewObligationType;
  strictEnforcement: boolean;
}

async function handleStandardReviewerResult(
  ctx: PipelineContext,
  opts: StandardReviewerResultOpts,
): Promise<void> {
  const { reviewerResult, obligationType, strictEnforcement } = opts;
  if (reviewerResult?.blocked) {
    ctx.output.output = strictBlockedOutput(
      reviewerResult.code ?? REASON_HOST_SUBAGENT_TASK_REQUIRED,
      {
        reason: reviewerResult.reason ?? 'review invocation blocked by policy',
        reviewInvocation: JSON.stringify(reviewerResult.reviewInvocation ?? {}),
      },
    );
    return;
  }
  if (!reviewerResult) {
    await handleReviewerFailure(ctx, obligationType, strictEnforcement);
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
  strictEnforcement: boolean;
}

async function handleReviewerSuccess(ctx: PipelineContext, opts: ReviewSuccessOpts): Promise<void> {
  const { toolName, reviewerResult, prompt, obligationType, strictEnforcement } = opts;
  const { deps, output, sessionId, rawOutput } = ctx;

  if (!reviewerResult.findings) {
    await handleUnparseableReviewerResult(ctx, opts);
    return;
  }

  const canonicalReviewerResult = await prepareStandardReviewerResult(
    ctx,
    reviewerResult,
    strictEnforcement,
  );
  if (!canonicalReviewerResult) return;
  const parsedFindings = ReviewFindingsSchema.parse(canonicalReviewerResult.findings);

  if (strictEnforcement) {
    const gateBlocked = await enforceStandardStrictGate(
      ctx,
      canonicalReviewerResult,
      parsedFindings,
      prompt,
      obligationType,
    );
    if (gateBlocked) return;
  }

  if (strictEnforcement && isOutputAlreadyBlocked(output)) return;

  const mutated = buildMutatedOutput(rawOutput, canonicalReviewerResult);
  if (mutated) {
    // buildMutatedOutput returns non-null only when findings is non-null
    await finalizeReviewOutput(ctx, {
      toolName,
      reviewerResult: canonicalReviewerResult,
      mutated,
      strictEnforcement,
    });
  } else {
    deps.log.warn('orchestrator', 'output mutation failed (fallback to LLM-driven)', {
      tool: toolName,
      sessionId,
    });
    if (strictEnforcement) {
      output.output = strictBlockedOutput('STRICT_REVIEW_ORCHESTRATION_FAILED', {
        reason: 'output mutation failed',
      });
    }
  }
}

async function handleUnparseableReviewerResult(
  ctx: PipelineContext,
  opts: ReviewSuccessOpts,
): Promise<void> {
  const { deps, sessionId } = ctx;
  const { toolName, reviewerResult, strictEnforcement } = opts;
  deps.log.warn(
    'orchestrator',
    'reviewer returned unparseable response — fallback to LLM-driven path',
    {
      tool: toolName,
      sessionId,
      childSessionId: reviewerResult.sessionId,
      rawResponseLength: reviewerResult.rawResponse.length,
    },
  );
  if (strictEnforcement) {
    await blockReviewOutcomeHelper(deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
      reason: 'reviewer response was not parseable as ReviewFindings',
    });
  }
}

async function prepareStandardReviewerResult(
  ctx: PipelineContext,
  reviewerResult: ReviewerSuccessResult,
  strictEnforcement: boolean,
): Promise<(ReviewerSuccessResult & { findings: Record<string, unknown> }) | null> {
  const prepared = prepareReviewerFindingsForValidation({
    rawFindings: reviewerResult.findings!,
    obligationId: ctx.reviewCtx.obligationId,
    hostConstants: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
    },
    hostProvenance: {
      childSessionId: reviewerResult.sessionId,
      reviewedAt: new Date().toISOString(),
    },
  });
  if (!prepared.ok) {
    if (strictEnforcement) {
      await blockReviewOutcomeHelper(ctx.deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
        reason: 'reviewer response did not match ReviewFindings schema',
      });
    }
    return null;
  }
  const parsed = ReviewFindingsSchema.safeParse(prepared.findings);
  if (!parsed.success) return null;
  return { ...reviewerResult, findings: prepared.findings };
}

async function enforceStandardStrictGate(
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
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    mandateDigest: REVIEW_MANDATE_DIGEST,
    iteration: reviewCtx.iteration,
    planVersion: reviewCtx.planVersion,
    checkReviewedBy: false,
    checkUnableToReview: true,
  });

  if (!attestation.valid) {
    await blockReviewOutcomeHelper(deps, ctx, attestation.code, attestation.detail);
    return true;
  }

  const promptHash = hashText(prompt);
  const findingsHash = hashFindings(reviewerResult.findings);

  const result = await recordEvidenceOrBlockReuse(deps, sessDir, {
    obligationId: reviewCtx.obligationId,
    obligationType,
    sessionId,
    childSessionId: reviewerResult.sessionId,
    promptHash,
    findingsHash,
    reviewerResult,
    currentAssuranceInvocations: sessionState.reviewAssurance?.invocations ?? [],
    semanticIntents: (result, state, occurredAt) =>
      buildStandardEvidenceAuditIntents({
        ctx,
        result,
        obligationType,
        promptHash,
        findingsHash,
        reviewerResult,
        state,
        occurredAt,
      }),
  });

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

  return false;
}

function buildStandardEvidenceAuditIntents(input: {
  ctx: PipelineContext;
  result: EvidenceRecordResult;
  obligationType: string;
  promptHash: string;
  findingsHash: string;
  reviewerResult: Pick<
    ReviewerSuccessResult,
    | 'sessionId'
    | 'reviewOutputMode'
    | 'structuredOutputUsed'
    | 'reviewAssuranceLevel'
    | 'extractionMethod'
    | 'modelCapabilityError'
  >;
  state: SessionState;
  occurredAt: string;
}): readonly SemanticAuditIntent[] {
  const {
    ctx,
    result,
    obligationType,
    promptHash,
    findingsHash,
    reviewerResult,
    state,
    occurredAt,
  } = input;
  const { sessionId, reviewCtx } = ctx;
  const detail =
    result === 'reused'
      ? { obligationId: reviewCtx.obligationId, code: 'SUBAGENT_EVIDENCE_REUSED' }
      : {
          obligationId: reviewCtx.obligationId,
          obligationType,
          parentSessionId: sessionId,
          childSessionId: reviewerResult.sessionId,
          agentType: REVIEWER_SUBAGENT_TYPE,
          promptHash,
          mandateDigest: REVIEW_MANDATE_DIGEST,
          criteriaVersion: REVIEW_CRITERIA_VERSION,
          findingsHash,
          reviewOutputMode: reviewerResult.reviewOutputMode,
          structuredOutputUsed: reviewerResult.structuredOutputUsed,
          reviewAssuranceLevel: reviewerResult.reviewAssuranceLevel,
          reviewProfile: getReviewerPolicies(state).reviewProfile,
          ...(reviewerResult.extractionMethod
            ? { extractionMethod: reviewerResult.extractionMethod }
            : {}),
          ...(reviewerResult.modelCapabilityError
            ? { modelCapabilityError: reviewerResult.modelCapabilityError }
            : {}),
        };
  const first: SemanticAuditIntent = {
    phase: state.phase,
    event: result === 'reused' ? 'review:obligation_blocked' : 'review:subagent_invoked',
    occurredAt,
    detail,
  };
  return result === 'fulfilled'
    ? [
        first,
        {
          phase: state.phase,
          event: 'review:obligation_fulfilled',
          occurredAt,
          detail: {
            obligationId: reviewCtx.obligationId,
            childSessionId: reviewerResult.sessionId,
          },
        },
      ]
    : [first];
}

interface FinalizeOutputOpts {
  toolName: string;
  reviewerResult: ReviewerSuccessResult & { findings: Record<string, unknown> };
  mutated: string;
  strictEnforcement: boolean;
}

async function finalizeReviewOutput(ctx: PipelineContext, opts: FinalizeOutputOpts): Promise<void> {
  const { toolName, reviewerResult, mutated, strictEnforcement } = opts;
  const { deps, output, sessionId, now } = ctx;

  if (strictEnforcement) {
    // Evidence already recorded in enforceStandardStrictGate
  }

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

async function handleReviewerFailure(
  ctx: PipelineContext,
  obligationType: string,
  strictEnforcement: boolean,
): Promise<void> {
  const { deps, sessDir, sessionId, reviewCtx, parsedOutput, sessionState, output } = ctx;
  const phase = String(parsedOutput.phase ?? sessionState.phase);
  const toolName = ctx.deps === deps ? 'unknown' : 'unknown'; // just for log below
  void toolName;

  deps.log.warn('orchestrator', 'reviewer invocation failed (fallback to LLM-driven)', {
    tool: obligationType,
    sessionId,
  });

  if (strictEnforcement) {
    await deps.blockReviewOutcome(
      { sessDir, sessionId, phase },
      reviewCtx.obligationId,
      'STRICT_REVIEW_ORCHESTRATION_FAILED',
      { reason: 'reviewer invocation failed' },
      output,
    );
  } else {
    // Non-strict: block the obligation to prevent infinite re-invocation.
    await recordAssuranceWithAudit(
      {
        updateReviewAssurance: (sessDir, update, semanticIntents) =>
          deps.updateReviewAssurance(sessDir, update, semanticIntents),
      },
      {
        sessDir,
        stateMutation: (s) =>
          updateObligation(s, reviewCtx.obligationId, (item) => ({
            ...item,
            status: 'blocked' as const,
            blockedCode: 'REVIEWER_INVOCATION_EXHAUSTED',
          })),
        auditEventName: 'review:obligation_blocked',
        auditDetail: {
          obligationId: reviewCtx.obligationId,
          code: 'REVIEWER_INVOCATION_EXHAUSTED',
        },
      },
    );
  }
}
