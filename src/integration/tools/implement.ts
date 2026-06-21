import { z } from 'zod';
import type { ToolDefinition, ToolContext } from './helpers.js';
import { formatError, withMutableSession, withMutableSessionTransaction } from './helpers.js';
import { ReviewFindings as ReviewFindingsSchema } from '../../state/evidence.js';
import { changedFiles } from '../../adapters/git.js';
import {
  type ImplementArgs,
  classifyImplementArgs,
  buildImplementRuntime,
  validateImplementSequence,
} from './implement-shared.js';
import {
  handleImplRecord,
  validateImplRecordPrerequisites,
  validateInitialReviewFindings,
} from './implement-record.js';
import { handleImplReview } from './implement-review.js';

async function executeImplement(args: ImplementArgs, context: ToolContext): Promise<string> {
  const flags = classifyImplementArgs(args);

  if (flags.isRecordImpl) {
    const probe = await withMutableSession(context);
    const probeRuntime = buildImplementRuntime({ args, context, ...probe });
    const sequenceBlocked = validateImplementSequence(
      args,
      probe.state,
      flags.hasVerdict,
      flags.hasFindings,
    );
    if (sequenceBlocked) return sequenceBlocked;
    const prereqBlocked = validateImplRecordPrerequisites(probeRuntime);
    if (prereqBlocked) return prereqBlocked;
    const findingsBlocked = validateInitialReviewFindings(probeRuntime);
    if (findingsBlocked) return findingsBlocked;

    // Git/worktree inspection can be slow and must not hold the session write lock.
    const files = await changedFiles(probe.worktree);
    return withMutableSessionTransaction(
      context,
      async ({ worktree, sessDir, state, policy, ctx }) => {
        const runtime = buildImplementRuntime({
          args,
          context,
          worktree,
          sessDir,
          state,
          policy,
          ctx,
        });
        const freshSequenceBlocked = validateImplementSequence(
          args,
          state,
          flags.hasVerdict,
          flags.hasFindings,
        );
        if (freshSequenceBlocked) return freshSequenceBlocked;
        const freshPrereqBlocked = validateImplRecordPrerequisites(runtime);
        if (freshPrereqBlocked) return freshPrereqBlocked;
        const freshFindingsBlocked = validateInitialReviewFindings(runtime);
        if (freshFindingsBlocked) return freshFindingsBlocked;
        return handleImplRecord(runtime, files);
      },
    );
  }

  return withMutableSessionTransaction(
    context,
    async ({ worktree, sessDir, state, policy, ctx }) => {
      const runtime = buildImplementRuntime({
        args,
        context,
        worktree,
        sessDir,
        state,
        policy,
        ctx,
      });
      const sequenceBlocked = validateImplementSequence(
        args,
        state,
        flags.hasVerdict,
        flags.hasFindings,
      );
      if (sequenceBlocked) return sequenceBlocked;

      return handleImplReview(runtime);
    },
  );
}

export const implement: ToolDefinition = {
  description:
    'Record implementation evidence OR submit implementation review verdict. Two modes:\n' +
    'Mode A (record impl): no reviewVerdict. Auto-detects changed files via git. ' +
    'Use AFTER making code changes with read/write/bash tools.\n' +
    "Mode B (review verdict): provide reviewVerdict ('accept' or 'changes_requested'). " +
    'Use at IMPL_REVIEW after reviewing the implementation.\n' +
    'Review loop runs up to maxIterations (from policy). ' +
    'On convergence, auto-advances to EVIDENCE_REVIEW.\n' +
    'Optionally accepts reviewFindings from an independent review agent.',
  args: {
    reviewVerdict: z
      .enum(['accept', 'changes_requested'])
      .optional()
      .describe(
        "The INDEPENDENT REVIEWER's verdict on the implementation — NOT user approval. " +
          'Omit to record implementation evidence. ' +
          "'accept' = the reviewer accepts the implementation; the loop converges and advances " +
          'to the EVIDENCE_REVIEW user gate (the user still approves via /review-decision). ' +
          "'changes_requested' = the implementation needs revision.",
      ),
    reviewFindings: ReviewFindingsSchema.optional().describe(
      "The reviewer's structured findings. SDK mode only — pass the reviewer output verbatim. " +
        'In host-task mode do NOT submit reviewFindings: the plugin resolves them from captured ' +
        'evidence, and hand-edited or mismatched findings are rejected.',
    ),
    reviewerUnavailable: z
      .boolean()
      .optional()
      .describe(
        'Set to true ONLY after a real reviewer-subagent spawn failure (Task tool fails, agent ' +
          'unavailable). This is a fail-closed signal: FlowGuard blocks with SUBAGENT_UNABLE_TO_REVIEW ' +
          'and recovery guidance. It never enables self-review and never approves the implementation.',
      ),
  },
  async execute(args, context) {
    try {
      return await executeImplement(args, context);
    } catch (err) {
      return formatError(err);
    }
  },
};
