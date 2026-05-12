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
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import {
  validateReviewFindings,
  requireReviewFindings,
  resolveHostTaskEffectiveFindings,
} from './review-validation.js';
import {
  appendReviewObligation,
  consumeReviewObligation,
  createReviewObligation,
  ensureReviewAssurance,
  findAcceptedInvocationForFindings,
  findLatestObligation,
  reviewObligationResponseFields,
} from '../review-assurance.js';
import { buildLatestImplementationReviewSummary } from './review-summary.js';

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
    reviewerUnavailable: z
      .boolean()
      .optional()
      .describe(
        'Set to true when the reviewer subagent cannot be invoked (Task tool fails, ' +
          'agent unavailable). Allows self-review fallback in host_task_required mode.',
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
      // BUG-21: Use typeof checks — `!== undefined` is true for null (which LLMs
      // may send for absent optional fields). Defense-in-depth.
      const hasVerdict = typeof args.reviewVerdict === 'string' && args.reviewVerdict.length > 0;
      const hasFindings = args.reviewFindings != null && typeof args.reviewFindings === 'object';
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
          reviewInvocationPolicy: policy.reviewInvocationPolicy,
          reviewParentSessionId: context.sessionID,
        });
        if (blocked) return blocked;
      }

      if (isRecordImpl) {
        // ── Mode A: Record implementation evidence ───────────────
        if (!isCommandAllowed(state.phase, Command.IMPLEMENT)) {
          // Recovery: if phase is IMPL_REVIEW and the last implement obligation
          // is blocked (orchestration failed), allow re-recording to create a
          // fresh obligation and retry. The agent re-records implementation
          // evidence which resets the review loop.
          // Max-cap: if >=3 implement obligations are blocked, report permanent failure.
          if (state.phase === 'IMPL_REVIEW') {
            const assurance = ensureReviewAssurance(state.reviewAssurance);
            const blockedImplObligations = assurance.obligations.filter(
              (o) => o.obligationType === 'implement' && o.status === 'blocked',
            );
            const lastImplObligation = [...assurance.obligations]
              .reverse()
              .find((o) => o.obligationType === 'implement');

            if (lastImplObligation?.status === 'blocked') {
              if (blockedImplObligations.length >= 3) {
                return formatBlocked('ORCHESTRATION_PERMANENTLY_FAILED', {
                  attempts: String(blockedImplObligations.length),
                });
              }
              // Fall through to Mode A — treat as fresh implementation recording.
              // The state will be reset below (implementation, implReview, etc.).
            } else {
              return formatBlocked('COMMAND_NOT_ALLOWED', {
                command: '/implement',
                phase: state.phase,
              });
            }
          } else {
            return formatBlocked('COMMAND_NOT_ALLOWED', {
              command: '/implement',
              phase: state.phase,
            });
          }
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
            `INDEPENDENT_REVIEW_REQUIRED: Before submitting your review verdict, ` +
            `you MUST call the ${REVIEWER_SUBAGENT_TYPE} subagent via the Task tool. ` +
            `Use subagent_type "${REVIEWER_SUBAGENT_TYPE}" with a prompt that includes: ` +
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
          response.latestImplementationReview =
            buildLatestImplementationReviewSummary(newReviewFindings);
        }

        return appendNextAction(JSON.stringify(response), finalState);
      } else {
        // ── Mode B: Implementation review verdict ────────────────
        const implementation = state.implementation;
        if (!implementation) {
          return formatBlocked('IMPLEMENTATION_EVIDENCE_REQUIRED');
        }

        // Compute iteration before findings resolution
        const iteration = nextImplementationReviewIteration(state);
        const implPlanVersion = (state.plan?.history.length ?? 0) + 1;

        // ── Resolve effective findings ──────────────────────────────
        // BUG-15 Stufe 2: For host_task_required, resolve findings from
        // invocation evidence (plugin first-party) instead of requiring
        // agent reconstruction. Eliminates attestation copy errors.
        const assuranceBase = state.reviewAssurance ?? { obligations: [], invocations: [] };

        // Find the unconsumed obligation for evidence lookup
        const pendingImplObligation =
          [...assuranceBase.obligations]
            .reverse()
            .find(
              (item) =>
                item.obligationType === 'implement' &&
                item.status !== 'consumed' &&
                item.consumedAt == null,
            ) ?? null;

        // ── Resolve effective findings ──────────────────────────────
        // BUG-17: In host_task_required mode, plugin-captured evidence is
        // the SSOT. Agent-submitted reviewFindings are ignored — the
        // non-deterministic LLM reconstruction adds zero information and
        // non-zero risk (key reordering, Zod stripping, hallucinated fields).
        // SDK path (sdk_session_prompt) continues to use agent-submitted
        // findings with full validation.
        const resolved = resolveHostTaskEffectiveFindings({
          pendingObligation: pendingImplObligation,
          expected: {
            obligationType: 'implement',
            iteration,
            planVersion: implPlanVersion,
          },
          policy: {
            reviewInvocationPolicy: policy.reviewInvocationPolicy,
            strictEnforcement,
            subagentEnabled,
            fallbackToSelf,
          },
          input: {
            reviewFindings: args.reviewFindings,
            reviewerUnavailable: args.reviewerUnavailable,
            verdict: args.reviewVerdict,
          },
          state: {
            assurance: state.reviewAssurance,
            sessionId: context.sessionID,
          },
        });
        if (resolved.blocked) return resolved.blocked;
        const effectiveFindings = resolved.effectiveFindings;
        const evidenceInvocationId = resolved.evidenceInvocationId;

        if (!effectiveFindings) {
          const blocked = requireReviewFindings(false);
          if (blocked) return blocked;
        }

        // Defense-in-depth: unable_to_review must never reach state persistence.
        if (effectiveFindings?.overallVerdict === 'unable_to_review') {
          return formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', {
            obligationId: pendingImplObligation?.obligationId ?? 'unknown',
          });
        }

        // Guard: submitted reviewVerdict must match the findings overallVerdict.
        if (effectiveFindings && effectiveFindings.overallVerdict !== args.reviewVerdict) {
          return formatBlocked('SUBAGENT_FINDINGS_VERDICT_MISMATCH', {
            reviewVerdict: args.reviewVerdict,
            overallVerdict: effectiveFindings.overallVerdict,
          });
        }

        const verdict = args.reviewVerdict as LoopVerdict;
        const prevDigest = implementation.digest;

        // For changes_requested, the LLM should make changes and call
        // flowguard_implement({}) again (Mode A). Here we just record
        // the review verdict.
        const revisionDelta: RevisionDelta = 'none';

        // Persist review findings in Mode B
        const existingFindings = state.implReviewFindings ?? [];
        const newReviewFindings = effectiveFindings
          ? [...existingFindings, effectiveFindings]
          : existingFindings;

        const strictObligation = strictEnforcement
          ? findLatestObligation(assuranceBase.obligations, 'implement', iteration, implPlanVersion)
          : null;
        // BUG-15 Stufe 2: For evidence-resolved findings, use known invocationId
        const consumedAssurance = consumeReviewObligation(
          assuranceBase,
          strictObligation,
          ctx.now(),
          evidenceInvocationId ??
            findAcceptedInvocationForFindings(
              assuranceBase,
              strictObligation,
              args.reviewFindings as ReviewFindings | undefined,
            )?.invocationId,
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
              `After re-recording, call the ${REVIEWER_SUBAGENT_TYPE} subagent again for independent review.`,
            _audit: { transitions },
          };

          if (newReviewFindings.length > 0) {
            response.latestImplementationReview =
              buildLatestImplementationReviewSummary(newReviewFindings);
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
          response.latestImplementationReview =
            buildLatestImplementationReviewSummary(newReviewFindings);
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
