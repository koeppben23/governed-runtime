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
  formatRailResult,
  formatError,
  formatAutoAdvanceOverflow,
  formatBlocked,
} from '../helpers.js';
import {
  startReviewFlow,
  executeReview,
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
  matchesReviewObligationInput,
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
import { findReviewObligationById } from '../../review/assurance.js';
import { writeStateWithArtifacts } from '../helpers.js';

// ─── Content Digest Binding ─────────────────────────────────────────────────

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

function populateBranchRefInput(
  refInput: ReviewReferenceInput | undefined,
  source: {
    branch: string;
    baseBranch: string;
    resolvedBranchSha: string;
    resolvedBaseSha: string;
  },
): ReviewReferenceInput {
  return {
    ...refInput,
    branch: source.branch,
    baseBranch: source.baseBranch,
    resolvedBranchSha: source.resolvedBranchSha,
    resolvedBaseSha: source.resolvedBaseSha,
  };
}

async function prepareReviewExecution(
  sessDir: string,
  state: SessionState,
  result: StartedReviewResult,
  exec: ReviewExecutionContext,
): Promise<ReviewPreparation | string> {
  // Resolve immutable branch source only when creating an obligation. An explicit
  // host-task continuation is bound to its existing obligation and must not re-resolve refs.
  const isFindingsSubmission = exec.args.reviewFindings !== undefined;
  const isHostTaskVerdictContinuation =
    exec.policy === 'host_task_required' &&
    exec.args.reviewVerdict !== undefined &&
    exec.args.reviewObligationId !== undefined;
  const resolvedSource =
    exec.args.branch && !isFindingsSubmission && !isHostTaskVerdictContinuation
      ? resolveBranchReviewSource(exec.args.branch)
      : undefined;

  const hostTaskVerdict = prepareHostTaskVerdictReview(state, result, exec);
  if (hostTaskVerdict) return hostTaskVerdict;

  const missingResult = await ensureMissingAnalysisObligation(
    sessDir,
    state,
    exec.args,
    exec.now,
    resolvedSource,
  );

  let refInput = buildReviewReferenceInput(exec.args);
  if (resolvedSource) {
    refInput = populateBranchRefInput(refInput, resolvedSource);
  }
  if (resolvedSource && missingResult.obligation) {
    refInput = {
      ...refInput,
      reviewObligationId: missingResult.obligation.obligationId,
    };
  }
  if (exec.args.reviewFindings === undefined) {
    return {
      result,
      refInput,
      validatedReviewObligation: null,
      pendingObligation: missingResult.obligation,
      blockMessage: missingResult.message ?? undefined,
    };
  }
  return finishFindingsSubmission(sessDir, state, result, exec, refInput);
}

async function finishFindingsSubmission(
  sessDir: string,
  state: SessionState,
  result: StartedReviewResult,
  exec: ReviewExecutionContext,
  refInput: ReviewReferenceInput | undefined,
): Promise<ReviewPreparation | string> {
  const resolved = await resolveSubmittedReviewObligation(sessDir, state, exec.args, exec.now);
  if (resolved.blocked || !resolved.obligation) {
    return resolved.blocked ?? formatBlocked('REVIEW_OBLIGATION_NOT_FOUND', {});
  }
  const validationBlock = validateSubmittedReviewFindings(exec.args, resolved.obligation);
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

function validateHostTaskObligationInput(
  obligation: ReviewObligation,
  args: ReviewToolArgs,
): string | null {
  if (!matchesReviewObligationInput(obligation, args)) {
    return formatBlocked('REVIEW_OBLIGATION_INPUT_MISMATCH', {
      obligationId: obligation.obligationId,
      reason: 'The supplied review input does not match the host-task review obligation.',
    });
  }
  return null;
}

function getHostTaskVerdictContinuation(
  exec: ReviewExecutionContext,
): { reviewObligationId: string; reviewVerdict: 'accept' | 'changes_requested' } | null {
  if (exec.policy !== 'host_task_required') return null;
  const { reviewObligationId, reviewVerdict } = exec.args;
  if (reviewObligationId === undefined || reviewVerdict === undefined) return null;
  return { reviewObligationId, reviewVerdict };
}

function prepareHostTaskVerdictReview(
  state: SessionState,
  result: StartedReviewResult,
  exec: ReviewExecutionContext,
): ReviewPreparation | string | null {
  // A verdict without an ID is an allowed first call. It must create (or reissue
  // instructions for) an obligation rather than guessing a continuation identity.
  const continuation = getHostTaskVerdictContinuation(exec);
  if (!continuation) return null;
  if (!hasReviewContentInput(exec.args)) return null;

  const resolution = resolveHostTaskObligation(state, continuation.reviewObligationId);
  if (resolution.kind === 'missing') {
    return formatBlocked('REVIEW_OBLIGATION_NOT_FOUND', {
      obligationId: continuation.reviewObligationId,
      reason: 'The host-task review obligation is missing, consumed, or blocked.',
    });
  }

  const obligation = resolution.obligation;
  const inputBlock = validateHostTaskObligationInput(obligation, exec.args);
  if (inputBlock) return inputBlock;
  const resolved = resolveHostTaskFindings(state.reviewAssurance, obligation);

  if (resolved.kind === 'incoherent') {
    // F12: the host-captured record is internally self-contradictory
    // (accept + blocking issues). Fail closed with the canonical coherence
    // reason code — not the generic HOST_SUBAGENT_TASK_REQUIRED catch-all
    // whose recovery message would mislead about evidence availability.
    return formatBlocked('SUBAGENT_VERDICT_FINDINGS_INCOHERENT', {
      count: String(resolved.blockingIssueCount),
    });
  }

  if (resolved.kind !== 'resolved') {
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
      },
    );
  }

  if (resolved.findings.overallVerdict === 'unable_to_review') {
    return formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', {
      obligationId: resolved.invocation.obligationId,
    });
  }

  if (continuation.reviewVerdict !== resolved.findings.overallVerdict) {
    return formatBlocked('SUBAGENT_FINDINGS_VERDICT_MISMATCH', {
      provided: continuation.reviewVerdict,
      expected: resolved.findings.overallVerdict,
    });
  }

  const refInput = buildReviewReferenceInput(exec.args);
  return {
    result,
    refInput: refInput ? { ...refInput, skipExternalContentLoad: true } : undefined,
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
    const result = startReviewFlow(state, ctx);

    if (result.kind === 'blocked') return String(formatRailResult(result));

    const prepared = await prepareReviewExecution(sessDir, state, result, {
      args,
      context,
      now,
      policy: state.policySnapshot?.reviewInvocationPolicy ?? 'host_task_required',
    });
    if (typeof prepared === 'string') return prepared;
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
    let result = startReviewFlow(state, ctx);
    if (result.kind === 'blocked') return String(formatRailResult(result));

    const prepared = await prepareReviewExecution(sessDir, state, result, {
      args,
      context,
      now,
      policy: state.policySnapshot?.reviewInvocationPolicy ?? 'host_task_required',
    });
    if (typeof prepared === 'string') return prepared;

    if (reviewResult.kind === 'blocked') {
      return formatBlockedReviewReport(reviewResult);
    }

    result = consumeValidatedReviewObligation(
      prepared.result,
      prepared.validatedReviewObligation,
      args,
      now,
      prepared.evidenceInvocationId,
    );
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
    });
  });
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
  },
  async execute(args: ReviewToolArgs, context) {
    try {
      const prepared = await prepareReviewWithoutExternalCalls(args, context);
      if (typeof prepared === 'string') return prepared;

      // Load external content and compute the content digest
      const contentResult = await prepareReviewContent(
        prepared.refInput,
        undefined /* dnsLookup */,
      );
      if (contentResult && 'kind' in contentResult) {
        return formatBlockedReviewReport(contentResult);
      }

      // Bind the content digest to the obligation before any further action.
      // First-call paths use pendingObligation; findings-submission uses validatedReviewObligation.
      const bindTarget = prepared.pendingObligation ?? prepared.validatedReviewObligation;
      let reviewState = prepared.result.state;
      if (contentResult?.reviewedContentDigest && bindTarget?.obligationId) {
        reviewState = await bindReviewContentDigest(
          context,
          bindTarget.obligationId,
          contentResult.reviewedContentDigest,
        );
      }

      // Return the blocking message AFTER content loading and digest binding,
      // so the obligation is fully prepared for the reviewer.
      if (prepared.blockMessage) return prepared.blockMessage;

      const reviewResult = await executeReview(
        reviewState,
        prepared.now,
        buildReviewExecutors(args, prepared.effectiveReviewFindings),
        prepared.refInput,
        contentResult?.content,
      );
      return await persistCompletedReview(args, context, reviewResult, prepared.now);
    } catch (err) {
      return formatError(err);
    }
  },
};
