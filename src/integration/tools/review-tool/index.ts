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
import { formatError } from '../error-format.js';
import {
  withMutableSessionTransaction,
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
import { formatReviewRequiredSignal } from '../../review/enforcement/types.js';
import type { ReviewExecutionContext, ReviewPreparation } from './types.js';
import type { StartedReviewResult } from './types.js';
import type { SessionState } from '../../../state/schema.js';
import type { RailBlocked } from '../../../rails/types.js';
import type { ReviewToolArgs } from './types.js';
import {
  ensureMissingAnalysisObligation,
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
  buildHostTaskAttestation,
} from './continuation.js';
import {
  resolveFrozenContinuationContent,
  assertFrozenSubjectUnchanged,
} from './frozen-continuation.js';

// ─── Review preparation orchestrator ─────────────────────────────────────────

// ─── Ref input resolution ────────────────────────────────────────────────────

function withCwd(
  refInput: ReviewReferenceInput | undefined,
  cwd: string | undefined,
): ReviewReferenceInput | undefined {
  if (!refInput || !cwd) return refInput;
  return { ...refInput, cwd };
}

export { isHostTaskVerdictContinuation } from './continuation-authority.js';
import {
  resolveObligationBranchSource,
  missingHostTaskVerdictBlock,
  resolveHostTaskContinuationAuthority,
} from './continuation-authority.js';

/**
 * Resolve the reviewed content for this invocation.
 *
 * A host-task verdict continuation reuses the persisted frozen subject and
 * material instead of re-deriving them; any remaining derivation is checked
 * against the frozen subject digest. Returns the blocked payload as a string.
 */
async function resolveReviewContentForExecution(
  state: SessionState,
  exec: ReviewExecutionContext,
  refInput: ReviewReferenceInput | undefined,
): Promise<PreparedReviewContent | null | string> {
  const frozen = resolveFrozenContinuationContent(state, exec);
  if (frozen.kind === 'blocked') return frozen.message;
  if (frozen.kind === 'reuse') return frozen.content;

  const derived = await prepareReviewContent(refInput, undefined);
  if (derived && 'kind' in derived) return formatBlockedReviewReport(derived);
  return assertFrozenSubjectUnchanged(state, exec, derived) ?? derived;
}

async function prepareReviewExecution(
  sessDir: string,
  state: SessionState,
  result: StartedReviewResult,
  exec: ReviewExecutionContext,
): Promise<ReviewPreparation | string> {
  const missingVerdictBlock = missingHostTaskVerdictBlock(state, exec);
  if (missingVerdictBlock) return missingVerdictBlock;
  const resolvedSource = resolveObligationBranchSource(state, exec);
  let refInput = withCwd(populateRefInput(exec.args, state, resolvedSource), exec.context.worktree);
  if (exec.args.branch && !resolvedSource) {
    const hostVerdict = await prepareHostTaskVerdictReview(sessDir, state, result, exec);
    if (hostVerdict) return withMaterializedHostVerdict(hostVerdict, null);
  }
  const materializedContent = await resolveReviewContentForExecution(state, exec, refInput);
  if (typeof materializedContent === 'string') return materializedContent;
  const hostVerdict = await prepareHostTaskVerdictReview(sessDir, state, result, exec);
  if (hostVerdict) return withMaterializedHostVerdict(hostVerdict, materializedContent);

  const missingResult = await ensureMissingAnalysisObligation(sessDir, state, exec.args, exec.now, {
    worktree: exec.context.worktree,
    resolvedSource,
    preparedContent: materializedContent ?? undefined,
  });

  if (resolvedSource && missingResult.obligation) {
    refInput = {
      ...refInput,
      reviewObligationId: missingResult.obligation.obligationId,
      ...(missingResult.attemptId && { reviewAttemptId: missingResult.attemptId }),
    };
  }
  if (exec.args.reviewFindings === undefined)
    return prepareMissingFindingsSubmission(result, refInput, missingResult, materializedContent);
  return finishFindingsSubmission(sessDir, state, result, exec, { refInput, materializedContent });
}

function withMaterializedHostVerdict(
  hostVerdict: ReviewPreparation | string,
  materializedContent: PreparedReviewContent | null,
): ReviewPreparation | string {
  return typeof hostVerdict === 'string'
    ? hostVerdict
    : { ...hostVerdict, materializedContent, reviewSubject: materializedContent?.reviewSubject };
}

function prepareMissingFindingsSubmission(
  result: StartedReviewResult,
  refInput: ReviewReferenceInput | undefined,
  missingResult: Awaited<ReturnType<typeof ensureMissingAnalysisObligation>>,
  materializedContent: PreparedReviewContent | null,
): ReviewPreparation {
  return {
    result,
    refInput,
    validatedReviewObligation: null,
    pendingObligation: missingResult.obligation,
    persistedAssurance: missingResult.assurance,
    blockMessage: missingResult.message ?? undefined,
    materializedContent,
    reviewSubject: materializedContent?.reviewSubject,
  };
}

async function finishFindingsSubmission(
  sessDir: string,
  state: SessionState,
  result: StartedReviewResult,
  exec: ReviewExecutionContext,
  content: {
    refInput: ReviewReferenceInput | undefined;
    materializedContent: PreparedReviewContent | null;
  },
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
  const refInput = content.refInput
    ? { ...content.refInput, skipExternalContentLoad: true }
    : undefined;
  return {
    result: recorded.result,
    refInput,
    validatedReviewObligation: resolved.obligation,
    materializedContent: content.materializedContent,
    reviewSubject: content.materializedContent?.reviewSubject,
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
  // Verdict-time incoherence (SUBAGENT_VERDICT_FINDINGS_INCOHERENT and all
  // SUBAGENT_CHALLENGE_* codes) is a semantic consistency failure — persisted
  // as `consistency_invalid`, which never authorizes an output repair.
  const rejectedState: SessionState = {
    ...state,
    reviewAssurance: updateAttemptStatus(assurance, attempt.attemptId, 'rejected', now, {
      rejectionReason: 'consistency_invalid',
    }),
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
    // identity before the host issues retry guidance. Reissue is authorized
    // by the output-repair gate; a denied gate blocks the obligation.
    const reissue = await reissueReviewAttempt(sessDir, state, obligation, exec.now);
    if (reissue.kind === 'blocked') {
      return formatBlocked(
        reissue.authorization.code,
        {
          obligationId: obligation.obligationId,
          reason: reissue.authorization.reason,
        },
        {
          policy: exec.policy,
          policyMode: exec.policy,
          bindOutcome: resolved.kind,
        },
      );
    }
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
        reviewAttemptId: reissue.attempt.attemptId,
        next: formatReviewRequiredSignal(obligation.iteration, obligation.planVersion),
        requiredReviewAttestation: buildHostTaskAttestation(obligation),
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

  const refInput = populateRefInput(exec.args, state, undefined);
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

type PreparedReviewExecution = ReviewPreparation & {
  sessDir: string;
  now: string;
};

function isBlockedReviewResult(
  result: Awaited<ReturnType<typeof executeReview>>,
): result is RailBlocked {
  return 'kind' in result && result.kind === 'blocked';
}

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
    // Only a durable obligation may materialize the REVIEW intermediate state.
    if (prepared.blockMessage && !prepared.persistedAssurance) return prepared.blockMessage;
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

    if (isBlockedReviewResult(reviewResult)) {
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
      report: completion.report,
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
): Promise<LoadedReviewContent> {
  const loadedContent: PreparedReviewContent | null = prepared.materializedContent ?? null;
  const reviewState = prepared.result.state;

  if (prepared.blockMessage) {
    return {
      reviewState,
      loadedContent: loadedContent?.content,
      blockMessage: prepared.blockMessage,
    };
  }

  if (hasImplicitContentSignal(args) && !loadedContent) {
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

      const content = await loadAndBindReviewContent(prepared, args);
      if (content.blockMessage) return content.blockMessage;

      const reviewResult = await executeReview(
        content.reviewState,
        prepared.now,
        buildReviewExecutors(args, prepared.effectiveReviewFindings),
        prepared.refInput,
        content.loadedContent === undefined
          ? undefined
          : (prepared.materializedContent ?? content.loadedContent),
      );
      return await persistCompletedReview(args, context, reviewResult, prepared.now);
    } catch (err) {
      return formatError(err);
    }
  },
};
