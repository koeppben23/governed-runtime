/**
 * @module integration/tools/plan
 * @description FlowGuard plan tool — submit plan or record self-review verdict.
 *
 * P34a Foundation: Independent Self-Review (Foundation, NOT Complete)
 *
 * This module provides schema and policy infrastructure for independent subagent review:
 * - selfReview config in policy (subagentEnabled, fallbackToSelf)
 * - ReviewFindings schema with parallel storage
 * - latestReview summary in status
 * - Fallback/blocked semantics
 *
 * ACTUAL SUBAGENT INVOCATION STATUS: STUB
 *
 * The executeSubagentReview() function currently returns null (stub).
 * A complete independent review subagent path requires OpenCode task/subagent
 * orchestration being accessible from FlowGuard's controlled runtime.
 * This pattern is NOT clearly documented as an available API in official OpenCode docs.
 *
 * Current behavior when policy.selfReview.subagentEnabled=true:
 * - Subagent returns null (stub) → fallbackToSelf=true → degraded warning
 * - Subagent returns null (stub) + fallbackToSelf=false → BLOCKED
 *
 * Full subagent integration requires P34a.2 (out of scope for current patch).
 *
 * Multi-call pattern:
 * Step 1: LLM generates plan, calls flowguard_plan({ planText: "..." })
 *
 * Step 1: LLM generates plan, calls flowguard_plan({ planText: "..." })
 *   -> Tool records plan
 *   -> If subagentEnabled: attempt subagent review
 *   -> Store reviewFindings in state.plan.reviewFindings (parallel)
 *   -> Return "self-review needed" with findings summary
 *
 * Step 2: LLM reviews plan critically via selfReviewVerdict
 *   -> Tool records iteration, checks convergence
 *
 * Repeat Step 2 until converged or max iterations.
 * On convergence: auto-advance to PLAN_REVIEW.
 *
 * Subagent behavior (P34a):
 * - subagentEnabled + subagent succeeds → use findings
 * - subagentEnabled + subagent fails + fallbackToSelf → degraded warning
 * - subagentEnabled + subagent fails + !fallbackToSelf → BLOCKED
 *
 * Architecture: plan.history = author artifacts, plan.reviewFindings = reviewer artifacts
 *
 * @version v4 (P34a)
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
// P34a Foundation: Subagent Review Stub
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Execute subagent review (P34a Foundation stub).
 *
 * ACTUAL STATUS: STUB - returns null to trigger fallback semantics
 *
 * Reason: A complete independent review subagent path requires OpenCode
 * task/subagent orchestration being accessible from FlowGuard's runtime.
 * This pattern is NOT clearly documented as an API in official OpenCode docs.
 *
 * Returns null → triggers fallbackToSelf or BLOCKED per policy config.
 *
 * Full implementation requires P34a.2 with actual Task tool integration.
 */
async function executeSubagentReview(
  _state: SessionState,
  _sessionId: string,
): Promise<ReviewFindings | null> {
  // Stub: returns null to trigger fallback
  // Full implementation via Task tool in P34a.2
  return null;
}

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
    'P34a: When policy.selfReview.subagentEnabled, uses independent subagent review.',
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

        // Preserve version history and track plan version
        const history = state.plan ? [state.plan.current, ...state.plan.history] : [];
        const planVersion = history.length + 1;

        // P34a: Independent subagent review
        const selfReviewConfig = policy.selfReview;
        const subagentEnabled = selfReviewConfig?.subagentEnabled ?? false;
        const fallbackToSelf = selfReviewConfig?.fallbackToSelf ?? false;
        let reviewFindings: ReviewFindings | null = null;
        let subagentWarning: string | null = null;

        if (subagentEnabled) {
          const subagentResult = await executeSubagentReview(state, context.sessionID);

          if (subagentResult) {
            reviewFindings = subagentResult;
          } else if (fallbackToSelf) {
            subagentWarning =
              'Subagent unavailable, using degraded self-review (fallbackToSelf=true)';
          } else {
            return formatBlocked('SUBAGENT_UNAVAILABLE', {
              action: 'independent review',
              recovery: 'Enable policy.selfReview.fallbackToSelf or disable subagent review',
            });
          }
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

        if (subagentWarning) {
          response.warning = subagentWarning;
        }

        return appendNextAction(JSON.stringify(response), finalState);
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
