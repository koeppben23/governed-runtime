/**
 * @module integration/tools/review-tool/index
 * @description FlowGuard review tool — peer review flow (READY → PEER_REVIEW → PEER_REVIEW_COMPLETE).
 *
 * Orchestrates the review lifecycle: preparation, execution, completion.
 * Delegates to obligation.ts and completion.ts for domain logic.
 *
 * @version v1
 */
import { getAdapterLogger } from '../../../logging/adapter-logger.js';
import { z } from 'zod';
import type { ToolDefinition } from '../helpers.js';
import { formatError } from '../error-format.js';
import { formatBlocked } from '../../blocked-result.js';
import { withMutableSessionTransaction, formatAutoAdvanceOverflow } from '../helpers.js';
import {
  executeReview,
  type PreparedReviewContent,
  type ReviewReferenceInput,
} from '../../../rails/review.js';
import { InputOriginSchema, ExternalReferenceSchema } from '../../../state/evidence.js';
import type { ReviewExecutionContext, ReviewPreparation } from './types.js';
import type { StartedReviewResult } from './types.js';
import type { SessionState } from '../../../state/schema.js';
import type { ReviewObligation } from '../../../state/evidence.js';
import type { RailBlocked } from '../../../rails/types.js';
import type { ReviewToolArgs } from './types.js';
import {
  ensureMissingAnalysisObligation,
  hasImplicitContentSignal,
  validateSubmittedReviewFindings,
  consumeValidatedReviewObligation,
} from './obligation.js';
import {
  resolveStructuredFindings,
  type StructuredFindingsResolution,
} from '../../review/review-validation-structured-evidence.js';
import { formatStructuredResolutionFailure } from '../../review/review-validation.js';
import {
  buildReviewExecutors,
  formatBlockedReviewReport,
  persistReviewCompletion,
  buildReviewCompletionResponse,
} from './completion.js';
import { prepareReviewContent } from '../../../rails/review.js';
import { findReviewObligationById } from '../../review/obligations/assurance.js';
import { writeStateWithArtifacts } from '../helpers.js';
import {
  appendCompletedReviewEvidence,
  appendPreparedReviewEvidence,
  preparePeerReviewEvidence,
  resolveReviewTaskIdentity,
} from './preparation.js';
import { ensureStartedReviewState, populateRefInput } from './continuation.js';

// ─── Review preparation orchestrator ─────────────────────────────────────────

// ─── Ref input resolution ────────────────────────────────────────────────────

function withCwd(
  refInput: ReviewReferenceInput | undefined,
  cwd: string | undefined,
): ReviewReferenceInput | undefined {
  if (!refInput || !cwd) return refInput;
  return { ...refInput, cwd };
}

import { resolveObligationBranchSource } from './continuation-authority.js';

/**
 * Resolve the reviewed content for this invocation.
 *
 * Returns the blocked payload as a string.
 */
async function resolveReviewContentForExecution(
  state: SessionState,
  exec: ReviewExecutionContext,
  refInput: ReviewReferenceInput | undefined,
): Promise<PreparedReviewContent | null | string> {
  if (exec.args.reviewObligationId && !refInput) {
    const obligation = findReviewObligationById(
      state.reviewAssurance,
      exec.args.reviewObligationId,
    );
    if (
      obligation?.obligationType === 'review' &&
      obligation.reviewMaterial &&
      obligation.reviewSubject
    ) {
      return {
        content: obligation.reviewMaterial.content,
        reviewedContentDigest: obligation.reviewMaterial.materialDigest,
        reviewSubject: obligation.reviewSubject,
      };
    }
  }
  const derived = await prepareReviewContent(refInput, undefined);
  if (derived && 'kind' in derived) return formatBlockedReviewReport(derived);
  return derived;
}

async function prepareReviewExecution(
  sessDir: string,
  state: SessionState,
  result: StartedReviewResult,
  exec: ReviewExecutionContext,
): Promise<ReviewPreparation | string> {
  const resolvedSource = resolveObligationBranchSource(state, exec);
  let refInput = withCwd(populateRefInput(exec.args, state, resolvedSource), exec.context.worktree);
  const materializedContent = await resolveReviewContentForExecution(state, exec, refInput);
  if (typeof materializedContent === 'string') return materializedContent;

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
  // Findings are only ever resolved from host-captured structured evidence:
  // bound evidence resolves the submission; otherwise the caller is told that
  // the reviewer evidence is missing.
  const structured = prepareStructuredEvidenceSubmission(state, result, exec, materializedContent);
  if (structured) return structured;
  return prepareMissingFindingsSubmission(result, refInput, missingResult, materializedContent);
}

function prepareMissingFindingsSubmission(
  result: StartedReviewResult,
  refInput: ReviewReferenceInput | undefined,
  missingResult: Awaited<ReturnType<typeof ensureMissingAnalysisObligation>>,
  materializedContent: PreparedReviewContent | null,
): ReviewPreparation {
  return {
    result,
    ...(refInput !== undefined ? { refInput } : {}),
    validatedReviewObligation: null,
    ...(missingResult.obligation !== undefined
      ? { pendingObligation: missingResult.obligation }
      : {}),
    ...(missingResult.assurance !== undefined
      ? { persistedAssurance: missingResult.assurance }
      : {}),
    ...(missingResult.message !== null ? { blockMessage: missingResult.message } : {}),
    materializedContent,
    ...(materializedContent?.reviewSubject !== undefined
      ? { reviewSubject: materializedContent.reviewSubject }
      : {}),
  };
}

interface StructuredPreparationInput {
  readonly state: SessionState;
  readonly result: StartedReviewResult;
  readonly exec: ReviewExecutionContext;
  readonly obligation: ReviewObligation;
  readonly resolution: Extract<StructuredFindingsResolution, { kind: 'resolved' }>;
  readonly materializedContent: PreparedReviewContent | null;
}

/**
 * No bound findings means the pending obligation must project its canonical
 * native dispatch authority, not a second evidence-missing transport.
 */
function isMissingStructuredEvidenceResolution(resolution: StructuredFindingsResolution): boolean {
  return (
    resolution.kind === 'not_found' ||
    (resolution.kind === 'invalid' && resolution.code === 'SUBAGENT_EVIDENCE_MISSING')
  );
}

function buildStructuredPreparation(input: StructuredPreparationInput): ReviewPreparation {
  const { state, result, exec, obligation, resolution, materializedContent } = input;
  const refInput = populateRefInput(exec.args, state, undefined);
  return {
    result,
    ...(refInput
      ? {
          refInput: {
            ...refInput,
            skipExternalContentLoad: true,
            ...(exec.context.worktree && { cwd: exec.context.worktree }),
          },
        }
      : {}),
    validatedReviewObligation: obligation,
    effectiveReviewFindings: resolution.findings,
    evidenceInvocationId: resolution.invocationId,
    materializedContent,
    ...(materializedContent?.reviewSubject !== undefined
      ? { reviewSubject: materializedContent.reviewSubject }
      : {}),
  };
}

function prepareStructuredEvidenceSubmission(
  state: SessionState,
  result: StartedReviewResult,
  exec: ReviewExecutionContext,
  materializedContent: PreparedReviewContent | null,
): ReviewPreparation | string | null {
  if (!exec.args.reviewObligationId) return null;
  const obligation = findReviewObligationById(state.reviewAssurance, exec.args.reviewObligationId);
  if (!obligation || obligation.obligationType !== 'review') {
    return formatBlocked('REVIEW_OBLIGATION_NOT_FOUND', {
      obligationId: exec.args.reviewObligationId,
    });
  }
  const resolution = resolveStructuredFindings(
    getAdapterLogger(),
    state.reviewAssurance,
    obligation,
    undefined,
    undefined,
    undefined,
    undefined,
    exec.context.sessionID,
  );
  if (isMissingStructuredEvidenceResolution(resolution)) return null;
  if (resolution.kind !== 'resolved') return formatStructuredResolutionFailure(resolution);
  const validation = validateSubmittedReviewFindings(state, resolution.findings, obligation);
  if (validation) return validation;
  return buildStructuredPreparation({
    state,
    result,
    exec,
    obligation,
    resolution,
    materializedContent,
  });
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
    });
    if (typeof prepared === 'string') return prepared;
    // Only a durable obligation may materialize the PEER_REVIEW intermediate state.
    if (prepared.blockMessage && !prepared.persistedAssurance) return prepared.blockMessage;
    const obligationIdentity = prepared.pendingObligation ?? prepared.validatedReviewObligation;
    const taskEvidence = obligationIdentity
      ? preparePeerReviewEvidence(
          args,
          now,
          prepared.refInput,
          resolveReviewTaskIdentity(state.peerReviewEvidence, obligationIdentity.obligationId)
            .reviewTaskId,
          obligationIdentity.obligationId,
        )
      : null;
    const stateWithTaskEvidence: SessionState = {
      // Persist the PEER_REVIEW transition materialized by startReviewFlow so the
      // canonical session state reflects the active review obligation. The
      // completion path continues an existing PEER_REVIEW rather than re-starting
      // the user-level /review command (which would require READY).
      ...result.state,
      // Obligation preparation already persisted the obligation AND its attempt.
      // Re-deriving from `state` (read before that write) dropped the attempt, so
      // the host could never bind reviewer evidence for a standalone /review.
      ...(prepared.persistedAssurance && { reviewAssurance: prepared.persistedAssurance }),
      peerReviewEvidence: taskEvidence
        ? appendPreparedReviewEvidence(state.peerReviewEvidence, taskEvidence)
        : state.peerReviewEvidence,
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
    });
    if (typeof prepared === 'string') return prepared;

    if (isBlockedReviewResult(reviewResult)) {
      return formatBlockedReviewReport(reviewResult);
    }

    let result = consumeValidatedReviewObligation(
      prepared.result,
      prepared.validatedReviewObligation,
      now,
      {
        acceptedInvocationId: prepared.evidenceInvocationId,
        effectiveReviewFindings: prepared.effectiveReviewFindings,
      },
    );
    const obligationIdentity = prepared.pendingObligation ?? prepared.validatedReviewObligation;
    const taskEvidence = obligationIdentity
      ? preparePeerReviewEvidence(
          args,
          now,
          prepared.refInput,
          resolveReviewTaskIdentity(state.peerReviewEvidence, obligationIdentity.obligationId)
            .reviewTaskId,
          obligationIdentity.obligationId,
        )
      : null;
    result = {
      ...result,
      state: {
        ...result.state,
        peerReviewEvidence: taskEvidence
          ? appendCompletedReviewEvidence({
              evidence: state.peerReviewEvidence,
              prepared: taskEvidence,
              completedAt: now,
              findings: prepared.effectiveReviewFindings,
            })
          : state.peerReviewEvidence,
      },
    };
    const completion = await persistReviewCompletion(
      sessDir,
      result,
      reviewResult,
      ctx,
      prepared.validatedReviewObligation,
    );
    if (completion.kind === 'overflow') {
      return formatAutoAdvanceOverflow(completion.overflow);
    }
    return buildReviewCompletionResponse({
      sessDir,
      result,
      report: completion.report,
      validatedReviewObligation: prepared.validatedReviewObligation,
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
    'Start the peer review flow. Transitions READY → PEER_REVIEW → PEER_REVIEW_COMPLETE. ' +
    'Generates a peer review report with explicit target coverage (resolved/frozen target, ' +
    'base/head revisions, changed paths, objectives, review assurance) and findings, ' +
    'written to the session directory. ' +
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
        'Exact obligation ID from requiredReviewAttestation.toolObligationId. Required when consuming captured structured findings.',
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
        buildReviewExecutors(prepared.effectiveReviewFindings),
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
