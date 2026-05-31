/**
 * @module integration/review/content-review-pipeline
 * @description Content review pipeline for flowguard_review tool invocations.
 *
 * Loads external content, builds a review prompt, invokes the reviewer
 * subagent, validates findings, and enforces strict gates.
 */

import { ReviewFindings as ReviewFindingsSchema } from '../../state/evidence.js';
import { buildReviewContentPrompt, selectReviewerProfileRules } from './prompt-builders.js';
import { buildReviewContentMutatedOutput, type ReviewerSuccessResult } from './orchestrator.js';
import { strictBlockedOutput } from '../plugin-helpers.js';
import { loadExternalContent } from '../../rails/review.js';
import { TOOL_FLOWGUARD_REVIEW } from '../tool-names.js';
import { REASON_HOST_SUBAGENT_TASK_REQUIRED } from '../../shared/flowguard-identifiers.js';
import {
  hashText,
  hashFindings,
  ensureReviewAssurance,
  hasEvidenceReuse,
  buildInvocationEvidence,
  appendInvocationEvidence,
} from './assurance.js';
import { updateObligation } from './obligation-state.js';
import type { PipelineContext } from './pipeline-types.js';
import { INVOCATION_MODE_SDK_SESSION, EVIDENCE_SOURCE_HOST } from './pipeline-types.js';
import {
  validateStrictAttestation,
  blockReviewOutcomeHelper,
  isStrictEnforcementEnabled,
  getReviewerPolicies,
  buildAttemptFailedLogger,
  buildReviewDiscoveryContextForPipeline,
} from './shared-helpers.js';

// ─── Review Content Pipeline ─────────────────────────────────────────────────

async function loadContentForReview(
  ctx: PipelineContext,
  input: unknown,
  strictEnforcement: boolean,
): Promise<string | null> {
  const { deps, reviewCtx } = ctx;
  const refInput = extractContentRefInput(input);
  const contentResult = await loadExternalContent(refInput);
  const hasContent = 'content' in contentResult && typeof contentResult.content === 'string';
  if (!hasContent) {
    if (strictEnforcement) {
      await blockReviewOutcomeHelper(deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
        obligationId: reviewCtx.obligationId,
        reason: 'external review content could not be loaded',
      });
    }
    return null;
  }
  return contentResult.content;
}

async function validateContentFindings(
  ctx: PipelineContext,
  reviewerResult: ReviewerSuccessResult,
  prompt: string,
  strictEnforcement: boolean,
): Promise<boolean> {
  const { deps, reviewCtx, output, rawOutput } = ctx;

  if (!reviewerResult.findings) {
    if (strictEnforcement) {
      await blockReviewOutcomeHelper(deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
        obligationId: reviewCtx.obligationId,
        reason: 'reviewer response was not parseable as ReviewFindings',
      });
    }
    return false;
  }

  const parsedFindings = ReviewFindingsSchema.safeParse(reviewerResult.findings);
  if (!parsedFindings.success) {
    if (strictEnforcement) {
      await blockReviewOutcomeHelper(deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
        obligationId: reviewCtx.obligationId,
        reason: 'reviewer response did not match ReviewFindings schema',
      });
    }
    return false;
  }

  if (strictEnforcement) {
    const narrowed = reviewerResult as ReviewerSuccessResult & {
      findings: Record<string, unknown>;
    };
    const blocked = await enforceContentStrictGate(ctx, narrowed, parsedFindings.data, prompt);
    if (blocked) return false;
  }

  const mutated = buildReviewContentMutatedOutput(rawOutput, reviewerResult);
  if (mutated) output.output = mutated;
  return true;
}

export async function runReviewContentPipeline(
  ctx: PipelineContext,
  input: unknown,
): Promise<void> {
  const { deps, sessionState, reviewCtx, output, sessionId } = ctx;
  const strictEnforcement = isStrictEnforcementEnabled(sessionState);

  const content = await loadContentForReview(ctx, input, strictEnforcement);
  if (!content) return;

  const { profileName, profileRules } = selectReviewerProfileRules(
    sessionState.activeProfile,
    'REVIEW',
  );
  const ticketText = sessionState.ticket?.text ?? '';
  const discoveryContext = await buildReviewDiscoveryContextForPipeline(ctx);
  const prompt = buildReviewContentPrompt({
    content,
    ticketText,
    obligationId: reviewCtx.obligationId,
    mandateDigest: reviewCtx.mandateDigest,
    criteriaVersion: reviewCtx.criteriaVersion,
    iteration: reviewCtx.iteration,
    planVersion: reviewCtx.planVersion,
    profileName,
    profileRules,
    discoveryContext,
  });

  const policies = getReviewerPolicies(sessionState);
  const reviewerResult = await deps.adapter.spawnReviewer({
    prompt,
    parentSessionId: sessionId,
    reviewOutputPolicy: policies.reviewOutputPolicy,
    reviewInvocationPolicy: policies.reviewInvocationPolicy,
    onAttemptFailed: buildAttemptFailedLogger(deps, TOOL_FLOWGUARD_REVIEW, sessionId),
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

  if (!reviewerResult || reviewerResult.blocked) {
    if (strictEnforcement) {
      await blockReviewOutcomeHelper(deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
        obligationId: reviewCtx.obligationId,
        reason: 'reviewer response was not parseable as ReviewFindings',
      });
    }
    return;
  }

  await validateContentFindings(ctx, reviewerResult, prompt, strictEnforcement);
}

function extractContentRefInput(input: unknown): {
  text?: string;
  prNumber?: number;
  branch?: string;
  url?: string;
} {
  const wrappedArgs = (input as { args?: unknown })?.args;
  const rawInput =
    wrappedArgs && typeof wrappedArgs === 'object' && !Array.isArray(wrappedArgs)
      ? (wrappedArgs as Record<string, unknown>)
      : (input as Record<string, unknown>);
  return {
    text: typeof rawInput.text === 'string' ? rawInput.text : undefined,
    prNumber: typeof rawInput.prNumber === 'number' ? rawInput.prNumber : undefined,
    branch: typeof rawInput.branch === 'string' ? rawInput.branch : undefined,
    url: typeof rawInput.url === 'string' ? rawInput.url : undefined,
  };
}

async function enforceContentStrictGate(
  ctx: PipelineContext,
  reviewerResult: ReviewerSuccessResult & { findings: Record<string, unknown> },
  findings: {
    reviewMode?: string;
    attestation?: Record<string, unknown> | null;
    overallVerdict?: string;
  },
  prompt: string,
): Promise<boolean> {
  const { deps, sessDir, reviewCtx, sessionState, output, sessionId, now } = ctx;

  const attestation = validateStrictAttestation(findings, {
    obligationId: reviewCtx.obligationId,
    criteriaVersion: reviewCtx.criteriaVersion,
    mandateDigest: reviewCtx.mandateDigest,
    iteration: reviewCtx.iteration,
    planVersion: reviewCtx.planVersion,
    checkReviewedBy: true,
    checkUnableToReview: false,
  });

  if (!attestation.valid) {
    await blockReviewOutcomeHelper(deps, ctx, attestation.code, attestation.detail);
    return true;
  }

  const promptHash = hashText(prompt);
  const findingsHash = hashFindings(reviewerResult.findings);

  // Check reuse before creating evidence.
  const currentAssurance = ensureReviewAssurance(sessionState.reviewAssurance);
  if (hasEvidenceReuse(currentAssurance.invocations, reviewerResult.sessionId, findingsHash)) {
    await deps.updateReviewAssurance(sessDir, (s) =>
      updateObligation(s, reviewCtx.obligationId, (item) => ({
        ...item,
        status: 'blocked',
        blockedCode: 'SUBAGENT_EVIDENCE_REUSED',
      })),
    );
    output.output = strictBlockedOutput('SUBAGENT_EVIDENCE_REUSED', {
      obligationId: reviewCtx.obligationId,
      reason: 'subagent findings already used for a prior obligation',
    });
    return true;
  }

  // Atomically fulfill the obligation and append invocation evidence.
  const invocation = buildInvocationEvidence({
    obligationId: reviewCtx.obligationId,
    obligationType: 'review',
    parentSessionId: sessionId,
    childSessionId: reviewerResult.sessionId,
    invocationMode: INVOCATION_MODE_SDK_SESSION,
    hostVisible: false,
    promptHash,
    findingsHash,
    invokedAt: now,
    fulfilledAt: now,
    source: EVIDENCE_SOURCE_HOST,
    reviewOutputMode: reviewerResult.reviewOutputMode,
    structuredOutputUsed: reviewerResult.structuredOutputUsed,
    reviewAssuranceLevel: reviewerResult.reviewAssuranceLevel,
    extractionMethod: reviewerResult.extractionMethod,
    modelCapabilityError: reviewerResult.modelCapabilityError,
  });
  await deps.updateReviewAssurance(sessDir, (s) => {
    const updated = updateObligation(s, reviewCtx.obligationId, (item) => ({
      ...item,
      pluginHandshakeAt: now,
      status: 'fulfilled',
      invocationId: invocation.invocationId,
      fulfilledAt: now,
    }));
    return {
      ...updated,
      reviewAssurance: appendInvocationEvidence(
        ensureReviewAssurance(updated.reviewAssurance),
        invocation,
      ),
    };
  });

  return false;
}
