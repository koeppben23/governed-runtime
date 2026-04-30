/**
 * @module integration/tools/plan
 * @description FlowGuard plan tool — submit plan or record independent review verdict.
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
 * 5. Primary agent submits review verdict + reviewFindings to FlowGuard
 * 6. FlowGuard validates (mode gating, version binding, iteration binding,
 *    mandatory findings) and persists both (append-only, separate)
 *
 * Tool responsibilities:
 * - Input validation: reviewFindings vs policy, planVersion binding
 * - Persistence: plan.history (author), plan.reviewFindings (reviewer)
 * - Response: summary of review findings, iteration tracking
 * - Next-action: independent reviewer instructions
 *
 * Policy config (selfReview):
 * - subagentEnabled: enforces subagent review mode
 * - fallbackToSelf: deprecated compatibility field; self-review fallback is prohibited
 *
 * Validation rules:
 * - reviewMode=self → BLOCKED
 * - selfReviewVerdict=approve + missing reviewFindings → BLOCKED
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
import { PHASE_LABELS } from '../../presentation/phase-labels.js';
import { buildProductNextAction } from '../../presentation/next-action-copy.js';
import { buildPlanReviewCard } from '../../presentation/plan-review-card.js';
import { resolveNextAction } from '../../machine/next-action.js';

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
import { validateReviewFindings, requireReviewFindings } from './review-validation.js';
import {
  createReviewObligation,
  ensureReviewAssurance,
  findLatestObligation,
} from '../review-assurance.js';

/** Extract the first non-empty line of text, truncated to 120 characters. */
function firstLine(text: string | undefined): string | undefined {
  if (text == null) return undefined;
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  return line.length > 120 ? line.slice(0, 117) + '...' : line;
}

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_plan — Submit Plan OR Independent Review Verdict (Multi-Mode)
// ═══════════════════════════════════════════════════════════════════════════════

export const plan: ToolDefinition = {
  description:
    'Submit a plan OR record an independent review verdict. Two modes:\n' +
    'Mode A (submit plan): provide planText. Records the plan and starts the independent review loop.\n' +
    "Mode B (review verdict): provide selfReviewVerdict ('approve' or 'changes_requested') with reviewFindings. " +
    "If 'changes_requested', also provide revised planText.\n" +
    'The independent review loop runs up to maxIterations (from policy). ' +
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
        'Independent review verdict. Omit for initial plan submission. ' +
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
      const strictEnforcement = policy.selfReview?.strictEnforcement ?? false;

      const isInitialSubmission = !args.selfReviewVerdict;

      if (isInitialSubmission && args.reviewFindings) {
        const blocked = validateReviewFindings(args.reviewFindings as ReviewFindings, {
          subagentEnabled,
          fallbackToSelf,
          expectedPlanVersion: (state.plan?.history.length ?? 0) + 1,
          expectedIteration: 0,
          strictEnforcement: false,
        });
        if (blocked) return blocked;
      }

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

        const assuranceBase = ensureReviewAssurance(state.reviewAssurance);
        const nextObligation = subagentEnabled
          ? createReviewObligation({
              obligationType: 'plan',
              iteration: 0,
              planVersion,
              now: ctx.now(),
            })
          : null;

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
          reviewAssurance: nextObligation
            ? {
                obligations: [...assuranceBase.obligations, nextObligation],
                invocations: assuranceBase.invocations,
              }
            : assuranceBase,
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
          ...(nextObligation
            ? {
                reviewObligation: {
                  obligationId: nextObligation.obligationId,
                  obligationType: 'plan' as const,
                  iteration: nextObligation.iteration,
                  planVersion: nextObligation.planVersion,
                  criteriaVersion: nextObligation.criteriaVersion,
                  mandateDigest: nextObligation.mandateDigest,
                },
                // Backward-compat flat fields
                reviewObligationId: nextObligation.obligationId,
                reviewObligationIteration: nextObligation.iteration,
                reviewObligationPlanVersion: nextObligation.planVersion,
                reviewCriteriaVersion: nextObligation.criteriaVersion,
                reviewMandateDigest: nextObligation.mandateDigest,
              }
            : {}),
          next:
            'INDEPENDENT_REVIEW_REQUIRED: Before submitting your review verdict, ' +
            'you MUST call the flowguard-reviewer subagent via the Task tool. ' +
            'Use subagent_type "flowguard-reviewer" with a prompt that includes: ' +
            '(1) the full plan text, (2) the ticket text, (3) iteration=0, ' +
            '(4) planVersion=' +
            planVersion +
            '. ' +
            'Parse the JSON ReviewFindings from the subagent response. ' +
            'Then call flowguard_plan with selfReviewVerdict based on the findings ' +
            'overallVerdict, and include the reviewFindings object. ' +
            'If the subagent returns changes_requested, revise the plan and resubmit.',
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
        // ── Mode B: Independent review verdict ───────────────────

        if (!state.selfReview) {
          return formatBlocked('NO_SELF_REVIEW');
        }
        if (!state.plan) {
          return formatBlocked('NO_PLAN');
        }

        if (!args.reviewFindings) {
          const blocked = requireReviewFindings(false);
          if (blocked) return blocked;
        }

        const assuranceBase = ensureReviewAssurance(state.reviewAssurance);
        const pendingObligation = [...assuranceBase.obligations]
          .reverse()
          .find(
            (item) =>
              item.obligationType === 'plan' &&
              item.status !== 'consumed' &&
              item.consumedAt == null,
          );
        const expectedIteration = pendingObligation?.iteration ?? state.selfReview.iteration;
        const expectedPlanVersion = pendingObligation?.planVersion ?? state.plan.history.length + 1;

        // Validate review findings in Mode B (after state existence check)
        if (args.reviewFindings) {
          const blocked = validateReviewFindings(args.reviewFindings as ReviewFindings, {
            subagentEnabled,
            fallbackToSelf,
            expectedPlanVersion,
            expectedIteration,
            strictEnforcement,
            assurance: state.reviewAssurance,
            obligationType: 'plan',
          });
          if (blocked) return blocked;
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

        const strictObligation = strictEnforcement
          ? findLatestObligation(
              assuranceBase.obligations,
              'plan',
              expectedIteration,
              expectedPlanVersion,
            )
          : null;

        const consumedObligations = assuranceBase.obligations.map((item) => {
          if (!strictObligation || item.obligationId !== strictObligation.obligationId) return item;
          return {
            ...item,
            status: 'consumed' as const,
            consumedAt: ctx.now(),
          };
        });

        const consumedInvocations = assuranceBase.invocations.map((inv) => {
          if (!strictObligation || inv.invocationId !== strictObligation.invocationId) return inv;
          return {
            ...inv,
            consumedByObligationId: strictObligation.obligationId,
          };
        });

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
          reviewAssurance: {
            obligations: consumedObligations,
            invocations: consumedInvocations,
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

        if (converged && finalState.phase === 'PLAN_REVIEW') {
          const nextAction = resolveNextAction(finalState.phase, finalState);
          const productNext = buildProductNextAction(nextAction, finalState.phase);
          const reviewCard = buildPlanReviewCard({
            planText: currentPlan.body,
            phase: finalState.phase,
            phaseLabel: PHASE_LABELS[finalState.phase],
            productNextAction: productNext,
            planVersion: history.length + 1,
            policyMode: finalState.policySnapshot?.mode,
            taskTitle: firstLine(finalState.ticket?.text),
          });
          return appendNextAction(
            JSON.stringify({
              phase: finalState.phase,
              status: `Independent review converged at iteration ${iteration}. Plan ready for approval.`,
              planDigest: currentPlan.digest,
              selfReviewIteration: iteration,
              reviewCard,
              next: formatEval(ev),
              _audit: { transitions },
            }),
            finalState,
          );
        }

        if (converged) {
          return appendNextAction(
            JSON.stringify({
              phase: finalState.phase,
              status: `Independent review converged at iteration ${iteration}. Workflow advanced to ${finalState.phase}.`,
              planDigest: currentPlan.digest,
              selfReviewIteration: iteration,
              next: formatEval(ev),
              _audit: { transitions },
            }),
            finalState,
          );
        }

        const nextIteration = iteration;
        const nextPlanVersion = history.length + 1;
        const nextObligation = subagentEnabled
          ? createReviewObligation({
              obligationType: 'plan',
              iteration: nextIteration,
              planVersion: nextPlanVersion,
              now: ctx.now(),
            })
          : null;
        const nextAssurance = ensureReviewAssurance(finalState.reviewAssurance);
        if (nextObligation) {
          nextAssurance.obligations.push(nextObligation);
          await writeStateWithArtifacts(sessDir, {
            ...finalState,
            reviewAssurance: nextAssurance,
          });
        }

        return appendNextAction(
          JSON.stringify({
            phase: finalState.phase,
            status: `Independent review iteration ${iteration}/${maxSelfReviewIterations}. Verdict: ${verdict}.`,
            planDigest: currentPlan.digest,
            selfReviewIteration: iteration,
            revisionDelta,
            reviewMode: 'subagent',
            ...(nextObligation
              ? {
                  reviewObligation: {
                    obligationId: nextObligation.obligationId,
                    obligationType: 'plan' as const,
                    iteration: nextObligation.iteration,
                    planVersion: nextObligation.planVersion,
                    criteriaVersion: nextObligation.criteriaVersion,
                    mandateDigest: nextObligation.mandateDigest,
                  },
                  reviewObligationId: nextObligation.obligationId,
                  reviewObligationIteration: nextObligation.iteration,
                  reviewObligationPlanVersion: nextObligation.planVersion,
                  reviewCriteriaVersion: nextObligation.criteriaVersion,
                  reviewMandateDigest: nextObligation.mandateDigest,
                }
              : {}),
            next:
              'INDEPENDENT_REVIEW_REQUIRED: Call the flowguard-reviewer subagent via Task tool ' +
              'to review the revised plan. Use subagent_type "flowguard-reviewer" with a prompt ' +
              'that includes: (1) the revised plan text, (2) the ticket text, (3) iteration=' +
              nextIteration +
              ', (4) planVersion=' +
              nextPlanVersion +
              '. ' +
              'Parse the JSON ReviewFindings and submit with your next selfReviewVerdict.',
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
