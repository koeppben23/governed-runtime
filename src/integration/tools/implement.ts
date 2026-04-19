/**
 * @module integration/tools/implement
 * @description FlowGuard implement tool — record implementation or review verdict.
 *
 * Multi-call pattern driven by the LLM:
 *
 * Step 1: LLM makes code changes using OpenCode built-in tools (read, write, bash)
 * Step 2: LLM calls flowguard_implement({})
 *   -> Tool auto-detects changed files via git, records ImplEvidence
 *   -> Auto-advances to IMPL_REVIEW
 *   -> Returns "review needed"
 *
 * Step 3: LLM reviews the implementation
 * Step 4: LLM calls flowguard_implement({ reviewVerdict: "approve" })
 *   -> Tool records review iteration, checks convergence
 *   -> On convergence: auto-advance to EVIDENCE_REVIEW
 *
 * OR Step 4: LLM calls flowguard_implement({ reviewVerdict: "changes_requested" })
 *   -> LLM makes more code changes, then calls flowguard_implement({}) again
 *
 * @version v3
 */

import { z } from 'zod';

import type { ToolDefinition } from './helpers';
import {
  resolveWorkspacePaths,
  requireStateForMutation,
  resolvePolicyFromState,
  createPolicyContext,
  formatEval,
  formatBlocked,
  formatError,
  appendNextAction,
  writeStateWithArtifacts,
} from './helpers';

// State & Machine
import type { SessionState } from '../../state/schema';
import { evaluate } from '../../machine/evaluate';
import { isCommandAllowed, Command } from '../../machine/commands';

// Rail helpers
import { autoAdvance } from '../../rails/types';

// Adapters
import { changedFiles } from '../../adapters/git';

// Evidence types
import type { LoopVerdict, RevisionDelta } from '../../state/evidence';

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_implement — Record Implementation OR Impl Review Verdict
// ═══════════════════════════════════════════════════════════════════════════════

export const implement: ToolDefinition = {
  description:
    'Record implementation evidence OR submit implementation review verdict. Two modes:\n' +
    'Mode A (record impl): no reviewVerdict. Auto-detects changed files via git. ' +
    'Use AFTER making code changes with read/write/bash tools.\n' +
    "Mode B (review verdict): provide reviewVerdict ('approve' or 'changes_requested'). " +
    'Use at IMPL_REVIEW after reviewing the implementation.\n' +
    'Review loop runs up to maxIterations (from policy). ' +
    'On convergence, auto-advances to EVIDENCE_REVIEW.',
  args: {
    reviewVerdict: z
      .enum(['approve', 'changes_requested'])
      .optional()
      .describe(
        'Implementation review verdict. Omit to record implementation evidence. ' +
          "'approve' = implementation is correct. " +
          "'changes_requested' = implementation needs revision.",
      ),
  },
  async execute(args, context) {
    try {
      const { worktree, sessDir } = await resolveWorkspacePaths(context);
      const state = await requireStateForMutation(sessDir);
      const policy = resolvePolicyFromState(state);
      const ctx = createPolicyContext(policy);
      const maxImplReviewIterations = policy.maxImplReviewIterations;

      const isRecordImpl = !args.reviewVerdict;

      if (isRecordImpl) {
        // ── Mode A: Record implementation evidence ───────────────
        if (!isCommandAllowed(state.phase, Command.IMPLEMENT)) {
          return formatBlocked('COMMAND_NOT_ALLOWED', {
            command: '/implement',
            phase: state.phase,
          });
        }

        if (!state.ticket) {
          return formatBlocked('TICKET_REQUIRED', { action: 'implementation' });
        }
        if (!state.plan) {
          return formatBlocked('PLAN_REQUIRED', { action: 'implementation' });
        }

        // Auto-detect changed files via git
        const files = await changedFiles(worktree);
        // Separate domain files (non-config, non-test, non-infrastructure)
        const domainFiles = files.filter(
          (f) => !f.startsWith('.opencode/') && !f.includes('node_modules/'),
        );

        const implEvidence = {
          changedFiles: files,
          domainFiles,
          digest: ctx.digest(files.sort().join('\n')),
          executedAt: ctx.now(),
        };

        const nextState: SessionState = {
          ...state,
          implementation: implEvidence,
          implReview: null,
          error: null,
        };

        // Auto-advance to IMPL_REVIEW (policy-aware)
        const evalFn = (s: SessionState) => evaluate(s, policy);
        const {
          state: finalState,
          evalResult: ev,
          transitions,
        } = autoAdvance(nextState, evalFn, ctx);
        await writeStateWithArtifacts(sessDir, finalState);

        return appendNextAction(
          JSON.stringify({
            phase: finalState.phase,
            status: `Implementation recorded. ${files.length} files changed, ${domainFiles.length} domain files.`,
            changedFiles: files,
            domainFiles,
            next:
              'Review the implementation against the plan. Check correctness, completeness, ' +
              'edge cases, and code quality. Then call flowguard_implement with reviewVerdict.',
            _audit: { transitions },
          }),
          finalState,
        );
      } else {
        // ── Mode B: Implementation review verdict ────────────────
        if (state.phase !== 'IMPL_REVIEW') {
          return formatBlocked('WRONG_PHASE', { phase: state.phase });
        }

        if (!state.implementation) {
          return formatBlocked('NO_IMPLEMENTATION');
        }

        const iteration = (state.implReview?.iteration ?? 0) + 1;
        const verdict = args.reviewVerdict as LoopVerdict;
        const prevDigest = state.implementation.digest;

        // For changes_requested, the LLM should make changes and call
        // flowguard_implement({}) again (Mode A). Here we just record
        // the review verdict.
        const revisionDelta: RevisionDelta = 'none';

        const nextState: SessionState = {
          ...state,
          implReview: {
            iteration,
            maxIterations: maxImplReviewIterations,
            prevDigest,
            currDigest: state.implementation.digest,
            revisionDelta,
            verdict,
            executedAt: ctx.now(),
          },
          error: null,
        };

        // Evaluate + autoAdvance (policy-aware)
        const evalFn = (s: SessionState) => evaluate(s, policy);
        const {
          state: finalState,
          evalResult: ev,
          transitions,
        } = autoAdvance(nextState, evalFn, ctx);
        await writeStateWithArtifacts(sessDir, finalState);

        const converged =
          iteration >= maxImplReviewIterations ||
          (revisionDelta === 'none' && verdict === 'approve');

        if (converged && verdict === 'approve') {
          return appendNextAction(
            JSON.stringify({
              phase: finalState.phase,
              status: `Implementation review converged at iteration ${iteration}. Approved.`,
              implReviewIteration: iteration,
              next: formatEval(ev),
              _audit: { transitions },
            }),
            finalState,
          );
        }

        if (verdict === 'changes_requested') {
          return appendNextAction(
            JSON.stringify({
              phase: finalState.phase,
              status: `Implementation review iteration ${iteration}/${maxImplReviewIterations}. Changes requested.`,
              implReviewIteration: iteration,
              next:
                'Make the requested code changes using read/write/bash tools, ' +
                'then call flowguard_implement (without reviewVerdict) to re-record the implementation.',
              _audit: { transitions },
            }),
            finalState,
          );
        }

        // Forced convergence (max iterations reached, verdict was not approve)
        return appendNextAction(
          JSON.stringify({
            phase: finalState.phase,
            status: `Implementation review reached max iterations (${iteration}/${maxImplReviewIterations}). Force-converged.`,
            implReviewIteration: iteration,
            next: formatEval(ev),
            _audit: { transitions },
          }),
          finalState,
        );
      }
    } catch (err) {
      return formatError(err);
    }
  },
};
