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
import type { CapturedFindings } from './enforcement/types.js';
import { recordPluginReview } from './enforcement/enforcement.js';
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
import { appendReviewAuditEvent } from './audit-events.js';
import { recordAssuranceWithAudit } from './shared-helpers.js';
import { REVIEWER_SUBAGENT_TYPE } from './enforcement/types.js';
import { REASON_HOST_SUBAGENT_TASK_REQUIRED } from '../../shared/flowguard-identifiers.js';
import type { PipelineContext } from './pipeline-types.js';
import type { EvidenceRecordResult } from './pipeline-types.js';
import {
  validateStrictAttestation,
  recordEvidenceOrBlockReuse,
  blockReviewOutcomeHelper,
  isStrictEnforcementEnabled,
  getReviewerPolicies,
  isOutputAlreadyBlocked,
  buildToolPrompt,
  buildAttemptFailedLogger,
} from './shared-helpers.js';

// ─── Standard Review Pipeline ────────────────────────────────────────────────

export async function runStandardReviewPipeline(
  ctx: PipelineContext,
  toolName: string,
  input: unknown,
): Promise<void> {
  const { deps, sessionState, sessDir, reviewCtx, output, sessionId } = ctx;

  const obligationType = obligationTypeForTool(toolName);
  if (!obligationType) {
    output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      reason: `unsupported reviewable tool for review orchestration: ${toolName}`,
    });
    deps.log.warn('orchestrator', 'unsupported reviewable tool — blocked', { tool: toolName });
    return;
  }

  const strictEnforcement = isStrictEnforcementEnabled(sessionState);

  const assuranceResult = await recordAssuranceWithAudit(
    {
      updateReviewAssurance: (sessDir, update) => deps.updateReviewAssurance(sessDir, update),
      appendReviewAuditEvent: (sessDir, sessionId, phase, event, detail) =>
        appendReviewAuditEvent(sessDir, sessionId, phase, event, detail),
      logError: (msg, err) => deps.log.warn('orchestrator', msg, { error: String(err) }),
    },
    sessDir,
    sessionId,
    String(ctx.parsedOutput.phase ?? sessionState.phase),
    (s, now2) =>
      updateObligation(s, reviewCtx.obligationId, (item) => ({
        ...item,
        pluginHandshakeAt: now2,
      })),
    'review:obligation_created',
    {
      obligationId: reviewCtx.obligationId,
      obligationType,
      iteration: reviewCtx.iteration,
      planVersion: reviewCtx.planVersion,
      criteriaVersion: reviewCtx.criteriaVersion,
      mandateDigest: reviewCtx.mandateDigest,
    },
    strictEnforcement ? 'block' : 'warn',
  );

  if (!assuranceResult.auditOk && assuranceResult.block) {
    output.output = strictBlockedOutput('AUDIT_PERSISTENCE_FAILED', {
      reason: assuranceResult.reason ?? 'audit write failed',
    });
    return;
  }

  const prompt = buildStandardPromptAndLog(ctx, toolName, input);
  if (!prompt) return;

  const policies = getReviewerPolicies(sessionState);
  const reviewerResult = await deps.adapter.spawnReviewer({
    prompt,
    parentSessionId: sessionId,
    reviewOutputPolicy: policies.reviewOutputPolicy,
    reviewInvocationPolicy: policies.reviewInvocationPolicy,
    onAttemptFailed: buildAttemptFailedLogger(deps, toolName, sessionId),
  });

  if (reviewerResult?.blocked) {
    const code = reviewerResult.code ?? REASON_HOST_SUBAGENT_TASK_REQUIRED;
    const reason = reviewerResult.reason ?? 'review invocation blocked by policy';
    output.output = strictBlockedOutput(code, {
      reason,
      reviewInvocation: JSON.stringify(reviewerResult.reviewInvocation ?? {}),
    });
    return;
  }

  if (reviewerResult && !reviewerResult.blocked) {
    await handleReviewerSuccess(ctx, {
      toolName,
      reviewerResult,
      prompt,
      obligationType,
      strictEnforcement,
    });
  } else {
    await handleReviewerFailure(ctx, obligationType, strictEnforcement);
  }
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

function buildStandardPromptAndLog(
  ctx: PipelineContext,
  toolName: string,
  input: unknown,
): string | null {
  const { deps, sessionState, reviewCtx, parsedOutput, sessionId } = ctx;
  const ticketText = sessionState.ticket?.text ?? '';
  const planText = sessionState.plan?.current?.body ?? '';
  const adrText = sessionState.architecture?.adrText ?? '';
  const adrTitle = sessionState.architecture?.title ?? '';
  const toolArgs = getToolArgs(input);

  const planRules = selectReviewerProfileRules(sessionState.activeProfile, 'PLAN_REVIEW');
  const implRules = selectReviewerProfileRules(sessionState.activeProfile, 'IMPL_REVIEW');
  const archRules = selectReviewerProfileRules(sessionState.activeProfile, 'ARCH_REVIEW');

  const prompt = buildToolPrompt({
    toolName,
    texts: { planText, ticketText, adrText, adrTitle },
    reviewCtx,
    parsedOutput,
    sessionState,
    rules: { planRules, implRules, archRules },
    deps,
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
    return;
  }

  const parsedFindings = ReviewFindingsSchema.safeParse(reviewerResult.findings);
  if (!parsedFindings.success && strictEnforcement) {
    await blockReviewOutcomeHelper(deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
      reason: 'reviewer response did not match ReviewFindings schema',
    });
  }

  if (strictEnforcement && parsedFindings.success) {
    // parsedFindings.success guarantees reviewerResult.findings is non-null
    const narrowed = reviewerResult as ReviewerSuccessResult & {
      findings: Record<string, unknown>;
    };
    const gateBlocked = await enforceStandardStrictGate(
      ctx,
      narrowed,
      parsedFindings.data,
      prompt,
      obligationType,
    );
    if (gateBlocked) return;
  }

  if (strictEnforcement && isOutputAlreadyBlocked(output)) return;

  const mutated = buildMutatedOutput(rawOutput, reviewerResult);
  if (mutated) {
    // buildMutatedOutput returns non-null only when findings is non-null
    const narrowed = reviewerResult as ReviewerSuccessResult & {
      findings: Record<string, unknown>;
    };
    await finalizeReviewOutput(ctx, {
      toolName,
      reviewerResult: narrowed,
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

  const attestation = validateStrictAttestation(findings, {
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
    return false; // gate blocked output but don't short-circuit — let strictGateResult check handle it
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
  });

  try {
    await emitStandardEvidenceAudit(ctx, {
      result,
      obligationType,
      promptHash,
      findingsHash,
      reviewerResult,
    });
  } catch (err) {
    deps.log.warn('orchestrator', 'Proof persistence failure: audit write failed', {
      error: String(err),
    });
    output.output = strictBlockedOutput('AUDIT_PERSISTENCE_FAILED', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return true;
  }

  if (result === 'reused') {
    output.output = strictBlockedOutput('SUBAGENT_EVIDENCE_REUSED', {
      obligationId: reviewCtx.obligationId,
    });
    return true;
  }

  return false;
}

interface EvidenceAuditOpts {
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
}

async function emitStandardEvidenceAudit(
  ctx: PipelineContext,
  opts: EvidenceAuditOpts,
): Promise<void> {
  const { result, obligationType, promptHash, findingsHash, reviewerResult } = opts;
  const { sessDir, sessionId, parsedOutput, sessionState, reviewCtx } = ctx;
  const phase = String(parsedOutput.phase ?? sessionState.phase);

  await appendReviewAuditEvent(
    sessDir,
    sessionId,
    phase,
    result === 'reused' ? 'review:obligation_blocked' : 'review:subagent_invoked',
    result === 'reused'
      ? {
          obligationId: reviewCtx.obligationId,
          code: 'SUBAGENT_EVIDENCE_REUSED',
        }
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
          ...(reviewerResult.extractionMethod
            ? { extractionMethod: reviewerResult.extractionMethod }
            : {}),
          ...(reviewerResult.modelCapabilityError
            ? { modelCapabilityError: reviewerResult.modelCapabilityError }
            : {}),
        },
  );

  if (result === 'fulfilled') {
    await appendReviewAuditEvent(sessDir, sessionId, phase, 'review:obligation_fulfilled', {
      obligationId: reviewCtx.obligationId,
      childSessionId: reviewerResult.sessionId,
    });
  }
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
        updateReviewAssurance: (sessDir, update) => deps.updateReviewAssurance(sessDir, update),
        appendReviewAuditEvent: (sessDir, sessionId, phase, event, detail) =>
          appendReviewAuditEvent(sessDir, sessionId, phase, event, detail),
        logError: (msg, err) => deps.log.warn('orchestrator', msg, { error: String(err) }),
      },
      sessDir,
      sessionId,
      phase,
      (s) =>
        updateObligation(s, reviewCtx.obligationId, (item) => ({
          ...item,
          status: 'blocked' as const,
          blockedCode: 'REVIEWER_INVOCATION_EXHAUSTED',
        })),
      'review:obligation_blocked',
      {
        obligationId: reviewCtx.obligationId,
        code: 'REVIEWER_INVOCATION_EXHAUSTED',
      },
      'warn',
    );
  }
}
