/**
 * @module integration/tools/plan
 * @description FlowGuard plan tool — submit plan or record self-review verdict.
 *
 * Agent-Orchestrated Independent Review Persistence Boundary
 *
 * Architecture: FlowGuard does NOT call subagents. The OpenCode primary agent
 * orchestrates independent review by calling the flowguard-reviewer subagent
 * via the Task tool. FlowGuard accepts, validates, and persists the resulting
 * ReviewFindings.
 *
 * Flow (subagentEnabled=true):
 * 1. Primary agent drafts plan, submits to FlowGuard
 * 2. FlowGuard returns next-action instructing subagent invocation
 * 3. Primary agent calls flowguard-reviewer subagent via Task tool
 * 4. Subagent returns structured ReviewFindings
 * 5. Primary agent submits selfReviewVerdict + reviewFindings to FlowGuard
 * 6. FlowGuard validates (mode gating, version binding, iteration binding,
 *    mandatory findings) and persists both (append-only, separate)
 *
 * Flow (subagentEnabled=false, default):
 * 1. Primary agent drafts plan, submits to FlowGuard
 * 2. FlowGuard returns next-action instructing self-review
 * 3. Primary agent reviews own plan, submits selfReviewVerdict
 *
 * Tool responsibilities:
 * - Input validation: reviewFindings vs policy, planVersion binding
 * - Persistence: plan.history (author), plan.reviewFindings (reviewer)
 * - Response: summary of review findings, iteration tracking
 * - Next-action: policy-conditional instructions (subagent or self-review)
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
 * @version v6
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
import { ReviewFindings as ReviewFindingsSchema } from '../../state/evidence.js';

// Review findings validation (shared with implement.ts)
import { validateReviewFindings, requireFindingsForApprove } from './review-validation.js';

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_plan — Submit Plan OR Self-Review Verdict (Multi-Mode)
// ═══════════════════════════════════════════════════════════════════════════════

export const plan: ToolDefinition = {
  description:
    'Submit a plan OR record a self-review verdict. Two modes:\n' +
    'Mode A (submit plan): provide planText. Records the plan and starts self-review loop.\n' +
    "Mode B (self-review): provide selfReviewVerdict ('approve' or 'changes_requested'). " +
    "If 'changes_requested', also provide revised planText.\n" +
    'The self-review loop runs up to maxIterations (from policy). ' +
    'On convergence, auto-advances to PLAN_REVIEW.\n' +
    'Optionally accepts reviewFindings from an independent review agent.',
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
    reviewFindings: ReviewFindingsSchema.optional().describe(
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

      // Validate review findings against policy (shared logic)
      const subagentEnabled = policy.selfReview?.subagentEnabled ?? false;
      const fallbackToSelf = policy.selfReview?.fallbackToSelf ?? false;

      if (args.reviewFindings) {
        const blocked = validateReviewFindings(args.reviewFindings as ReviewFindings, {
          subagentEnabled,
          fallbackToSelf,
          expectedPlanVersion: (state.plan?.history.length ?? 0) + 1,
          expectedIteration: 0,
        });
        if (blocked) return blocked;
      }

      // Approve requires findings when subagent enabled
      if (args.selfReviewVerdict === 'approve') {
        const blocked = requireFindingsForApprove(subagentEnabled, !!args.reviewFindings);
        if (blocked) return blocked;
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

        // Use submitted reviewFindings (from agent orchestrator)
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

        // Build response with optional review findings summary
        const response: Record<string, unknown> = {
          phase: finalState.phase,
          status: 'Plan submitted (v' + planVersion + ').',
          planDigest: planEvidence.digest,
          selfReviewIteration: 0,
          maxSelfReviewIterations,
          reviewMode: subagentEnabled ? 'subagent' : 'self',
          next: subagentEnabled
            ? 'INDEPENDENT_REVIEW_REQUIRED: Before submitting your self-review verdict, ' +
              'you MUST call the flowguard-reviewer subagent via the Task tool. ' +
              'Use subagent_type "flowguard-reviewer" with a prompt that includes: ' +
              '(1) the full plan text, (2) the ticket text, (3) iteration=0, ' +
              '(4) planVersion=' +
              planVersion +
              '. ' +
              'Parse the JSON ReviewFindings from the subagent response. ' +
              'Then call flowguard_plan with selfReviewVerdict based on the findings ' +
              'overallVerdict, and include the reviewFindings object. ' +
              'If the subagent returns changes_requested, revise the plan and resubmit.'
            : 'Self-review needed. Review the plan critically against the ticket. ' +
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

        // Validate review findings in Mode B (after state existence check)
        if (state.plan && args.reviewFindings) {
          const expectedIteration = state.selfReview ? state.selfReview.iteration + 1 : 0;
          const blocked = validateReviewFindings(args.reviewFindings as ReviewFindings, {
            subagentEnabled,
            fallbackToSelf,
            expectedPlanVersion: state.plan.history.length + 1,
            expectedIteration,
          });
          if (blocked) return blocked;
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
        // Preserve review findings append-only in Mode B
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
            reviewMode: subagentEnabled ? 'subagent' : 'self',
            next: subagentEnabled
              ? 'INDEPENDENT_REVIEW_REQUIRED: Call the flowguard-reviewer subagent via Task tool ' +
                'to review the revised plan. Use subagent_type "flowguard-reviewer" with a prompt ' +
                'that includes: (1) the revised plan text, (2) the ticket text, (3) iteration=' +
                iteration +
                ', (4) planVersion=' +
                (history.length + 1) +
                '. ' +
                'Parse the JSON ReviewFindings and submit with your next selfReviewVerdict.'
              : 'Review the plan again. Check if the revisions address all issues. ' +
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
