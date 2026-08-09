/**
 * @module integration/tools/review-tool/index
 * @description FlowGuard review tool — standalone review flow (READY → REVIEW → REVIEW_COMPLETE).
 *
 * Orchestrates the review lifecycle: preparation, execution, completion.
 * Delegates to obligation.ts, invocation.ts, and completion.ts for domain logic.
 *
 * @version v1
 */

import { z } from 'zod';

import type { ToolDefinition } from '../helpers.js';
import {
  withMutableSessionTransaction,
  formatError,
  formatAutoAdvanceOverflow,
  formatBlocked,
} from '../helpers.js';
import {
  executeReview,
  type PreparedReviewContent,
  type ReviewReferenceInput,
} from '../../../rails/review.js';
import {
  InputOriginSchema,
  ExternalReferenceSchema,
  ReviewFindings,
  type ReviewObligation,
} from '../../../state/evidence.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import type { ReviewExecutionContext, ReviewPreparation } from './types.js';
import type { StartedReviewResult } from './types.js';
import type { SessionState } from '../../../state/schema.js';
import type { ReviewToolArgs } from './types.js';
import {
  buildReviewReferenceInput,
  ensureMissingAnalysisObligation,
  hasReviewContentInput,
  hasImplicitContentSignal,
  validateHostTaskContinuationInput,
  resolveSubmittedReviewObligation,
  validateSubmittedReviewFindings,
  consumeValidatedReviewObligation,
} from './obligation.js';
import { resolveHostTaskFindings } from '../review-validation.js';
import { recordSubmittedReviewInvocation } from './invocation.js';
import {
  buildReviewExecutors,
  formatBlockedReviewReport,
  persistReviewCompletion,
  buildReviewCompletionResponse,
} from './completion.js';
import { resolveBranchReviewSource } from '../../../adapters/gh-cli.js';
import { prepareReviewContent } from '../../../rails/review.js';
import { findReviewObligationById, updateAttemptStatus } from '../../review/assurance.js';
import { writeStateWithArtifacts } from '../helpers.js';
import {
  appendCompletedReviewEvidence,
  appendPreparedReviewEvidence,
  prepareStandaloneReviewEvidence,
} from './preparation.js';
import {
  ensureStartedReviewState,
  reissueReviewAttempt,
  populateRefInput,
} from './continuation.js';

async function bindReviewContentDigest(
  context: Parameters<ToolDefinition['execute']>[1],
  obligationId: string,
  reviewedContentDigest: string,
): Promise<SessionState> {
  return withMutableSessionTransaction(context, async ({ sessDir, state }) => {
    const assurance = state.reviewAssurance;
    if (!assurance) throw new Error('No review assurance state for content digest binding');

    const obligation = findReviewObligationById(assurance, obligationId);
    if (!obligation) throw new Error('Obligation not found for content digest binding');

    const existingMeta = obligation.metadata;
    const updatedMetadata: Record<string, unknown> = {
      ...(typeof existingMeta === 'object' && existingMeta !== null ? existingMeta : {}),
      reviewedContentDigest,
    };

    const updatedObligation = { ...obligation, metadata: updatedMetadata };
    const updatedObligations = assurance.obligations.map((o) =>
      o.obligationId === obligationId ? updatedObligation : o,
    );

    const updatedState: SessionState = {
      ...state,
      reviewAssurance: {
        ...assurance,
        obligations: updatedObligations,
      },
    };

    await writeStateWithArtifacts(sessDir, updatedState);
    return updatedState;
  });
}

// ─── Review preparation orchestrator ─────────────────────────────────────────

// ─── Ref input resolution ────────────────────────────────────────────────────

function withCwd(
  refInput: ReviewReferenceInput | undefined,
  cwd: string | undefined,
): ReviewReferenceInput | undefined {
  if (!refInput || !cwd) return refInput;
  return { ...refInput, cwd };
}

/**
 * Resolve the immutable branch source, but only when an obligation is being
 * created. An explicit host-task continuation is bound to its existing
 * obligation and must not re-resolve refs.
 */
function resolveObligationBranchSource(
  exec: ReviewExecutionContext,
): ReturnType<typeof resolveBranchReviewSource> | undefined {
  if (!exec.args.branch) return undefined;
  if (exec.args.reviewFindings !== undefined) return undefined;
  const isHostTaskVerdictContinuation =
    exec.policy === 'host_task_required' &&
    exec.args.reviewVerdict !== undefined &&
    exec.args.reviewObligationId !== undefined;
  if (isHostTaskVerdictContinuation) return undefined;
  return resolveBranchReviewSource(exec.args.branch, exec.args.base, exec.context.worktree);
}

type HostTaskContinuationAuthority =
  | { readonly kind: 'not_applicable' }
  | {
      readonly kind: 'explicit';
      readonly reviewObligationId: string;
      readonly reviewVerdict: 'accept' | 'changes_requested';
    }
  | {
      readonly kind: 'id_required';
      readonly compatibleObligationIds: readonly string[];
    }
  | {
      readonly kind: 'ambiguous';
      readonly compatibleObligationIds: readonly string[];
    };

function resolveHostTaskContinuationAuthority(
  state: SessionState,
  exec: ReviewExecutionContext,
): HostTaskContinuationAuthority {
  if (exec.policy !== 'host_task_required' || exec.args.reviewVerdict === undefined) {
    return { kind: 'not_applicable' };
  }
  if (exec.args.reviewObligationId !== undefined) {
    return {
      kind: 'explicit',
      reviewObligationId: exec.args.reviewObligationId,
      reviewVerdict: exec.args.reviewVerdict,
    };
  }
  // A verdict accompanying content can be the first call; obligation creation
  // remains authoritative for that path rather than guessing a continuation.
  if (hasReviewContentInput(exec.args)) return { kind: 'not_applicable' };
  const compatibleObligationIds = (state.reviewAssurance?.obligations ?? [])
    .filter(
      (obligation) =>
        obligation.obligationType === 'review' &&
        obligation.status !== 'consumed' &&
        obligation.status !== 'blocked',
    )
    .filter((obligation) =>
      (state.reviewAssurance?.invocations ?? []).some(
        (invocation) =>
          invocation.obligationId === obligation.obligationId &&
          invocation.invocationMode === 'host_subagent_task' &&
          invocation.hostVisible === true &&
          invocation.capturedRawFindings != null &&
          invocation.capturedVerdict === exec.args.reviewVerdict &&
          (obligation.invocationId === invocation.invocationId ||
            invocation.attemptId !== undefined),
      ),
    )
    .map((obligation) => obligation.obligationId);
  return compatibleObligationIds.length > 1
    ? { kind: 'ambiguous', compatibleObligationIds }
    : { kind: 'id_required', compatibleObligationIds };
}

function formatHostTaskContinuationAuthority(
  authority: HostTaskContinuationAuthority,
): string | null {
  if (authority.kind === 'not_applicable' || authority.kind === 'explicit') return null;
  if (authority.kind === 'ambiguous') {
    return formatBlocked('REVIEW_OBLIGATION_AMBIGUOUS', {
      obligationIds: authority.compatibleObligationIds.join(', '),
      reason:
        'More than one compatible host-task review obligation has captured the supplied verdict. Supply reviewObligationId explicitly.',
    });
  }
  return formatBlocked('REVIEW_OBLIGATION_ID_REQUIRED', {
    reason:
      'A host-task review verdict requires reviewObligationId unless this is the first content-aware review call.',
    ...(authority.compatibleObligationIds.length === 1
      ? { reviewObligationId: authority.compatibleObligationIds[0]! }
      : {}),
    continuation:
      'Call flowguard_review with the original content fields, reviewObligationId, and reviewVerdict.',
  });
}

function missingHostTaskVerdictBlock(
  state: SessionState,
  exec: ReviewExecutionContext,
): string | null {
  return formatHostTaskContinuationAuthority(resolveHostTaskContinuationAuthority(state, exec));
}

async function prepareReviewExecution(
  sessDir: string,
  state: SessionState,
  result: StartedReviewResult,
  exec: ReviewExecutionContext,
): Promise<ReviewPreparation | string> {
  const missingVerdictBlock = missingHostTaskVerdictBlock(state, exec);
  if (missingVerdictBlock) return missingVerdictBlock;
  const resolvedSource = resolveObligationBranchSource(exec);

  const hostTaskVerdict = await prepareHostTaskVerdictReview(sessDir, state, result, exec);
  if (hostTaskVerdict) return hostTaskVerdict;

  const missingResult = await ensureMissingAnalysisObligation(sessDir, state, exec.args, exec.now, {
    worktree: exec.context.worktree,
    resolvedSource,
  });

  let refInput = populateRefInput(exec.args, state, resolvedSource);
  if (resolvedSource && missingResult.obligation) {
    refInput = {
      ...refInput,
      reviewObligationId: missingResult.obligation.obligationId,
      ...(missingResult.attemptId && { reviewAttemptId: missingResult.attemptId }),
    };
  }
  if (exec.args.reviewFindings === undefined) {
    return {
      result,
      refInput: withCwd(refInput, exec.context.worktree),
      validatedReviewObligation: null,
      pendingObligation: missingResult.obligation,
      persistedAssurance: missingResult.assurance,
      blockMessage: missingResult.message ?? undefined,
    };
  }
  return finishFindingsSubmission(
    sessDir,
    state,
    result,
    exec,
    withCwd(refInput, exec.context.worktree),
  );
}

async function finishFindingsSubmission(
  sessDir: string,
  state: SessionState,
  result: StartedReviewResult,
  exec: ReviewExecutionContext,
  refInput: ReviewReferenceInput | undefined,
): Promise<ReviewPreparation | string> {
  const resolved = await resolveSubmittedReviewObligation(
    sessDir,
    state,
    exec.args,
    exec.now,
    exec.context.worktree,
  );
  if (resolved.blocked || !resolved.obligation) {
    return resolved.blocked ?? formatBlocked('REVIEW_OBLIGATION_NOT_FOUND', {});
  }
  const validationBlock = validateSubmittedReviewFindings(state, exec.args, resolved.obligation);
  if (validationBlock) return validationBlock;
  const recorded = await recordSubmittedReviewInvocation(
    result,
    resolved.obligation,
    exec,
    sessDir,
  );
  if (recorded.blocked) return recorded.blocked;
  if (refInput) refInput = { ...refInput, skipExternalContentLoad: true };
  // Carry obligation provenance into refInput for the findings-submission path
  const meta = resolved.obligation.metadata;
  if (typeof meta?.resolvedBranchSha === 'string' && typeof meta?.resolvedBaseSha === 'string') {
    refInput = {
      ...refInput,
      reviewObligationId: resolved.obligation.obligationId,
      resolvedBranchSha: meta.resolvedBranchSha,
      resolvedBaseSha: meta.resolvedBaseSha,
    };
  }
  return {
    result: recorded.result,
    refInput,
    validatedReviewObligation: resolved.obligation,
    ...(recorded.nativeAttestationRejection
      ? { nativeAttestationRejection: recorded.nativeAttestationRejection }
      : {}),
  };
}

type HostTaskObligationResolution =
  { kind: 'found'; obligation: ReviewObligation } | { kind: 'missing' };

function resolveHostTaskObligation(
  state: SessionState,
  reviewObligationId: string,
): HostTaskObligationResolution {
  const obligation = findReviewObligationById(state.reviewAssurance, reviewObligationId);
  if (
    obligation &&
    obligation.obligationType === 'review' &&
    obligation.status !== 'consumed' &&
    obligation.status !== 'blocked'
  ) {
    return { kind: 'found', obligation };
  }
  return { kind: 'missing' };
}

type AttemptRejectionResult =
  | { ok: true }
  | {
      ok: false;
      code:
        'REVIEW_ASSURANCE_UNAVAILABLE' | 'REVIEW_ATTEMPT_ID_MISSING' | 'REVIEW_ATTEMPT_NOT_FOUND';
      details: Record<string, string>;
    };

async function rejectIncoherentAttempt(
  sessDir: string,
  state: SessionState,
  attemptId: string,
  now: string,
): Promise<AttemptRejectionResult> {
  const assurance = state.reviewAssurance;
  if (!assurance) {
    return { ok: false, code: 'REVIEW_ASSURANCE_UNAVAILABLE', details: {} };
  }
  if (!attemptId) {
    return { ok: false, code: 'REVIEW_ATTEMPT_ID_MISSING', details: {} };
  }
  const attempt = assurance.attempts?.find((item) => item.attemptId === attemptId);
  if (!attempt) {
    return { ok: false, code: 'REVIEW_ATTEMPT_NOT_FOUND', details: { attemptId } };
  }
  const rejectedState: SessionState = {
    ...state,
    reviewAssurance: updateAttemptStatus(assurance, attempt.attemptId, 'rejected', now),
  };
  await writeStateWithArtifacts(sessDir, rejectedState);
  return { ok: true };
}

// eslint-disable-next-line complexity, max-lines-per-function -- explicit fail-closed host-task verdict resolution
async function prepareHostTaskVerdictReview(
  sessDir: string,
  state: SessionState,
  result: StartedReviewResult,
  exec: ReviewExecutionContext,
): Promise<ReviewPreparation | string | null> {
  // A verdict without an ID is an allowed first call. It must create (or reissue
  // instructions for) an obligation rather than guessing a continuation identity.
  const authority = resolveHostTaskContinuationAuthority(state, exec);
  if (authority.kind !== 'explicit') return null;

  const resolution = resolveHostTaskObligation(state, authority.reviewObligationId);
  if (resolution.kind === 'missing') {
    return formatBlocked('REVIEW_OBLIGATION_NOT_FOUND', {
      obligationId: authority.reviewObligationId,
      reason: 'The host-task review obligation is missing, consumed, or blocked.',
    });
  }

  const obligation = resolution.obligation;
  const inputBlock = validateHostTaskContinuationInput(obligation, exec.args);
  if (inputBlock) return inputBlock;
  const resolved = resolveHostTaskFindings(state.reviewAssurance, obligation);

  if (resolved.kind === 'incoherent') {
    const rejection = await rejectIncoherentAttempt(sessDir, state, resolved.attemptId, exec.now);
    if (!rejection.ok) {
      return formatBlocked(rejection.code, rejection.details);
    }
    return formatBlocked(
      resolved.code,
      Object.fromEntries(
        Object.entries(resolved.details).map(([key, value]) => [key, String(value)]),
      ),
    );
  }

  if (resolved.kind === 'attempt_lineage_unavailable') {
    return formatBlocked('REVIEW_ATTEMPT_LINEAGE_UNAVAILABLE', {
      invocationId: resolved.invocationId,
      obligationId: resolved.obligationId,
    });
  }

  if (resolved.kind !== 'resolved') {
    // Reissue an attempt so the next reviewer Task has a registered attempt
    // identity before the host issues retry guidance.
    const reissue = await reissueReviewAttempt(
      sessDir,
      state,
      {
        obligationId: obligation.obligationId,
        subjectDigest: obligation.subjectDigest,
        obligationType: obligation.obligationType,
      },
      exec.now,
    );
    return formatBlocked(
      'HOST_SUBAGENT_TASK_REQUIRED',
      { reviewerSubagentType: REVIEWER_SUBAGENT_TYPE },
      {
        reason:
          resolved.kind === 'rejected'
            ? 'host-task reviewer evidence exists but is not acceptable for the active review obligation'
            : 'host-task reviewer evidence is required before submitting reviewVerdict',
        policy: exec.policy,
        policyMode: exec.policy,
        bindOutcome: resolved.kind,
        reviewerSubagentType: REVIEWER_SUBAGENT_TYPE,
        reviewObligationId: obligation.obligationId,
        reviewAttemptId: reissue.attemptId,
      },
    );
  }

  if (resolved.findings.overallVerdict === 'unable_to_review') {
    return formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', {
      obligationId: resolved.invocation.obligationId,
    });
  }

  if (authority.reviewVerdict !== resolved.findings.overallVerdict) {
    return formatBlocked('SUBAGENT_FINDINGS_VERDICT_MISMATCH', {
      provided: authority.reviewVerdict,
      expected: resolved.findings.overallVerdict,
    });
  }

  const refInput = buildReviewReferenceInput(exec.args);
  return {
    result,
    refInput: refInput
      ? {
          ...refInput,
          skipExternalContentLoad: true,
          ...(exec.context.worktree ? { cwd: exec.context.worktree } : {}),
        }
      : undefined,
    validatedReviewObligation: obligation,
    effectiveReviewFindings: resolved.findings,
    evidenceInvocationId: resolved.invocationId,
  };
}

// ─── Tool definition ─────────────────────────────────────────────────────────

type PreparedReviewExecution = ReviewPreparation & {
  sessDir: string;
  now: string;
};

async function prepareReviewWithoutExternalCalls(
  args: ReviewToolArgs,
  context: Parameters<ToolDefinition['execute']>[1],
): Promise<PreparedReviewExecution | string> {
  return withMutableSessionTransaction(context, async ({ sessDir, state, ctx }) => {
    const now = new Date().toISOString();
    const ensured = ensureStartedReviewState(state, ctx);
    if (typeof ensured === 'string') return ensured;
    const result = ensured;

    const prepared = await prepareReviewExecution(sessDir, state, result, {
      args,
      context,
      now,
      policy: state.policySnapshot?.reviewInvocationPolicy ?? 'host_task_required',
    });
    if (typeof prepared === 'string') return prepared;
    const taskEvidence = prepareStandaloneReviewEvidence(args, now, prepared.refInput);
    const stateWithTaskEvidence: SessionState = {
      // Persist the REVIEW transition materialized by startReviewFlow so the
      // canonical session state reflects the active review obligation. The
      // completion path continues an existing REVIEW rather than re-starting
      // the user-level /review command (which would require READY).
      ...result.state,
      // Obligation preparation already persisted the obligation AND its attempt.
      // Re-deriving from `state` (read before that write) dropped the attempt, so
      // the host could never bind reviewer evidence for a standalone /review.
      ...(prepared.persistedAssurance && { reviewAssurance: prepared.persistedAssurance }),
      standaloneReviewEvidence: appendPreparedReviewEvidence(
        state.standaloneReviewEvidence,
        taskEvidence,
      ),
    };
    // The prepared entry is durable before a reviewer can be instructed.
    await writeStateWithArtifacts(sessDir, stateWithTaskEvidence);
    return { ...prepared, sessDir, now };
  });
}

async function persistCompletedReview(
  args: ReviewToolArgs,
  context: Parameters<ToolDefinition['execute']>[1],
  reviewResult: Awaited<ReturnType<typeof executeReview>>,
  now: string,
): Promise<string> {
  return withMutableSessionTransaction(context, async ({ sessDir, state, ctx }) => {
    const ensured = ensureStartedReviewState(state, ctx);
    if (typeof ensured === 'string') return ensured;
    const startedResult = ensured;

    const prepared = await prepareReviewExecution(sessDir, state, startedResult, {
      args,
      context,
      now,
      policy: state.policySnapshot?.reviewInvocationPolicy ?? 'host_task_required',
    });
    if (typeof prepared === 'string') return prepared;

    if (reviewResult.kind === 'blocked') {
      return formatBlockedReviewReport(reviewResult);
    }

    let result = consumeValidatedReviewObligation(
      prepared.result,
      prepared.validatedReviewObligation,
      args,
      now,
      {
        acceptedInvocationId: prepared.evidenceInvocationId,
        effectiveReviewFindings: prepared.effectiveReviewFindings,
      },
    );
    const taskEvidence = prepareStandaloneReviewEvidence(args, now, prepared.refInput);
    result = {
      ...result,
      state: {
        ...result.state,
        standaloneReviewEvidence: appendCompletedReviewEvidence({
          evidence: state.standaloneReviewEvidence,
          prepared: taskEvidence,
          completedAt: now,
          findings: prepared.effectiveReviewFindings ?? args.reviewFindings,
        }),
      },
    };
    const completion = await persistReviewCompletion(sessDir, result, reviewResult, ctx);
    if (completion.kind === 'overflow') {
      return formatAutoAdvanceOverflow(completion.overflow);
    }
    return buildReviewCompletionResponse({
      sessDir,
      args,
      result,
      report: reviewResult,
      validatedReviewObligation: prepared.validatedReviewObligation,
      nativeAttestationRejection: prepared.nativeAttestationRejection,
      finalState: completion.finalState,
      allTransitions: completion.allTransitions,
      worktree: context.worktree,
    });
  });
}

// ─── Content loading & binding ─────────────────────────────────────────────

interface LoadedReviewContent {
  reviewState: SessionState;
  loadedContent: string | undefined;
  blockMessage: string | undefined;
}

/**
 * Load external review content, bind its digest to the obligation, and verify
 * that a content-aware review has a bound obligation or loaded content before
 * proceeding.
 *
 * Extracted from `execute` to keep tool-complexity within bounds.
 */
async function loadAndBindReviewContent(
  prepared: PreparedReviewExecution,
  args: ReviewToolArgs,
  context: Parameters<ToolDefinition['execute']>[1],
): Promise<LoadedReviewContent> {
  const result = await prepareReviewContent(prepared.refInput, undefined);
  if (result && 'kind' in result) {
    return {
      reviewState: prepared.result.state,
      loadedContent: undefined,
      blockMessage: formatBlockedReviewReport(result),
    };
  }

  const loadedContent: PreparedReviewContent | null = result;
  const bindTarget = prepared.pendingObligation ?? prepared.validatedReviewObligation;
  const reviewState = await bindDigestIfAvailable(context, bindTarget, loadedContent, prepared);

  if (prepared.blockMessage) {
    return {
      reviewState,
      loadedContent: loadedContent?.content,
      blockMessage: prepared.blockMessage,
    };
  }

  if (hasImplicitContentSignal(args) && !bindTarget && !loadedContent) {
    return {
      reviewState,
      loadedContent: undefined,
      blockMessage: formatBlocked('REVIEW_CONTENT_SOURCE_INCOMPLETE', {
        label: `inputOrigin=${args.inputOrigin ?? ''}, references`,
      }),
    };
  }

  return {
    reviewState,
    loadedContent: loadedContent?.content,
    blockMessage: undefined,
  };
}

async function bindDigestIfAvailable(
  context: Parameters<ToolDefinition['execute']>[1],
  bindTarget: ReviewObligation | null | undefined,
  content: PreparedReviewContent | null,
  prepared: PreparedReviewExecution,
): Promise<SessionState> {
  if (!content?.reviewedContentDigest || !bindTarget?.obligationId) {
    return prepared.result.state;
  }
  return bindReviewContentDigest(context, bindTarget.obligationId, content.reviewedContentDigest);
}

export const review: ToolDefinition = {
  description:
    'Start the standalone review flow. Transitions READY → REVIEW → REVIEW_COMPLETE. ' +
    'Generates a compliance review report with evidence completeness matrix ' +
    'and four-eyes principle status, written to the session directory. ' +
    'Only allowed in READY phase.',
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
    base: z
      .string()
      .optional()
      .describe(
        'Explicit base ref/branch/SHA to diff a branch review against (e.g. base="main"). ' +
          'When omitted, the base is auto-detected (origin/HEAD → main → master → merge-base with HEAD).',
      ),
    url: z.string().url().optional().describe('URL to fetch and analyze during /review.'),
    reviewObligationId: z
      .string()
      .uuid()
      .optional()
      .describe(
        'Exact obligation ID from requiredReviewAttestation.toolObligationId. Required when submitting a host-task review verdict.',
      ),
    reviewVerdict: z
      .enum(['accept', 'changes_requested'])
      .optional()
      .describe(
        `Reviewer verdict returned by ${REVIEWER_SUBAGENT_TYPE}. In host-task mode, ` +
          'submit this after host-visible reviewer evidence has been bound; do not copy reviewFindings.',
      ),
    reviewFindings: ReviewFindings.optional().describe(
      `Complete findings from ${REVIEWER_SUBAGENT_TYPE} subagent analysis. ` +
        'Required for SDK/manual content-aware review submissions; ignored in host-task verdict mode. ' +
        'Must include reviewMode="subagent", reviewedBy, and valid attestation with ' +
        'mandateDigest and criteriaVersion.',
    ),
    targetPaths: z
      .array(z.string())
      .optional()
      .describe(
        'File paths touched by this review. Required for risk classification when ' +
          'challengePolicy is active and no branch/PR auto-resolution is available (e.g. text or URL review).',
      ),
    objectives: z
      .array(
        z.object({
          objectiveId: z
            .string()
            .min(1)
            .regex(/^[a-z][a-z0-9_-]*$/),
          statement: z.string().min(1),
        }),
      )
      .min(1)
      .optional()
      .describe('Optional structured review objectives. Omit to use the canonical static profile.'),
  },
  async execute(args: ReviewToolArgs, context) {
    try {
      const prepared = await prepareReviewWithoutExternalCalls(args, context);
      if (typeof prepared === 'string') return prepared;

      const content = await loadAndBindReviewContent(prepared, args, context);
      if (content.blockMessage) return content.blockMessage;

      const reviewResult = await executeReview(
        content.reviewState,
        prepared.now,
        buildReviewExecutors(args, prepared.effectiveReviewFindings),
        prepared.refInput,
        content.loadedContent,
      );
      return await persistCompletedReview(args, context, reviewResult, prepared.now);
    } catch (err) {
      return formatError(err);
    }
  },
};
