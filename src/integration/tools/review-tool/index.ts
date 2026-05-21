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
import { withMutableSession, formatRailResult, formatError } from '../helpers.js';
import { startReviewFlow, executeReview } from '../../../rails/review.js';
import {
  InputOriginSchema,
  ExternalReferenceSchema,
  ReviewFindings,
} from '../../../state/evidence.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import type { ReviewExecutionContext, ReviewPreparation } from './types.js';
import type { StartedReviewResult } from './types.js';
import type { SessionState } from '../../../state/schema.js';
import type { ReviewToolArgs } from './types.js';
import {
  buildReviewReferenceInput,
  ensureMissingAnalysisObligation,
  resolveSubmittedReviewObligation,
  validateSubmittedReviewFindings,
  consumeValidatedReviewObligation,
} from './obligation.js';
import { recordSubmittedReviewInvocation } from './invocation.js';
import {
  buildReviewExecutors,
  formatBlockedReviewReport,
  persistReviewCompletion,
  buildReviewCompletionResponse,
} from './completion.js';

// ─── Review preparation orchestrator ─────────────────────────────────────────

async function prepareReviewExecution(
  sessDir: string,
  state: SessionState,
  result: StartedReviewResult,
  exec: ReviewExecutionContext,
): Promise<ReviewPreparation | string> {
  const missingAnalysis = await ensureMissingAnalysisObligation(
    sessDir,
    state,
    exec.args,
    exec.now,
  );
  if (missingAnalysis) return missingAnalysis;

  let refInput = buildReviewReferenceInput(exec.args);
  if (exec.args.reviewFindings === undefined) {
    return { result, refInput, validatedReviewObligation: null };
  }

  const resolved = await resolveSubmittedReviewObligation(sessDir, state, exec.args, exec.now);
  if (resolved.blocked) return resolved.blocked;
  const validationBlock = validateSubmittedReviewFindings(exec.args, resolved.obligation);
  if (validationBlock) return validationBlock;
  const recorded = recordSubmittedReviewInvocation(result, resolved.obligation, exec);
  if (recorded.blocked) return recorded.blocked;
  if (refInput) refInput = { ...refInput, skipExternalContentLoad: true };
  return { result: recorded.result, refInput, validatedReviewObligation: resolved.obligation };
}

// ─── Tool definition ─────────────────────────────────────────────────────────

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
    reviewFindings: ReviewFindings.optional().describe(
      `Complete findings from ${REVIEWER_SUBAGENT_TYPE} subagent analysis. ` +
        'Required when content-aware fields (text/prNumber/branch/url) are provided. ' +
        'Must include reviewMode="subagent", reviewedBy, and valid attestation with ' +
        'mandateDigest and criteriaVersion.',
    ),
  },
  async execute(args: ReviewToolArgs, context) {
    try {
      const { sessDir, state, ctx } = await withMutableSession(context);
      const now = new Date().toISOString();
      let result = startReviewFlow(state, ctx);

      if (result.kind === 'blocked') return formatRailResult(result);

      const prepared = await prepareReviewExecution(sessDir, state, result, {
        args,
        context,
        now,
        policy: state.policySnapshot?.reviewInvocationPolicy ?? 'host_task_required',
      });
      if (typeof prepared === 'string') return prepared;

      result = prepared.result;
      const reviewResult = await executeReview(
        result.state,
        now,
        buildReviewExecutors(args),
        prepared.refInput,
      );
      if (reviewResult.kind === 'blocked') {
        return formatBlockedReviewReport(reviewResult);
      }
      result = consumeValidatedReviewObligation(
        result,
        prepared.validatedReviewObligation,
        args,
        now,
      );
      const completion = await persistReviewCompletion(sessDir, result, reviewResult, ctx);
      return buildReviewCompletionResponse({
        sessDir,
        args,
        result,
        report: reviewResult,
        validatedReviewObligation: prepared.validatedReviewObligation,
        ...completion,
      });
    } catch (err) {
      return formatError(err);
    }
  },
};
