/**
 * @module integration/review/content-review-pipeline
 * @description Content review pipeline for flowguard_review tool invocations.
 *
 * Resolves persisted review material, builds a review prompt, invokes the reviewer
 * subagent, validates findings, and enforces strict gates.
 */

import { ReviewFindings as ReviewFindingsSchema } from '../../state/evidence.js';
import { prepareReviewerFindingsForValidation } from './enforcement/prepare-findings.js';
import type { RepositoryDiscoverySnapshot } from '../../state/evidence.js';
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
  latestReviewMaterial,
  hasEvidenceReuse,
  buildInvocationEvidence,
  appendInvocationEvidence,
  isCurrentReviewGeneration,
  updateAttemptStatus,
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
} from './shared-helpers.js';
import {
  verifyFrozenMaterialForObligation,
  type FrozenReviewerContext,
} from './frozen-reviewer-context.js';

// ─── Review Content Pipeline ─────────────────────────────────────────────────

function countFindings(findings: unknown): number {
  return Array.isArray(findings) ? findings.length : Object.keys(findings ?? {}).length;
}

type PersistedReviewObligation = NonNullable<ReturnType<typeof findReviewObligationById>>;

function matchesActiveReviewGeneration(
  obligation: ReturnType<typeof findReviewObligationById>,
  reviewCtx: PipelineContext['reviewCtx'],
): obligation is PersistedReviewObligation {
  return (
    obligation !== null &&
    isCurrentReviewGeneration(obligation) &&
    obligation.criteriaVersion === reviewCtx.criteriaVersion &&
    obligation.mandateDigest === reviewCtx.mandateDigest
  );
}

/**
 * Resolve the frozen material for the active review obligation.
 *
 * A missing bindable attempt and invalid material are reported under DIFFERENT
 * reason codes on purpose: the first is recovered by re-running the review call
 * (which reissues an attempt), the second forbids re-running the reviewer at
 * all. Collapsing both into an integrity failure sent the agent down a restore
 * path that cannot resolve a merely spent attempt.
 */
async function loadPersistedContentForReview(ctx: PipelineContext): Promise<{
  content: string;
  frozenReviewerContext: FrozenReviewerContext;
  repositoryDiscoverySnapshot: RepositoryDiscoverySnapshot | null;
  attemptId: string;
} | null> {
  const { deps, reviewCtx } = ctx;
  const assurance = ensureReviewAssurance(ctx.sessionState.reviewAssurance);
  const obligation = findReviewObligationById(assurance, reviewCtx.obligationId);
  if (!matchesActiveReviewGeneration(obligation, reviewCtx)) {
    await blockReviewOutcomeHelper(deps, ctx, 'REVIEW_GENERATION_MISMATCH', {
      obligationId: reviewCtx.obligationId,
      reason: 'review obligation generation is stale or does not match the emitted review context',
    });
    return null;
  }
  const attempt = findBindableAttempt(ctx.sessionState.reviewAssurance, reviewCtx.obligationId);
  const material = attempt?.reviewMaterial;
  if (!attempt || !material || attempt.subjectDigest !== obligation?.subjectDigest) {
    const persisted = latestReviewMaterial(assurance, reviewCtx.obligationId);
    const materialCheck = verifyFrozenMaterialForObligation(obligation, persisted);
    await blockReviewOutcomeHelper(
      deps,
      ctx,
      materialCheck.kind === 'blocked'
        ? 'REVIEW_MATERIAL_INTEGRITY_FAILED'
        : 'REVIEW_ATTEMPT_UNAVAILABLE',
      {
        obligationId: reviewCtx.obligationId,
        reason:
          materialCheck.kind === 'blocked'
            ? materialCheck.reason
            : 'bindable attempt is missing or does not match the frozen obligation subject',
      },
    );
    return null;
  }
  const verification = verifyFrozenMaterialForObligation(obligation, material);
  if (verification.kind === 'blocked') {
    await blockReviewOutcomeHelper(deps, ctx, verification.code, {
      obligationId: reviewCtx.obligationId,
      reason: verification.reason,
    });
    return null;
  }
  if (!verification.context) {
    await blockReviewOutcomeHelper(deps, ctx, 'REVIEW_MATERIAL_INTEGRITY_FAILED', {
      obligationId: reviewCtx.obligationId,
      reason: 'frozen reviewer context missing after successful material verification',
    });
    return null;
  }
  return {
    content: material.content,
    frozenReviewerContext: verification.context,
    repositoryDiscoverySnapshot:
      attempt.repositoryDiscovery.kind === 'repository'
        ? attempt.repositoryDiscovery.snapshot
        : null,
    attemptId: attempt.attemptId,
  };
}

async function validateContentFindings(
  ctx: PipelineContext,
  reviewerResult: ReviewerSuccessResult,
  prompt: string,
  strictEnforcement: boolean,
  attemptId: string,
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

  const prepared = prepareReviewerFindingsForValidation({
    rawFindings: reviewerResult.findings,
    obligationId: reviewCtx.obligationId,
    hostConstants: {
      mandateDigest: reviewCtx.mandateDigest,
      criteriaVersion: reviewCtx.criteriaVersion,
    },
    hostProvenance: {
      childSessionId: reviewerResult.sessionId,
      reviewedAt: reviewerResult.fulfilledAt ?? ctx.now,
    },
  });
  const parsedFindings = prepared.ok
    ? ReviewFindingsSchema.safeParse(prepared.findings)
    : { success: false as const };
  if (!parsedFindings.success) {
    if (strictEnforcement) {
      await blockReviewOutcomeHelper(deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
        obligationId: reviewCtx.obligationId,
        reason: 'reviewer response did not match ReviewFindings schema',
      });
    }
    return false;
  }
  if (!prepared.ok) return false;
  const canonicalReviewerResult = { ...reviewerResult, findings: prepared.findings };

  if (strictEnforcement) {
    const narrowed = canonicalReviewerResult as ReviewerSuccessResult & {
      findings: Record<string, unknown>;
    };
    const blocked = await enforceContentStrictGate(
      ctx,
      narrowed,
      parsedFindings.data,
      prompt,
      attemptId,
    );
    if (blocked) return false;
  }

  const mutated = buildReviewContentMutatedOutput(rawOutput, canonicalReviewerResult);
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
    repositoryDiscoverySnapshot: persistedContent.repositoryDiscoverySnapshot,
    proofGraph: sessionState.proofGraph,
    frozenReviewerContext: persistedContent.frozenReviewerContext,
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

  await validateContentFindings(
    ctx,
    reviewerResult,
    prompt,
    strictEnforcement,
    persistedContent.attemptId,
  );
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
  attemptId: string,
): Promise<boolean> {
  const { deps, reviewCtx } = ctx;

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

  return persistStrictReviewInvocation(ctx, reviewerResult, prompt, attemptId);
}

function buildContentReviewInvocation(
  ctx: PipelineContext,
  reviewerResult: ReviewerSuccessResult & { findings: Record<string, unknown> },
  promptHash: string,
  findingsHash: string,
  attemptId: string,
): ReturnType<typeof buildInvocationEvidence> {
  const { reviewCtx, sessionId, now } = ctx;
  return buildInvocationEvidence({
    obligationId: reviewCtx.obligationId,
    obligationType: 'review',
    mandateDigest: reviewCtx.mandateDigest,
    criteriaVersion: reviewCtx.criteriaVersion,
    parentSessionId: sessionId,
    childSessionId: reviewerResult.sessionId,
    invocationMode: INVOCATION_MODE_SDK_SESSION,
    hostVisible: false,
    promptHash,
    findingsHash,
    invokedAt: reviewerResult.invokedAt ?? now,
    fulfilledAt: reviewerResult.fulfilledAt ?? now,
    attemptId,
    source: EVIDENCE_SOURCE_HOST,
    reviewOutputMode: reviewerResult.reviewOutputMode,
    structuredOutputUsed: reviewerResult.structuredOutputUsed,
    reviewAssuranceLevel: reviewerResult.reviewAssuranceLevel,
    extractionMethod: reviewerResult.extractionMethod,
    modelCapabilityError: reviewerResult.modelCapabilityError,
  });
}

function applyContentEvidenceResult(
  ctx: PipelineContext,
  reused: boolean,
  lineageUnavailable: boolean,
): boolean {
  if (lineageUnavailable) {
    ctx.output.output = strictBlockedOutput('REVIEW_ATTEMPT_UNAVAILABLE', {
      obligationId: ctx.reviewCtx.obligationId,
      reason: 'SDK review evidence could not bind to the pre-authorized review attempt',
    });
    return true;
  }
  if (reused) {
    ctx.output.output = strictBlockedOutput('SUBAGENT_EVIDENCE_REUSED', {
      obligationId: ctx.reviewCtx.obligationId,
      reason: 'subagent findings already used for a prior obligation',
    });
    return true;
  }
  return false;
}

async function persistStrictReviewInvocation(
  ctx: PipelineContext,
  reviewerResult: ReviewerSuccessResult & { findings: Record<string, unknown> },
  prompt: string,
  attemptId: string,
): Promise<boolean> {
  const { deps, sessDir, reviewCtx, now } = ctx;
  const promptHash = hashText(prompt);
  const findingsHash = hashFindings(reviewerResult.findings);

  const invocation = buildContentReviewInvocation(
    ctx,
    reviewerResult,
    promptHash,
    findingsHash,
    attemptId,
  );

  // Atomically check evidence reuse AND record invocation in a single
  // updateReviewAssurance transaction. Reading the freshest assurance state
  // (`s`) inside the mutation closure closes the TOCTOU window between a
  // stale in-memory reuse check and a later append.
  let reused = false;
  let lineageUnavailable = false;
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
    const obligation = assurance.obligations.find(
      (item) => item.obligationId === reviewCtx.obligationId,
    );
    const attempt = assurance.attempts.find((item) => item.attemptId === attemptId);
    if (
      !obligation ||
      !attempt ||
      attempt.obligationId !== obligation.obligationId ||
      attempt.obligationType !== obligation.obligationType ||
      attempt.subjectDigest !== obligation.subjectDigest ||
      attempt.status !== 'created' ||
      attempt.childSessionId !== undefined
    ) {
      lineageUnavailable = true;
      return s;
    }
    const boundAssurance = updateAttemptStatus(
      assurance,
      attemptId,
      'bound',
      reviewerResult.fulfilledAt ?? now,
      { childSessionId: reviewerResult.sessionId },
    );
    const updated = updateObligation(
      { ...s, reviewAssurance: boundAssurance },
      reviewCtx.obligationId,
      (item) => ({
        ...item,
        pluginHandshakeAt: now,
        status: 'fulfilled',
        invocationId: invocation.invocationId,
        fulfilledAt: reviewerResult.fulfilledAt ?? now,
      }),
    );
    return {
      ...updated,
      reviewAssurance: appendInvocationEvidence(
        ensureReviewAssurance(updated.reviewAssurance),
        invocation,
      ),
    };
  });

  return applyContentEvidenceResult(ctx, reused, lineageUnavailable);
}
