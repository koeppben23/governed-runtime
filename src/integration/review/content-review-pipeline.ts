/**
 * @module integration/review/content-review-pipeline
 * @description Content review pipeline for flowguard_review tool invocations.
 *
 * Resolves persisted review material, builds a review prompt, invokes the reviewer
 * subagent, validates findings, and enforces strict gates.
 */

import { ReviewFindings as ReviewFindingsSchema } from '../../state/evidence.js';
import { buildReviewContentPrompt, selectReviewerProfileRules } from './prompt-builders.js';
import { buildReviewContentMutatedOutput, type ReviewerSuccessResult } from './orchestrator.js';
import { strictBlockedOutput } from '../plugin-helpers.js';
import { TOOL_FLOWGUARD_REVIEW } from '../tool-names.js';
import { REASON_HOST_SUBAGENT_TASK_REQUIRED } from '../../shared/flowguard-identifiers.js';
import {
  hashText,
  hashFindings,
  ensureReviewAssurance,
  findReviewObligationById,
  findBindableAttempt,
  hasEvidenceReuse,
  buildInvocationEvidence,
  appendInvocationEvidence,
} from './assurance.js';
import { updateObligation } from './obligation-state.js';
import type { PipelineContext } from './pipeline-types.js';
import { INVOCATION_MODE_SDK_SESSION, EVIDENCE_SOURCE_HOST } from './pipeline-types.js';
import {
  validatePipelineAttestation,
  blockReviewOutcomeHelper,
  isStrictEnforcementEnabled,
  getReviewerPolicies,
  buildAttemptFailedLogger,
  buildAttemptSucceededLogger,
  buildReviewDiscoveryContextForPipeline,
} from './shared-helpers.js';

// ─── Review Content Pipeline ─────────────────────────────────────────────────

function countFindings(findings: unknown): number {
  return Array.isArray(findings) ? findings.length : Object.keys(findings ?? {}).length;
}

async function loadPersistedContentForReview(
  ctx: PipelineContext,
): Promise<{ content: string } | null> {
  const { deps, reviewCtx } = ctx;
  const obligation = findReviewObligationById(
    ensureReviewAssurance(ctx.sessionState.reviewAssurance),
    reviewCtx.obligationId,
  );
  const attempt = findBindableAttempt(ctx.sessionState.reviewAssurance, reviewCtx.obligationId);
  const material = attempt?.reviewMaterial;
  if (
    !obligation?.reviewSubject ||
    !attempt ||
    !material ||
    attempt.subjectDigest !== obligation.subjectDigest ||
    material.materialDigest !== obligation.reviewSubject.materialDigest
  ) {
    await blockReviewOutcomeHelper(deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
      obligationId: reviewCtx.obligationId,
      reason:
        'persisted review obligation, bindable attempt, or material binding is missing or mismatched',
    });
    return null;
  }
  return { content: material.content };
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

export async function runReviewContentPipeline(ctx: PipelineContext): Promise<void> {
  const { deps, sessionState, reviewCtx, output, sessionId } = ctx;
  deps.log.info('review', 'content_review_started', { sessionId });
  const strictEnforcement = isStrictEnforcementEnabled(sessionState);

  const persistedContent = await loadPersistedContentForReview(ctx);
  if (!persistedContent) return;

  const { profileName, profileRules } = selectReviewerProfileRules(
    sessionState.activeProfile,
    'REVIEW',
  );
  const ticketText = sessionState.ticket?.text ?? '';
  const discoveryContext = await buildReviewDiscoveryContextForPipeline(ctx);
  const prompt = buildReviewContentPrompt({
    content: persistedContent.content,
    ticketText,
    obligationId: reviewCtx.obligationId,
    mandateDigest: reviewCtx.mandateDigest,
    criteriaVersion: reviewCtx.criteriaVersion,
    iteration: reviewCtx.iteration,
    planVersion: reviewCtx.planVersion,
    profileName,
    profileRules,
    discoveryContext,
    proofGraph: sessionState.proofGraph,
  });

  const policies = getReviewerPolicies(sessionState);
  const reviewerResult = await deps.adapter.spawnReviewer({
    prompt,
    parentSessionId: sessionId,
    reviewOutputPolicy: policies.reviewOutputPolicy,
    reviewInvocationPolicy: policies.reviewInvocationPolicy,
    onAttemptFailed: buildAttemptFailedLogger(deps, TOOL_FLOWGUARD_REVIEW, sessionId),
    onAttemptSucceeded: buildAttemptSucceededLogger(deps, TOOL_FLOWGUARD_REVIEW),
  });

  if (reviewerResult?.blocked) {
    const code = reviewerResult.code ?? REASON_HOST_SUBAGENT_TASK_REQUIRED;
    const reason = reviewerResult.reason ?? 'review invocation blocked by policy';
    deps.log.warn('review', 'content_review_blocked', { sessionId, code });
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
  deps.log.info('review', 'content_review_completed', {
    sessionId,
    findingCount: countFindings(reviewerResult.findings),
  });
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
  const { deps, sessDir, reviewCtx, output, sessionId, now } = ctx;

  const attestation = validatePipelineAttestation(findings, {
    obligationId: reviewCtx.obligationId,
    criteriaVersion: reviewCtx.criteriaVersion,
    mandateDigest: reviewCtx.mandateDigest,
    iteration: reviewCtx.iteration,
    planVersion: reviewCtx.planVersion,
    checkReviewedBy: true,
    checkUnableToReview: true,
  });

  if (!attestation.valid) {
    await blockReviewOutcomeHelper(deps, ctx, attestation.code, attestation.detail);
    return true;
  }

  const promptHash = hashText(prompt);
  const findingsHash = hashFindings(reviewerResult.findings);

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

  // Atomically check evidence reuse AND record invocation in a single
  // updateReviewAssurance transaction. Reading the freshest assurance state
  // (`s`) inside the mutation closure closes the TOCTOU window between a
  // stale in-memory reuse check and a later append.
  let reused = false;
  await deps.updateReviewAssurance(sessDir, (s) => {
    const assurance = ensureReviewAssurance(s.reviewAssurance);
    if (hasEvidenceReuse(assurance.invocations, reviewerResult.sessionId, findingsHash)) {
      reused = true;
      return updateObligation(s, reviewCtx.obligationId, (item) => ({
        ...item,
        status: 'blocked',
        blockedCode: 'SUBAGENT_EVIDENCE_REUSED',
      }));
    }
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

  if (reused) {
    output.output = strictBlockedOutput('SUBAGENT_EVIDENCE_REUSED', {
      obligationId: reviewCtx.obligationId,
      reason: 'subagent findings already used for a prior obligation',
    });
    return true;
  }

  return false;
}
