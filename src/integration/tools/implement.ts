/**
 * @module integration/tools/implement
 * @description FlowGuard implement tool — record implementation or review verdict.
 *
 * Agent-Orchestrated Independent Review for /implement
 *
 * Architecture: FlowGuard does NOT call subagents. The OpenCode primary agent
 * orchestrates independent review by calling the flowguard-reviewer subagent
 * via the Task tool. FlowGuard accepts, validates, and persists the resulting
 * ReviewFindings.
 *
 * Flow (subagentEnabled=true):
 * 1. Primary agent performs implementation work
 * 2. Primary agent calls flowguard_implement (Mode A, records evidence)
 * 3. FlowGuard returns next-action instructing subagent invocation
 * 4. Primary agent calls flowguard-reviewer subagent via Task tool
 * 5. Subagent returns structured ReviewFindings
 * 6. Primary agent submits reviewVerdict + reviewFindings to FlowGuard (Mode B)
 * 7. FlowGuard validates and persists both (append-only, separate)
 *
 * Tool responsibilities:
 * - Input validation: reviewFindings vs policy, iteration binding
 * - Persistence: impl history (author), implReviewFindings (reviewer)
 * - Response: summary of review findings
 * - Next-action: independent reviewer instructions
 *
 * Policy config (selfReview):
 * - subagentEnabled: enforces subagent review mode
 * - fallbackToSelf: deprecated compatibility field; self-review fallback is prohibited
 *
 * Validation rules:
 * - reviewMode=self → BLOCKED
 * - reviewVerdict=approve + missing reviewFindings → BLOCKED
 * - reviewFindings.iteration mismatch → BLOCKED
 *
 * Multi-call pattern driven by the LLM:
 *
 * Step 1: LLM makes code changes using OpenCode built-in tools (read, write, bash)
 * Step 2: LLM calls flowguard_implement({})
 *   -> Tool auto-detects changed files via git, records ImplEvidence
 *   -> Auto-advances to IMPL_REVIEW
 *   -> Returns "review needed" with policy-conditional next-action
 *
 * Step 3: LLM calls flowguard-reviewer subagent via Task tool
 * Step 4: LLM calls flowguard_implement({ reviewVerdict: "approve", reviewFindings })
 *   -> Tool records review iteration, checks convergence
 *   -> On convergence: auto-advance to EVIDENCE_REVIEW
 *
 * OR Step 4: LLM calls flowguard_implement({ reviewVerdict: "changes_requested" })
 *   -> LLM makes more code changes, then calls flowguard_implement({}) again
 *
 * @version v5
 */

import { z } from 'zod';

import type { ToolDefinition } from './helpers.js';
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
} from './helpers.js';

// State & Machine
import type { SessionState } from '../../state/schema.js';
import { evaluate, evaluateWithEvent } from '../../machine/evaluate.js';
import { isCommandAllowed, Command } from '../../machine/commands.js';

// Rail helpers
import { applyTransition, autoAdvance } from '../../rails/types.js';

// Adapters
import { changedFiles } from '../../adapters/git.js';

// Evidence types
import type { LoopVerdict, RevisionDelta, ReviewFindings } from '../../state/evidence.js';
import { ReviewFindings as ReviewFindingsSchema } from '../../state/evidence.js';

// Review findings validation (shared with plan.ts)
import { validateReviewFindings, requireReviewFindings } from './review-validation.js';
import {
  appendReviewObligation,
  consumeReviewObligation,
  createReviewObligation,
  findLatestObligation,
  reviewObligationResponseFields,
} from '../review-assurance.js';

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_implement — Record Implementation OR Impl Review Verdict
// ═══════════════════════════════════════════════════════════════════════════════

function nextImplementationReviewIteration(state: SessionState): number {
  let latest = state.implReview?.iteration ?? 0;
  for (const findings of state.implReviewFindings ?? []) {
    latest = Math.max(latest, findings.iteration);
  }
  return latest + 1;
}

export const implement: ToolDefinition = {
  description:
    'Record implementation evidence OR submit implementation review verdict. Two modes:\n' +
    'Mode A (record impl): no reviewVerdict. Auto-detects changed files via git. ' +
    'Use AFTER making code changes with read/write/bash tools.\n' +
    "Mode B (review verdict): provide reviewVerdict ('approve' or 'changes_requested'). " +
    'Use at IMPL_REVIEW after reviewing the implementation.\n' +
    'Review loop runs up to maxIterations (from policy). ' +
    'On convergence, auto-advances to EVIDENCE_REVIEW.\n' +
    'Optionally accepts reviewFindings from an independent review agent.',
  args: {
    reviewVerdict: z
      .enum(['approve', 'changes_requested'])
      .optional()
      .describe(
        'Implementation review verdict. Omit to record implementation evidence. ' +
          "'approve' = implementation is correct. " +
          "'changes_requested' = implementation needs revision.",
      ),
    reviewFindings: ReviewFindingsSchema.optional().describe(
      'Structured review findings from independent review. ' +
        'Required when reviewVerdict is "approve" and subagentEnabled=true.',
    ),
  },
  async execute(args, context) {
    try {
      const { worktree, sessDir } = await resolveWorkspacePaths(context);
      const state = await requireStateForMutation(sessDir);
      const policy = resolvePolicyFromState(state);
      const ctx = createPolicyContext(policy);
      const maxImplReviewIterations = policy.maxImplReviewIterations;

      // Policy config for review findings validation
      const subagentEnabled = policy.selfReview?.subagentEnabled ?? false;
      const fallbackToSelf = policy.selfReview?.fallbackToSelf ?? false;
      const strictEnforcement = policy.selfReview?.strictEnforcement ?? false;
      const hasVerdict = args.reviewVerdict !== undefined;
      const hasFindings = args.reviewFindings !== undefined;
      const isRecordImpl = !hasVerdict;

      // Runtime sequence contract: implementation evidence and review verdict are separate phases.
      if (hasFindings && !hasVerdict) {
        return formatBlocked('INVALID_IMPLEMENT_TOOL_SEQUENCE');
      }

      if (hasVerdict && !state.implementation) {
        return formatBlocked('IMPLEMENTATION_EVIDENCE_REQUIRED');
      }

      if (hasVerdict && state.phase !== 'IMPL_REVIEW') {
        return formatBlocked('IMPLEMENT_REVIEW_LOOP_REQUIRED', { phase: state.phase });
      }

      // Validate review findings for Mode A
      if (args.reviewFindings && isRecordImpl) {
        const blocked = validateReviewFindings(args.reviewFindings as ReviewFindings, {
          subagentEnabled,
          fallbackToSelf,
          expectedIteration: 0,
          expectedPlanVersion: (state.plan?.history.length ?? 0) + 1,
          strictEnforcement: false,
        });
        if (blocked) return blocked;
      }

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
        if (files.length === 0) {
          return formatBlocked('IMPLEMENTATION_EVIDENCE_EMPTY', {
            reason: 'no changed files detected in worktree',
          });
        }
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

        // Persist review findings if provided (Mode A with findings)
        const existingFindings = state.implReviewFindings ?? [];
        const newReviewFindings = args.reviewFindings
          ? [...existingFindings, args.reviewFindings as ReviewFindings]
          : existingFindings;

        const reviewIteration = nextImplementationReviewIteration(state);
        const nextObligation = subagentEnabled
          ? createReviewObligation({
              obligationType: 'implement',
              iteration: reviewIteration,
              planVersion: (state.plan?.history.length ?? 0) + 1,
              now: ctx.now(),
            })
          : null;

        const nextState: SessionState = {
          ...state,
          implementation: implEvidence,
          implReview: null,
          implReviewFindings: newReviewFindings.length > 0 ? newReviewFindings : undefined,
          reviewAssurance: appendReviewObligation(state.reviewAssurance, nextObligation),
          error: null,
        };

        // Auto-advance to IMPL_REVIEW (policy-aware)
        const evalFn = (s: SessionState) => evaluate(s, policy);
        const { state: finalState, transitions } = autoAdvance(nextState, evalFn, ctx);
        await writeStateWithArtifacts(sessDir, finalState);

        // Build response with latestImplementationReview summary
        const response: Record<string, unknown> = {
          phase: finalState.phase,
          status: `Implementation recorded. ${files.length} files changed, ${domainFiles.length} domain files.`,
          changedFiles: files,
          domainFiles,
          reviewMode: 'subagent',
          ...reviewObligationResponseFields(nextObligation),
          next:
            'INDEPENDENT_REVIEW_REQUIRED: Before submitting your review verdict, ' +
            'you MUST call the flowguard-reviewer subagent via the Task tool. ' +
            'Use subagent_type "flowguard-reviewer" with a prompt that includes: ' +
            '(1) the implementation summary and changed files, ' +
            '(2) the approved plan text, (3) the ticket text, (4) iteration=' +
            reviewIteration +
            ', ' +
            '(5) planVersion=' +
            ((state.plan?.history.length ?? 0) + 1) +
            '. ' +
            'Instruct the subagent to read and review the changed files. ' +
            'Parse the JSON ReviewFindings from the subagent response. ' +
            'Then call flowguard_implement with reviewVerdict based on the findings ' +
            'overallVerdict, and include the reviewFindings object.',
          _audit: { transitions },
        };

        if (newReviewFindings.length > 0) {
          // Use at() for proper TS narrowing
          const atIndex = newReviewFindings.length - 1;
          const rf = newReviewFindings.at(atIndex);
          if (rf) {
            response.latestImplementationReview = {
              iteration: rf.iteration,
              reviewMode: rf.reviewMode,
              overallVerdict: rf.overallVerdict,
              blockingIssueCount: rf.blockingIssues.length,
              majorRiskCount: rf.majorRisks.length,
              missingVerificationCount: rf.missingVerification.length,
              reviewedAt: rf.reviewedAt,
            };
          }
        }

        return appendNextAction(JSON.stringify(response), finalState);
      } else {
        // ── Mode B: Implementation review verdict ────────────────
        const implementation = state.implementation;
        if (!implementation) {
          return formatBlocked('IMPLEMENTATION_EVIDENCE_REQUIRED');
        }

        if (!args.reviewFindings) {
          const blocked = requireReviewFindings(false);
          if (blocked) return blocked;
        }

        // Compute iteration before validation
        const iteration = nextImplementationReviewIteration(state);

        // Validate review findings in Mode B
        if (args.reviewFindings) {
          const blocked = validateReviewFindings(args.reviewFindings as ReviewFindings, {
            subagentEnabled,
            fallbackToSelf,
            expectedIteration: iteration,
            expectedPlanVersion: (state.plan?.history.length ?? 0) + 1,
            strictEnforcement,
            assurance: state.reviewAssurance,
            obligationType: 'implement',
          });
          if (blocked) return blocked;

          if (args.reviewFindings.overallVerdict !== args.reviewVerdict) {
            return formatBlocked('SUBAGENT_FINDINGS_VERDICT_MISMATCH', {
              reviewVerdict: args.reviewVerdict,
              overallVerdict: args.reviewFindings.overallVerdict,
            });
          }
        }

        const verdict = args.reviewVerdict as LoopVerdict;
        const prevDigest = implementation.digest;

        // For changes_requested, the LLM should make changes and call
        // flowguard_implement({}) again (Mode A). Here we just record
        // the review verdict.
        const revisionDelta: RevisionDelta = 'none';

        // Persist review findings in Mode B
        const existingFindings = state.implReviewFindings ?? [];
        const newReviewFindings = args.reviewFindings
          ? [...existingFindings, args.reviewFindings as ReviewFindings]
          : existingFindings;

        const assuranceBase = state.reviewAssurance ?? { obligations: [], invocations: [] };
        const strictObligation = strictEnforcement
          ? findLatestObligation(
              assuranceBase.obligations,
              'implement',
              iteration,
              (state.plan?.history.length ?? 0) + 1,
            )
          : null;
        const consumedAssurance = consumeReviewObligation(
          assuranceBase,
          strictObligation,
          ctx.now(),
        );

        const reviewedState: SessionState = {
          ...state,
          implReview: {
            iteration,
            maxIterations: maxImplReviewIterations,
            prevDigest,
            currDigest: implementation.digest,
            revisionDelta,
            verdict,
            executedAt: ctx.now(),
          },
          implReviewFindings: newReviewFindings.length > 0 ? newReviewFindings : undefined,
          reviewAssurance: {
            obligations: consumedAssurance.obligations,
            invocations: consumedAssurance.invocations,
          },
          error: null,
        };

        if (verdict === 'changes_requested') {
          const target = evaluateWithEvent(state.phase, 'CHANGES_REQUESTED');
          if (target === undefined) {
            return formatBlocked('INVALID_TRANSITION', {
              event: 'CHANGES_REQUESTED',
              phase: state.phase,
            });
          }

          const at = ctx.now();
          const finalState = applyTransition(
            {
              ...reviewedState,
              implementation: null,
              implReview: null,
            },
            state.phase,
            target,
            'CHANGES_REQUESTED',
            at,
          );
          const transitions = [
            { from: state.phase, to: finalState.phase, event: 'CHANGES_REQUESTED', at },
          ];
          await writeStateWithArtifacts(sessDir, finalState);

          const response: Record<string, unknown> = {
            phase: finalState.phase,
            implReviewIteration: iteration,
            status: `Implementation review iteration ${iteration}/${maxImplReviewIterations}. Changes requested.`,
            next:
              'Make the requested code changes using read/write/bash tools, ' +
              'then call flowguard_implement (without reviewVerdict) to re-record the implementation. ' +
              'After re-recording, call the flowguard-reviewer subagent again for independent review.',
            _audit: { transitions },
          };

          if (newReviewFindings.length > 0) {
            const atIndex = newReviewFindings.length - 1;
            const rf = newReviewFindings.at(atIndex);
            if (rf) {
              response.latestImplementationReview = {
                iteration: rf.iteration,
                reviewMode: rf.reviewMode,
                overallVerdict: rf.overallVerdict,
                blockingIssueCount: rf.blockingIssues.length,
                majorRiskCount: rf.majorRisks.length,
                missingVerificationCount: rf.missingVerification.length,
                reviewedAt: rf.reviewedAt,
              };
            }
          }

          return appendNextAction(JSON.stringify(response), finalState);
        }

        // Evaluate + autoAdvance (policy-aware)
        const evalFn = (s: SessionState) => evaluate(s, policy);
        const {
          state: finalState,
          evalResult: ev,
          transitions,
        } = autoAdvance(reviewedState, evalFn, ctx);
        await writeStateWithArtifacts(sessDir, finalState);

        const converged =
          iteration >= maxImplReviewIterations ||
          (revisionDelta === 'none' && verdict === 'approve');

        // Build response with latestImplementationReview summary
        const response: Record<string, unknown> = {
          phase: finalState.phase,
          implReviewIteration: iteration,
          next: verdict === 'approve' ? formatEval(ev) : undefined,
          _audit: { transitions },
        };

        if (newReviewFindings.length > 0) {
          const atIndex = newReviewFindings.length - 1;
          const rf = newReviewFindings.at(atIndex);
          if (rf) {
            response.latestImplementationReview = {
              iteration: rf.iteration,
              reviewMode: rf.reviewMode,
              overallVerdict: rf.overallVerdict,
              blockingIssueCount: rf.blockingIssues.length,
              majorRiskCount: rf.majorRisks.length,
              missingVerificationCount: rf.missingVerification.length,
              reviewedAt: rf.reviewedAt,
            };
          }
        }

        if (converged && verdict === 'approve') {
          response.status = `Implementation review converged at iteration ${iteration}. Approved.`;
          return appendNextAction(JSON.stringify(response), finalState);
        }

        // Forced convergence (max iterations reached, verdict was not approve)
        response.status = `Implementation review reached max iterations (${iteration}/${maxImplReviewIterations}). Force-converged.`;
        return appendNextAction(JSON.stringify(response), finalState);
      }
    } catch (err) {
      return formatError(err);
    }
  },
};
