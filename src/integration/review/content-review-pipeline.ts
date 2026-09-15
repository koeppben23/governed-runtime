/**
 * @module integration/review/content-review-pipeline
 * @description Content review pipeline for flowguard_review tool invocations.
 *
 * Resolves persisted review material, builds a review prompt, invokes the reviewer
 * subagent, validates findings, and enforces review gates.
 */

import { ReviewFindings as ReviewFindingsSchema } from '../../state/evidence.js';
import { prepareReviewerFindingsForValidation } from './enforcement/prepare-findings.js';
import type { RepositoryDiscoverySnapshot } from '../../state/evidence.js';
import { buildReviewContentPrompt, selectReviewerProfileRules } from './prompt-builders.js';
import { buildReviewContentMutatedOutput, type ReviewerSuccessResult } from './orchestrator.js';
import { strictBlockedOutput } from '../plugin-helpers.js';
import { TOOL_FLOWGUARD_REVIEW } from '../tool-names.js';
import {
  hashText,
  hashFindings,
  ensureReviewAssurance,
  findReviewObligationById,
  findBindableAttempt,
  hasEvidenceReuse,
  buildInvocationEvidence,
  appendInvocationEvidence,
  isCurrentReviewGeneration,
  updateAttemptStatus,
} from './assurance.js';
import { updateObligation } from './obligation-state.js';
import { buildSdkEvidenceAuditIntents } from './sdk-evidence-recorder.js';
import { persistAuthorizedSdkDispatch, abandonSdkDispatch } from '../durable-dispatch.js';
import { completeReviewDispatch, hasUnresolvedDispatch } from '../../state/review-continuation.js';
import { hasAuthorizedDispatch } from '../../state/review-dispatch.js';
import type { PipelineContext } from './pipeline-types.js';
import {
  validatePipelineAttestation,
  blockReviewOutcomeHelper,
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
 * A prior host call with an unresolved durable dispatch must never be
 * re-released on the same attempt (crash/restart replay). Returns true when
 * the invocation was blocked.
 */
async function blockInterruptedDispatch(
  deps: PipelineContext['deps'],
  ctx: PipelineContext,
  attempt: ReturnType<typeof findBindableAttempt>,
): Promise<boolean> {
  if (!attempt) return false;
  if (!hasUnresolvedDispatch(ctx.sessionState.reviewAssurance, attempt.attemptId)) return false;
  await blockReviewOutcomeHelper(deps, ctx, 'REVIEW_ATTEMPT_UNAVAILABLE', {
    obligationId: ctx.reviewCtx.obligationId,
    reason:
      'the pre-authorized reviewer attempt has an unresolved dispatch; re-run the originating command to re-arm a fresh reviewer attempt',
  });
  return true;
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
  const material = obligation?.reviewMaterial;
  if (await blockInterruptedDispatch(deps, ctx, attempt)) return null;
  const resolved = await resolveVerifiedContentReviewMaterial(
    deps,
    ctx,
    obligation,
    material,
    attempt,
  );
  if (!resolved) return null;
  return {
    content: resolved.material.content,
    frozenReviewerContext: resolved.context,
    repositoryDiscoverySnapshot:
      resolved.attempt.repositoryDiscovery.kind === 'repository'
        ? resolved.attempt.repositoryDiscovery.snapshot
        : null,
    attemptId: resolved.attempt.attemptId,
  };
}

/** Verify the frozen material and bindable attempt, or block fail-closed. */
async function resolveVerifiedContentReviewMaterial(
  deps: PipelineContext['deps'],
  ctx: PipelineContext,
  obligation: PersistedReviewObligation | null,
  material: PersistedReviewObligation['reviewMaterial'] | undefined,
  attempt: ReturnType<typeof findBindableAttempt>,
): Promise<{
  material: NonNullable<PersistedReviewObligation['reviewMaterial']>;
  context: FrozenReviewerContext;
  attempt: NonNullable<ReturnType<typeof findBindableAttempt>>;
} | null> {
  const { reviewCtx } = ctx;
  if (!attempt || !material || attempt.subjectDigest !== obligation?.subjectDigest) {
    const materialCheck = verifyFrozenMaterialForObligation(obligation, material);
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
  return { material, context: verification.context, attempt };
}

async function validateContentFindings(
  ctx: PipelineContext,
  reviewerResult: ReviewerSuccessResult,
  prompt: string,
  attemptId: string,
): Promise<boolean> {
  const { deps, reviewCtx, output, rawOutput } = ctx;

  if (!reviewerResult.findings) {
    await blockReviewOutcomeHelper(deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
      obligationId: reviewCtx.obligationId,
      reason: 'reviewer response was not parseable as ReviewFindings',
    });
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
  if (!parsedFindings.success || !prepared.ok) {
    await blockReviewOutcomeHelper(deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
      obligationId: reviewCtx.obligationId,
      reason: 'reviewer response did not match ReviewFindings schema',
    });
    return false;
  }
  const canonicalReviewerResult = { ...reviewerResult, findings: prepared.findings };
  const narrowed = canonicalReviewerResult as ReviewerSuccessResult & {
    findings: Record<string, unknown>;
  };
  const blocked = await enforceContentGate(ctx, narrowed, parsedFindings.data, prompt, attemptId);
  if (blocked) return false;

  const mutated = buildReviewContentMutatedOutput(rawOutput, canonicalReviewerResult);
  if (!mutated) {
    await blockReviewOutcomeHelper(deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
      obligationId: reviewCtx.obligationId,
      reason: 'review output mutation failed',
    });
    return false;
  }
  output.output = mutated;
  return true;
}

export async function runReviewContentPipeline(ctx: PipelineContext): Promise<void> {
  const { deps, sessionState, reviewCtx, output, sessionId } = ctx;
  deps.log.info('review', 'content_review_started', { sessionId });

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

  const promptDigest = hashText(prompt);
  const reviewerResult = await deps.adapter.spawnReviewer({
    prompt,
    parentSessionId: sessionId,
    authorizeDispatch: async ({ childSessionId, invokedAt }) => {
      await persistAuthorizedSdkDispatch(
        { updateReviewAssurance: deps.updateReviewAssurance },
        ctx.sessDir,
        {
          attemptId: persistedContent.attemptId,
          obligationId: reviewCtx.obligationId,
          childSessionId,
          canonicalPromptDigest: promptDigest,
          authorizedAt: invokedAt,
        },
      );
    },
    abandonDispatch: async ({ childSessionId }) => {
      await abandonSdkDispatch(
        { updateReviewAssurance: deps.updateReviewAssurance },
        ctx.sessDir,
        childSessionId,
      );
    },
    onAttemptFailed: buildAttemptFailedLogger(deps, TOOL_FLOWGUARD_REVIEW, sessionId),
    onAttemptSucceeded: buildAttemptSucceededLogger(deps, TOOL_FLOWGUARD_REVIEW),
  });

  if (reviewerResult?.blocked) {
    const code = reviewerResult.code;
    const reason = reviewerResult.reason ?? 'review invocation blocked by host transport contract';
    deps.log.warn('review', 'content_review_blocked', { sessionId, code });
    output.output = strictBlockedOutput(code, {
      reason,
      reviewInvocation: JSON.stringify(reviewerResult.reviewInvocation ?? {}),
    });
    return;
  }

  if (!reviewerResult) {
    await blockReviewOutcomeHelper(deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
      obligationId: reviewCtx.obligationId,
      reason: 'reviewer invocation failed',
    });
    return;
  }

  const accepted = await validateContentFindings(
    ctx,
    reviewerResult,
    prompt,
    persistedContent.attemptId,
  );
  if (!accepted) return;
  deps.log.info('review', 'content_review_completed', {
    sessionId,
    findingCount: countFindings(reviewerResult.findings),
  });
}

async function enforceContentGate(
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

  return persistReviewInvocation(ctx, reviewerResult, prompt, attemptId);
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
    promptHash,
    findingsHash,
    invokedAt: reviewerResult.invokedAt ?? now,
    fulfilledAt: reviewerResult.fulfilledAt ?? now,
    attemptId,
    capturedRawFindings: reviewerResult.findings,
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

type ContentEvidenceMutation = {
  ctx: PipelineContext;
  reviewerResult: ReviewerSuccessResult & { findings: Record<string, unknown> };
  attemptId: string;
  findingsHash: string;
  invocation: ReturnType<typeof buildInvocationEvidence>;
  reused: boolean;
  lineageUnavailable: boolean;
};

function buildContentEvidenceAuditIntents(input: {
  mutation: ContentEvidenceMutation;
  promptHash: string;
  state: PipelineContext['sessionState'];
  occurredAt: string;
}) {
  const { mutation, promptHash, state, occurredAt } = input;
  const result = mutation.lineageUnavailable
    ? 'lineage_unavailable'
    : mutation.reused
      ? 'reused'
      : 'fulfilled';
  return result === 'lineage_unavailable'
    ? []
    : buildSdkEvidenceAuditIntents({
        ctx: mutation.ctx,
        result,
        obligationType: 'review',
        promptHash,
        findingsHash: mutation.findingsHash,
        reviewerResult: mutation.reviewerResult,
        state,
        occurredAt,
        reviewProfile: state.policySnapshot.reviewProfile,
      });
}

/**
 * The attempt must be the exact created, unbound successor of the obligation,
 * and the child session must carry a still-`authorized` durable dispatch for
 * that attempt. No evidence exists without a prior dispatch release.
 */
function contentEvidenceLineageAvailable(
  assurance: ReturnType<typeof ensureReviewAssurance>,
  reviewCtx: PipelineContext['reviewCtx'],
  attemptId: string,
  childSessionId: string,
): boolean {
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
    return false;
  }
  return hasAuthorizedDispatch(assurance, childSessionId, attempt.attemptId);
}

function applyContentEvidenceMutation(
  state: PipelineContext['sessionState'],
  mutation: ContentEvidenceMutation,
) {
  const { ctx, reviewerResult, attemptId, findingsHash, invocation } = mutation;
  const { reviewCtx, now } = ctx;
  const assurance = ensureReviewAssurance(state.reviewAssurance);
  if (hasEvidenceReuse(assurance.invocations, reviewerResult.sessionId, findingsHash)) {
    mutation.reused = true;
    return updateObligation(state, reviewCtx.obligationId, (item) => ({
      ...item,
      status: 'blocked',
      blockedCode: 'SUBAGENT_EVIDENCE_REUSED',
    }));
  }
  if (!contentEvidenceLineageAvailable(assurance, reviewCtx, attemptId, reviewerResult.sessionId)) {
    mutation.lineageUnavailable = true;
    return state;
  }
  const boundAssurance = updateAttemptStatus(
    assurance,
    attemptId,
    'bound',
    reviewerResult.fulfilledAt ?? now,
    { childSessionId: reviewerResult.sessionId },
  );
  // Attempt binding, dispatch completion, invocation evidence, and obligation
  // fulfillment are ONE mutation: the ledger can never diverge from evidence.
  const updated = updateObligation(
    {
      ...state,
      reviewAssurance: completeReviewDispatch(
        boundAssurance,
        reviewerResult.sessionId,
        reviewerResult.fulfilledAt ?? now,
      ),
    },
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
}

async function persistReviewInvocation(
  ctx: PipelineContext,
  reviewerResult: ReviewerSuccessResult & { findings: Record<string, unknown> },
  prompt: string,
  attemptId: string,
): Promise<boolean> {
  const { deps, sessDir } = ctx;
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
  const mutation: ContentEvidenceMutation = {
    ctx,
    reviewerResult,
    attemptId,
    findingsHash,
    invocation,
    reused: false,
    lineageUnavailable: false,
  };
  await deps.updateReviewAssurance(
    sessDir,
    (state) => applyContentEvidenceMutation(state, mutation),
    (state, occurredAt) =>
      buildContentEvidenceAuditIntents({ mutation, promptHash, state, occurredAt }),
  );

  return applyContentEvidenceResult(ctx, mutation.reused, mutation.lineageUnavailable);
}
