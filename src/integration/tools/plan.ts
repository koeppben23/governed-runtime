/**
 * @module integration/tools/plan
 * @description FlowGuard plan tool — submit plan or record self-review verdict.
 *
 * Multi-call pattern driven by the LLM:
 *
 * Step 1: LLM generates plan, calls flowguard_plan({ planText: "..." })
 *   -> Tool records plan, initializes self-review loop, returns "self-review needed"
 *
 * Step 2: LLM reviews plan critically, calls flowguard_plan({
 *   selfReviewVerdict: "changes_requested", planText: "revised..."
 * }) OR flowguard_plan({ selfReviewVerdict: "approve" })
 *   -> Tool records iteration, checks convergence
 *
 * Repeat Step 2 until converged or max iterations (from policy).
 * On convergence: auto-advance to PLAN_REVIEW.
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
  extractSections,
  appendNextAction,
  writeStateWithArtifacts,
} from './helpers';

// State & Machine
import type { SessionState } from '../../state/schema';
import { evaluate } from '../../machine/evaluate';
import { isCommandAllowed, Command } from '../../machine/commands';

// Rail helpers
import { autoAdvance } from '../../rails/types';

// Evidence types
import type { PlanEvidence, LoopVerdict, RevisionDelta } from '../../state/evidence';

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
    'On convergence, auto-advances to PLAN_REVIEW.',
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

        // Preserve version history
        const history = state.plan ? [state.plan.current, ...state.plan.history] : [];

        const nextState: SessionState = {
          ...state,
          plan: { current: planEvidence, history },
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
        const {
          state: finalState,
          evalResult: ev,
          transitions,
        } = autoAdvance(nextState, evalFn, ctx);
        await writeStateWithArtifacts(sessDir, finalState);

        return appendNextAction(
          JSON.stringify({
            phase: finalState.phase,
            status: 'Plan submitted (v' + (history.length + 1) + ').',
            planDigest: planEvidence.digest,
            selfReviewIteration: 0,
            maxSelfReviewIterations,
            next:
              'Self-review needed. Review the plan critically against the ticket. ' +
              'Check for completeness, correctness, edge cases, and feasibility. ' +
              'Then call flowguard_plan with selfReviewVerdict.',
            _audit: { transitions },
          }),
          finalState,
        );
      } else {
        // ── Mode B: Self-review verdict ──────────────────────────
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
        const nextState: SessionState = {
          ...state,
          plan: { current: currentPlan, history },
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
