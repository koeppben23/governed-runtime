import { z } from 'zod';
import type { ToolDefinition, ToolContext } from './helpers.js';
import {
  formatError,
  withMutableSession,
  withMutableSessionTransaction,
  formatBlocked,
} from './helpers.js';
import { ReviewFindings as ReviewFindingsSchema } from '../../state/evidence.js';
import {
  resolveImplementationCandidate,
  resolveImplementationCandidateIdentity,
} from '../implementation-candidate.js';
import { changedFiles } from '../../adapters/git.js';
import {
  type ImplementArgs,
  buildImplementRuntime,
  validateImplementSequence,
} from './implement-shared.js';
import {
  handleImplRecord,
  validateImplRecordPrerequisites,
  validateInitialReviewFindings,
  scopeImplementationFiles,
} from './implement-record.js';
import { handleImplReview } from './implement-review.js';

/**
 * Record-mode execution: persist implementation evidence (auto-detected via git).
 * Carries no verdict — that is the sole job of `flowguard_review_implementation`.
 */
async function executeImplementRecord(context: ToolContext): Promise<string> {
  const args: ImplementArgs = {};
  const probe = await withMutableSession(context);
  const probeRuntime = buildImplementRuntime({ args, context, ...probe });
  const sequenceBlocked = validateImplementSequence(args, probe.state);
  if (sequenceBlocked) return sequenceBlocked;
  const prereqBlocked = validateImplRecordPrerequisites(probeRuntime);
  if (prereqBlocked) return prereqBlocked;
  const findingsBlocked = validateInitialReviewFindings(probeRuntime);
  if (findingsBlocked) return findingsBlocked;

  // Resolve the candidate outside the session write lock. Baseline attribution
  // uses the probe's state snapshot; the worktree is not expected to change
  // between probe and transaction entry (TOCTOU is rechecked inside the lock).
  const rawFiles = await changedFiles(probe.worktree);
  const scoped = await scopeImplementationFiles(
    probe.worktree,
    rawFiles,
    probe.state.implementationBaseline,
  );
  if ('block' in scoped) return scoped.block;
  const { files: scopedPaths, baselineScoping } = scoped;

  const captured = await resolveImplementationCandidate(probe.worktree, scopedPaths);
  if (!captured) {
    return formatBlocked('IMPLEMENTATION_EVIDENCE_EMPTY', {
      reason: 'no changed files detected in worktree after baseline scoping',
    });
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
      const freshSequenceBlocked = validateImplementSequence(args, state);
      if (freshSequenceBlocked) return freshSequenceBlocked;
      const freshPrereqBlocked = validateImplRecordPrerequisites(runtime);
      if (freshPrereqBlocked) return freshPrereqBlocked;
      const freshFindingsBlocked = validateInitialReviewFindings(runtime);
      if (freshFindingsBlocked) return freshFindingsBlocked;

      // TOCTOU re-verification: the worktree must not have changed between
      // candidate capture and transaction acquisition.
      const currentIdentity = await resolveImplementationCandidateIdentity(worktree, scopedPaths);
      if (
        !currentIdentity ||
        captured.identity.candidateDigest !== currentIdentity.candidateDigest
      ) {
        return formatBlocked('IMPLEMENTATION_CANDIDATE_CHANGED_DURING_CAPTURE');
      }

      return handleImplRecord(runtime, captured, baselineScoping);
    },
  );
}

/**
 * Verdict-mode execution: submit the independent reviewer's verdict on the
 * recorded implementation. `reviewVerdict` is required on this tool.
 */
async function executeReviewImplementation(
  args: ImplementArgs,
  context: ToolContext,
): Promise<string> {
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
      const sequenceBlocked = validateImplementSequence(args, state);
      if (sequenceBlocked) return sequenceBlocked;
      return handleImplReview(runtime);
    },
  );
}

export const implement: ToolDefinition = {
  description:
    'Record implementation evidence. Auto-detects changed files via git. ' +
    'Use AFTER making code changes with read/write/bash tools. Takes no arguments.\n' +
    'On success, auto-advances to IMPL_REVIEW. To submit the reviewer verdict, ' +
    'use the separate flowguard_review_implementation tool (issue #565: record and ' +
    'verdict are distinct single-purpose tools).',
  // Record mode takes NO arguments. The empty (strict) schema makes it
  // impossible to send a verdict on a record call — the previously-conflated
  // multi-mode failure state is now unrepresentable at the tool surface.
  args: {},
  async execute(_args, context) {
    try {
      return await executeImplementRecord(context);
    } catch (err) {
      return formatError(err);
    }
  },
};

export const review_implementation: ToolDefinition = {
  description:
    "Submit the INDEPENDENT REVIEWER's verdict on the recorded implementation — " +
    'NOT user approval. Use at IMPL_REVIEW after the flowguard-reviewer subagent has ' +
    'reviewed the implementation recorded by flowguard_implement.\n' +
    "reviewVerdict is required for a reviewer result: 'accept' = the reviewer accepts the implementation; the loop " +
    'converges and advances to the EVIDENCE_REVIEW user gate (the user still approves via ' +
    "/review-decision). 'changes_requested' = the implementation needs revision; make changes " +
    'then re-record with flowguard_implement.\n' +
    'Review loop runs up to maxIterations (from policy). ' +
    'Optionally accepts reviewFindings from the independent review agent. Under host_task_preferred only, ' +
    'reviewerUnavailable without a verdict or findings reports an actual OpenCode Task transport failure and ' +
    'requests the configured SDK transport; it never approves or persists review evidence.',
  args: {
    reviewVerdict: z
      .enum(['accept', 'changes_requested'])
      .optional()
      .describe(
        "The INDEPENDENT REVIEWER's verdict on the implementation — NOT user approval. " +
          'Required unless reporting an actual host Task transport failure with reviewerUnavailable: true. ' +
          "'accept' = the reviewer accepts the implementation; the loop converges and " +
          'advances to the EVIDENCE_REVIEW user gate (the user still approves via /review-decision). ' +
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
          'unavailable). With host_task_preferred, use it alone at IMPL_REVIEW to request the configured ' +
          'SDK transport. With host_task_required it fails closed. It never enables self-review or approval.',
      ),
  },
  async execute(args, context) {
    try {
      return await executeReviewImplementation(args as ImplementArgs, context);
    } catch (err) {
      return formatError(err);
    }
  },
};
