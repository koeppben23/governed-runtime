/**
 * @module integration/tools/plan
 * @description FlowGuard plan tool — submit plan or record self-review verdict.
 *
 * P34a: Agent-Orchestrated Independent Review Persistence Boundary
 *
 * Architecture: FlowGuard does NOT call subagents. FlowGuard accepts and governs
 * independently produced ReviewFindings from OpenCode primary agent orchestration.
 *
 * Flow:
 * 1. Primary agent drafts plan, calls hidden review subagent via Task tool
 * 2. Subagent returns structured ReviewFindings (via orchestrator)
 * 3. Primary agent submits plan + reviewFindings to FlowGuard tool
 * 4. FlowGuard validates and persists both (append-only, separate)
 *
 * Tool responsibilities:
 * - Input validation: reviewFindings vs policy, planVersion binding
 * - Persistence: plan.history (author), plan.reviewFindings (reviewer)
 * - Response: summary of review findings, iteration tracking
 *
 * Policy config (selfReview):
 * - subagentEnabled: enforces subagent review mode
 * - fallbackToSelf: allows self-review fallback when subagent unavailable
 *
 * Validation rules:
 * - reviewMode=subagent + !subagentEnabled → BLOCKED
 * - reviewMode=self + subagentEnabled + !fallbackToSelf → BLOCKED
 * - selfReviewVerdict=approve + subagentEnabled + missing reviewFindings → BLOCKED
 * - reviewFindings.planVersion mismatch → BLOCKED
 *
 * @version v5 (P34a agent-orchestrated)
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
  extractSections,
  appendNextAction,
  writeStateWithArtifacts,
} from './helpers.js';

// State & Machine
import type { SessionState } from '../../state/schema.js';
import { evaluate } from '../../machine/evaluate.js';
import { isCommandAllowed, Command } from '../../machine/commands.js';

// Rail helpers
import { autoAdvance } from '../../rails/types.js';

// Evidence types
import type {
  PlanEvidence,
  LoopVerdict,
  RevisionDelta,
  ReviewFindings,
} from '../../state/evidence.js';

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_plan — Submit Plan OR Self-Review Verdict (Multi-Mode)
// ═══════════════════════════════════════════════════════════════════════════════════════

export const plan: ToolDefinition = {
  description:
    'Submit a plan OR record a self-review verdict. Two modes:\n' +
    'Mode A (submit plan): provide planText. Records the plan and starts self-review loop.\n' +
    "Mode B (self-review): provide selfReviewVerdict ('approve' or 'changes_requested'). " +
    "If 'changes_requested', also provide revised planText.\n" +
    'The self-review loop runs up to maxIterations (from policy). ' +
    'On convergence, auto-advances to PLAN_REVIEW.\n' +
    'P34a: Accepts ReviewFindings from independent agent orchestrator.',
  args: {
    planText: z
      .string()
      .optional()
      .describe(
        'Plan body text (markdown). Required for Mode A (initial submission) ' +
          "and when selfReviewVerdict is 'changes_requested' (revised plan).",
      ),
    selfReviewVerdict: z
      .enum(['approve', 'changes_requested'])
      .optional()
      .describe(
        'Self-review verdict. Omit for initial plan submission. ' +
          "'approve' = plan is good, advance. " +
          "'changes_requested' = plan needs revision, provide updated planText.",
      ),
    reviewFindings: z
      .any()
      .optional()
      .describe(
        'Structured review findings from independent review. ' +
          'Required when selfReviewVerdict is "approve" and subagentEnabled=true.',
      ),
  },
  async execute(args, context) {
    try {
      const { sessDir } = await resolveWorkspacePaths(context);
      const state = await requireStateForMutation(sessDir);
      const policy = resolvePolicyFromState(state);
      const ctx = createPolicyContext(policy);
      const maxSelfReviewIterations = policy.maxSelfReviewIterations;

      // Admissibility
      if (!isCommandAllowed(state.phase, Command.PLAN)) {
        return formatBlocked('COMMAND_NOT_ALLOWED', {
          command: '/plan',
          phase: state.phase,
        });
      }

      // Require ticket
      if (!state.ticket) {
        return formatBlocked('TICKET_REQUIRED', { action: 'creating a plan' });
      }

      // P34a: Validate reviewFindings against policy
      const subagentEnabled = policy.selfReview?.subagentEnabled ?? false;
      const fallbackToSelf = policy.selfReview?.fallbackToSelf ?? false;

      if (args.reviewFindings) {
        const rf = args.reviewFindings as ReviewFindings;

        // Rule 1: subagent mode requires policy enabled
        if (rf.reviewMode === 'subagent' && !subagentEnabled) {
          return formatBlocked('REVIEW_MODE_SUBAGENT_DISABLED', {
            action: 'submit subagent review findings',
            policy: 'selfReview.subagentEnabled',
          });
        }

        // Rule 2: self mode requires fallbackToSelf when subagent enabled
        if (rf.reviewMode === 'self' && subagentEnabled && !fallbackToSelf) {
          return formatBlocked('REVIEW_MODE_SELF_NOT_ALLOWED', {
            action: 'submit self-review findings',
            policyHint: 'selfReview.fallbackToSelf=true required',
          });
        }

        // Rule 3: planVersion binding
        const history = state.plan ? [...state.plan.history] : [];
        const expectedVersion = history.length + 1;
        if (rf.planVersion !== expectedVersion) {
          return formatBlocked('REVIEW_PLAN_VERSION_MISMATCH', {
            provided: String(rf.planVersion),
            expected: String(expectedVersion),
          });
        }

        // Rule 4: iteration binding (initial submission = iteration 0)
        if (rf.iteration !== 0) {
          return formatBlocked('REVIEW_ITERATION_MISMATCH', {
            provided: String(rf.iteration),
            expected: String(0),
          });
        }
      }

      // Rule 5: approve requires reviewFindings when subagent enabled
      if (
        args.selfReviewVerdict === 'approve' &&
        subagentEnabled &&
        !args.reviewFindings
      ) {
        return formatBlocked('REVIEW_FINDINGS_REQUIRED_FOR_APPROVE', {
          action: 'approve with subagentEnabled=true',
          required: 'reviewFindings',
        });
      }

      const isInitialSubmission = !args.selfReviewVerdict;

      if (isInitialSubmission) {
        // ── Mode A: Initial plan submission ──────────────────────
        const planBody = args.planText?.trim();
        if (!planBody) {
          return formatBlocked('EMPTY_PLAN');
        }

        const planEvidence: PlanEvidence = {
          body: planBody,
          digest: ctx.digest(planBody),
          sections: extractSections(planBody),
          createdAt: ctx.now(),
        };

        // Preserve version history and track plan version
        const history = state.plan ? [state.plan.current, ...state.plan.history] : [];
        const planVersion = history.length + 1;

        // P34a: Use submitted reviewFindings (from agent orchestrator)
        let reviewFindings: ReviewFindings | null = null;
        if (args.reviewFindings) {
          reviewFindings = args.reviewFindings as ReviewFindings;
        }

        // Build plan record with parallel review findings storage
        const planRecord = {
          current: planEvidence,
          history,
          reviewFindings: reviewFindings
            ? [...(state.plan?.reviewFindings ?? []), reviewFindings]
            : state.plan?.reviewFindings,
        };

        const nextState: SessionState = {
          ...state,
          plan: planRecord,
          selfReview: {
            iteration: 0,
            maxIterations: maxSelfReviewIterations,
            prevDigest: null,
            currDigest: planEvidence.digest,
            revisionDelta: 'major' as RevisionDelta,
            verdict: 'changes_requested' as LoopVerdict,
          },
          error: null,
        };

        // Evaluate + autoAdvance (policy-aware)
        const evalFn = (s: SessionState) => evaluate(s, policy);
        const { state: finalState, transitions } = autoAdvance(nextState, evalFn, ctx);
        await writeStateWithArtifacts(sessDir, finalState);

        // Build response with optional P34a review findings summary
        const response: Record<string, unknown> = {
          phase: finalState.phase,
          status: 'Plan submitted (v' + planVersion + ').',
          planDigest: planEvidence.digest,
          selfReviewIteration: 0,
          maxSelfReviewIterations,
          next:
            'Self-review needed. Review the plan critically against the ticket. ' +
            'Check for completeness, correctness, edge cases, and feasibility. ' +
            'Then call flowguard_plan with selfReviewVerdict.',
          _audit: { transitions },
        };

        if (reviewFindings) {
          response.latestReview = {
            iteration: reviewFindings.iteration,
            planVersion,
            overallVerdict: reviewFindings.overallVerdict,
            blockingIssueCount: reviewFindings.blockingIssues.length,
            majorRiskCount: reviewFindings.majorRisks.length,
            missingVerificationCount: reviewFindings.missingVerification.length,
            reviewMode: reviewFindings.reviewMode,
            reviewedAt: reviewFindings.reviewedAt,
          };
        }

        return appendNextAction(JSON.stringify(response), finalState);
      } else {
        // ── Mode B: Self-review verdict ──────────────────────────

        // P34a: Validate reviewFindings in Mode B (after state existence check)
        if (state.plan && args.reviewFindings) {
          const rf = args.reviewFindings as ReviewFindings;
          const historyLen = state.plan.history.length;

          // Rule 1: subagent mode requires policy enabled
          if (rf.reviewMode === 'subagent' && !subagentEnabled) {
            return formatBlocked('REVIEW_MODE_SUBAGENT_DISABLED', {
              action: 'submit subagent review findings',
              policy: 'selfReview.subagentEnabled',
            });
          }

          // Rule 2: self mode requires fallbackToSelf when subagent enabled
          if (rf.reviewMode === 'self' && subagentEnabled && !fallbackToSelf) {
            return formatBlocked('REVIEW_MODE_SELF_NOT_ALLOWED', {
              action: 'submit self-review findings',
              policyHint: 'selfReview.fallbackToSelf=true required',
            });
          }

          // Rule 3: planVersion binding
          const expectedVersion = historyLen + 1;
          if (rf.planVersion !== expectedVersion) {
            return formatBlocked('REVIEW_PLAN_VERSION_MISMATCH', {
              provided: String(rf.planVersion),
              expected: String(expectedVersion),
            });
          }

          // Rule 4: iteration binding
          const expectedIteration = state.selfReview ? state.selfReview.iteration + 1 : 0;
          if (rf.iteration !== expectedIteration) {
            return formatBlocked('REVIEW_ITERATION_MISMATCH', {
              provided: String(rf.iteration),
              expected: String(expectedIteration),
            });
          }
        }

        if (!state.selfReview) {
          return formatBlocked('NO_SELF_REVIEW');
        }
        if (!state.plan) {
          return formatBlocked('NO_PLAN');
        }

        const iteration = state.selfReview.iteration + 1;
        const verdict = args.selfReviewVerdict as LoopVerdict;
        const prevDigest = state.plan.current.digest;

        let currentPlan = state.plan.current;
        let history = [...state.plan.history];
        let revisionDelta: RevisionDelta = 'none';

        if (verdict === 'changes_requested') {
          const revisedBody = args.planText?.trim();
          if (!revisedBody) {
            return formatBlocked('REVISED_PLAN_REQUIRED');
          }

          const revised: PlanEvidence = {
            body: revisedBody,
            digest: ctx.digest(revisedBody),
            sections: extractSections(revisedBody),
            createdAt: ctx.now(),
          };

          revisionDelta = revised.digest === prevDigest ? 'none' : 'minor';
          history = [currentPlan, ...history];
          currentPlan = revised;
        }

        // Build updated state
        // P34a: Preserve reviewFindings append-only in Mode B
        const existingReviewFindings = state.plan?.reviewFindings;
        const newReviewFindings = args.reviewFindings
          ? [...(existingReviewFindings ?? []), args.reviewFindings as ReviewFindings]
          : existingReviewFindings;

        const nextState: SessionState = {
          ...state,
          plan: {
            current: currentPlan,
            history,
            reviewFindings: newReviewFindings,
          },
          selfReview: {
            iteration,
            maxIterations: maxSelfReviewIterations,
            prevDigest,
            currDigest: currentPlan.digest,
            revisionDelta,
            verdict,
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

        // Check convergence for messaging
        const converged =
          iteration >= maxSelfReviewIterations ||
          (revisionDelta === 'none' && verdict === 'approve');

        if (converged) {
          return appendNextAction(
            JSON.stringify({
              phase: finalState.phase,
              status: `Self-review converged at iteration ${iteration}. Plan approved.`,
              planDigest: currentPlan.digest,
              selfReviewIteration: iteration,
              next: formatEval(ev),
              _audit: { transitions },
            }),
            finalState,
          );
        }

        return appendNextAction(
          JSON.stringify({
            phase: finalState.phase,
            status: `Self-review iteration ${iteration}/${maxSelfReviewIterations}. Verdict: ${verdict}.`,
            planDigest: currentPlan.digest,
            selfReviewIteration: iteration,
            revisionDelta,
            next:
              'Review the plan again. Check if the revisions address all issues. ' +
              'Call flowguard_plan with selfReviewVerdict.',
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
