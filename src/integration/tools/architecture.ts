/**
 * @module integration/tools/architecture
 * @description FlowGuard architecture tool — submit ADR or record self-review verdict.
 *
 * Multi-call pattern driven by the LLM:
 *
 * Step 1: LLM generates ADR, calls flowguard_architecture({ title, adrText })
 *   -> Tool records ADR, initializes self-review loop, returns "self-review needed"
 *
 * Step 2: LLM reviews ADR critically, calls flowguard_architecture({
 *   selfReviewVerdict: "changes_requested", adrText: "revised..."
 * }) OR flowguard_architecture({ selfReviewVerdict: "approve" })
 *   -> Tool records iteration, checks convergence
 *
 * Repeat Step 2 until converged or max iterations (from policy).
 * On convergence: auto-advance to ARCH_REVIEW.
 *
 * @version v1
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
import { evaluate } from '../../machine/evaluate.js';
import { isCommandAllowed, Command } from '../../machine/commands.js';

// Rails
import { executeArchitecture } from '../../rails/architecture.js';

// Rail helpers
import { autoAdvance } from '../../rails/types.js';

// Evidence types
import type { LoopVerdict, RevisionDelta, ReviewFindings } from '../../state/evidence.js';
import {
  validateAdrSections,
  ReviewFindings as ReviewFindingsSchema,
} from '../../state/evidence.js';

// Review obligation helpers (F13: parity with plan/implement)
import {
  createReviewObligation,
  ensureReviewAssurance,
  findLatestObligation,
} from '../review-assurance.js';

// Review findings validation (shared with plan.ts and implement.ts; F13 slice 7c)
import { validateReviewFindings, requireReviewFindings } from './review-validation.js';

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_architecture — Submit ADR OR Self-Review Verdict (Multi-Mode)
// ═══════════════════════════════════════════════════════════════════════════════

export const architecture: ToolDefinition = {
  description:
    'Submit an Architecture Decision Record (ADR) OR record a self-review verdict. Two modes:\n' +
    'Mode A (submit ADR): provide title and adrText. ADR ID is auto-generated. Records the ADR and starts the review flow.\n' +
    "Mode B (review verdict): provide selfReviewVerdict ('approve' or 'changes_requested'). " +
    "If 'changes_requested', also provide revised adrText.\n" +
    'When subagentEnabled=true (the default for all built-in policies), the review is performed ' +
    'by the flowguard-reviewer subagent and the verdict submission MUST include reviewFindings ' +
    'returned by that subagent. When subagentEnabled=false, the legacy LLM-driven self-review path is used.\n' +
    'The review loop runs up to maxIterations (from policy). ' +
    'On convergence, auto-advances to ARCH_REVIEW.\n' +
    'Only allowed in READY phase (starts the architecture flow) or ARCHITECTURE phase (re-submit after revision).\n' +
    'Optionally accepts reviewFindings from an independent review agent (F13).',
  args: {
    title: z
      .string()
      .optional()
      .describe('Short title of the architecture decision. Required for Mode A.'),
    adrText: z
      .string()
      .optional()
      .describe(
        'Full ADR body in MADR Markdown format. ' +
          'Must include ## Context, ## Decision, and ## Consequences sections. ' +
          "Required for Mode A and when selfReviewVerdict is 'changes_requested'.",
      ),
    selfReviewVerdict: z
      .enum(['approve', 'changes_requested'])
      .optional()
      .describe(
        'Review verdict. Omit for initial ADR submission. ' +
          "'approve' = ADR is good, advance. " +
          "'changes_requested' = ADR needs revision, provide updated adrText.",
      ),
    reviewFindings: ReviewFindingsSchema.optional().describe(
      'Structured findings from the flowguard-reviewer subagent (F13). ' +
        'Required when selfReviewVerdict is "approve" and subagentEnabled=true. ' +
        'Use exactly the JSON object the subagent returned — do not modify it.',
    ),
  },
  async execute(args, context) {
    try {
      const { sessDir } = await resolveWorkspacePaths(context);
      const state = await requireStateForMutation(sessDir);
      const policy = resolvePolicyFromState(state);
      const ctx = createPolicyContext(policy);
      const maxSelfReviewIterations = policy.maxSelfReviewIterations;

      const hasTitle = typeof args.title === 'string' && args.title.trim().length > 0;
      const hasAdrText = typeof args.adrText === 'string' && args.adrText.trim().length > 0;
      const hasVerdict = args.selfReviewVerdict !== undefined;
      const isInitialSubmission = !args.selfReviewVerdict;

      // Runtime sequence contract: ADR submission and review verdict are separate phases.
      if (hasTitle && hasVerdict) {
        return formatBlocked('ADR_SUBMISSION_MIXED_INPUTS');
      }

      if (
        isInitialSubmission &&
        (hasTitle || hasAdrText) &&
        state.phase === 'ARCHITECTURE' &&
        state.selfReview
      ) {
        return formatBlocked('ADR_REVIEW_IN_PROGRESS');
      }

      if (isInitialSubmission) {
        // ── Mode A: Initial ADR submission (delegates to rail) ────
        if (!args.title) {
          return formatBlocked('EMPTY_ADR_TITLE');
        }
        if (!args.adrText) {
          return formatBlocked('EMPTY_ADR_TEXT');
        }

        const result = executeArchitecture(
          state,
          {
            title: args.title,
            adrText: args.adrText,
          },
          ctx,
        );

        if (result.kind === 'blocked') {
          return JSON.stringify({
            error: true,
            code: result.code,
            message: result.reason,
            recovery: result.recovery,
            quickFix: result.quickFix,
          });
        }

        // F13 slice 7b: when subagentEnabled, attach a fresh review obligation
        // to reviewAssurance so the orchestrator can wire the verdict submission
        // to the flowguard-reviewer subagent. Mirrors plan.ts:233-259.
        const subagentEnabled = policy.selfReview?.subagentEnabled ?? false;
        const assuranceBase = ensureReviewAssurance(result.state.reviewAssurance);
        const archPlanVersion = 1; // ADRs are immutable per id; iteration counts revisions
        const nextObligation = subagentEnabled
          ? createReviewObligation({
              obligationType: 'architecture',
              iteration: 0,
              planVersion: archPlanVersion,
              now: ctx.now(),
            })
          : null;

        const augmentedState: SessionState = nextObligation
          ? {
              ...result.state,
              reviewAssurance: {
                obligations: [...assuranceBase.obligations, nextObligation],
                invocations: assuranceBase.invocations,
              },
            }
          : result.state;

        await writeStateWithArtifacts(sessDir, augmentedState);

        const modeANext = subagentEnabled
          ? 'INDEPENDENT_REVIEW_REQUIRED: Before submitting your review verdict, ' +
            'you MUST call the flowguard-reviewer subagent via the Task tool. ' +
            'Use subagent_type "flowguard-reviewer" with a prompt that includes: ' +
            '(1) the full ADR text, (2) the ADR title, (3) the ticket text, ' +
            '(4) iteration=0, (5) planVersion=' +
            archPlanVersion +
            '. ' +
            'Parse the JSON ReviewFindings from the subagent response. ' +
            'Then call flowguard_architecture with selfReviewVerdict based on ' +
            'the findings overallVerdict, and include the reviewFindings object. ' +
            'If the subagent returns changes_requested, revise the ADR and resubmit.'
          : 'Self-review needed. Review the ADR critically against MADR standards. ' +
            'Check for completeness, clarity, and consequences coverage. ' +
            'Then call flowguard_architecture with selfReviewVerdict.';

        const modeAResponse: Record<string, unknown> = {
          phase: augmentedState.phase,
          status: `ADR ${augmentedState.architecture!.id} submitted: ${args.title}`,
          adrId: augmentedState.architecture!.id,
          adrDigest: augmentedState.architecture!.digest,
          selfReviewIteration: 0,
          maxSelfReviewIterations,
          reviewMode: subagentEnabled ? 'subagent' : 'self',
          ...(nextObligation
            ? {
                reviewObligation: {
                  obligationId: nextObligation.obligationId,
                  obligationType: 'architecture' as const,
                  iteration: nextObligation.iteration,
                  planVersion: nextObligation.planVersion,
                  criteriaVersion: nextObligation.criteriaVersion,
                  mandateDigest: nextObligation.mandateDigest,
                },
                // Backward-compat flat fields (parity with plan.ts)
                reviewObligationId: nextObligation.obligationId,
                reviewObligationIteration: nextObligation.iteration,
                reviewObligationPlanVersion: nextObligation.planVersion,
                reviewCriteriaVersion: nextObligation.criteriaVersion,
                reviewMandateDigest: nextObligation.mandateDigest,
              }
            : {}),
          next: modeANext,
          _audit: { transitions: result.transitions },
        };

        return appendNextAction(JSON.stringify(modeAResponse), augmentedState);
      } else {
        // ── Mode B: Review verdict (F13 slice 7c: subagent-driven by default) ──
        // Admissibility: must be in ARCHITECTURE phase
        if (
          !isCommandAllowed(state.phase, Command.ARCHITECTURE) &&
          state.phase !== 'ARCHITECTURE'
        ) {
          return formatBlocked('COMMAND_NOT_ALLOWED', {
            command: '/architecture',
            phase: state.phase,
          });
        }

        if (!state.architecture) {
          return formatBlocked('NO_ARCHITECTURE');
        }
        if (!state.selfReview) {
          return formatBlocked('ARCHITECTURE_REVIEW_LOOP_REQUIRED');
        }

        // F13 slice 7c: enforce subagent review-findings policy parity with
        // flowguard_plan and flowguard_implement.
        const subagentEnabledModeB = policy.selfReview?.subagentEnabled ?? false;
        const fallbackToSelf = policy.selfReview?.fallbackToSelf ?? false;
        const strictEnforcement = policy.selfReview?.strictEnforcement ?? false;

        if (!args.reviewFindings) {
          const blocked = requireReviewFindings(false);
          if (blocked) return blocked;
        }

        // ADRs are immutable per id; planVersion is fixed at 1, iteration is
        // the loop counter. The pendingObligation lookup mirrors plan.ts:339-348.
        const assuranceBaseModeB = ensureReviewAssurance(state.reviewAssurance);
        const pendingObligation = [...assuranceBaseModeB.obligations]
          .reverse()
          .find(
            (item) =>
              item.obligationType === 'architecture' &&
              item.status !== 'consumed' &&
              item.consumedAt == null,
          );
        const expectedIteration = pendingObligation?.iteration ?? state.selfReview.iteration;
        const expectedPlanVersion = pendingObligation?.planVersion ?? 1;

        if (args.reviewFindings) {
          const blocked = validateReviewFindings(args.reviewFindings as ReviewFindings, {
            subagentEnabled: subagentEnabledModeB,
            fallbackToSelf,
            expectedPlanVersion,
            expectedIteration,
            strictEnforcement,
            assurance: state.reviewAssurance,
            obligationType: 'architecture',
          });
          if (blocked) return blocked;
        }

        const iteration = state.selfReview.iteration + 1;
        const verdict = args.selfReviewVerdict as LoopVerdict;
        const prevDigest = state.architecture.digest;

        let currentAdr = state.architecture;
        let revisionDelta: RevisionDelta = 'none';

        if (verdict === 'changes_requested') {
          const revisedText = args.adrText?.trim();
          if (!revisedText) {
            return formatBlocked('EMPTY_ADR_TEXT');
          }

          // Validate MADR sections on revision
          const missingSections = validateAdrSections(revisedText);
          if (missingSections.length > 0) {
            return formatBlocked('MISSING_ADR_SECTIONS', {
              sections: missingSections.join(', '),
            });
          }

          const revisedDigest = ctx.digest(revisedText);
          revisionDelta = revisedDigest === prevDigest ? 'none' : 'minor';
          currentAdr = {
            ...currentAdr,
            adrText: revisedText,
            digest: revisedDigest,
          };
        }

        // F13 slice 7c: append-only review findings parallel to author artifacts
        const existingReviewFindings = state.architecture.reviewFindings;
        const newReviewFindings = args.reviewFindings
          ? [...(existingReviewFindings ?? []), args.reviewFindings as ReviewFindings]
          : existingReviewFindings;
        const adrWithReviewFindings = newReviewFindings
          ? { ...currentAdr, reviewFindings: newReviewFindings }
          : currentAdr;

        // F13 slice 7c: consume the matched obligation (strictEnforcement)
        const strictObligation = strictEnforcement
          ? findLatestObligation(
              assuranceBaseModeB.obligations,
              'architecture',
              expectedIteration,
              expectedPlanVersion,
            )
          : null;

        const consumedObligations = assuranceBaseModeB.obligations.map((item) => {
          if (!strictObligation || item.obligationId !== strictObligation.obligationId) return item;
          return {
            ...item,
            status: 'consumed' as const,
            consumedAt: ctx.now(),
          };
        });

        const consumedInvocations = assuranceBaseModeB.invocations.map((inv) => {
          if (!strictObligation || inv.invocationId !== strictObligation.invocationId) return inv;
          return {
            ...inv,
            consumedByObligationId: strictObligation.obligationId,
          };
        });

        // Build updated state
        const nextState: SessionState = {
          ...state,
          architecture: adrWithReviewFindings,
          selfReview: {
            iteration,
            maxIterations: maxSelfReviewIterations,
            prevDigest,
            currDigest: currentAdr.digest,
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
          state: advancedState,
          evalResult: ev,
          transitions,
        } = autoAdvance(nextState, evalFn, ctx);
        // Finalize ADR status on architecture flow completion (solo auto-approve)
        const finalState =
          advancedState.phase === 'ARCH_COMPLETE' && advancedState.architecture
            ? {
                ...advancedState,
                architecture: { ...advancedState.architecture, status: 'accepted' as const },
              }
            : advancedState;
        await writeStateWithArtifacts(sessDir, finalState);

        // Check convergence for messaging
        const converged =
          iteration >= maxSelfReviewIterations ||
          (revisionDelta === 'none' && verdict === 'approve');

        if (converged) {
          const convergedResp: Record<string, unknown> = {
            phase: finalState.phase,
            status: subagentEnabledModeB
              ? `Independent review converged at iteration ${iteration}. ADR approved.`
              : `ADR self-review converged at iteration ${iteration}. ADR approved.`,
            adrId: currentAdr.id,
            adrDigest: currentAdr.digest,
            selfReviewIteration: iteration,
            next: formatEval(ev),
            _audit: { transitions },
          };
          if (args.reviewFindings) {
            const f = args.reviewFindings as ReviewFindings;
            convergedResp.latestReview = {
              iteration: f.iteration,
              planVersion: expectedPlanVersion,
              overallVerdict: f.overallVerdict,
              blockingIssueCount: f.blockingIssues.length,
              majorRiskCount: f.majorRisks.length,
              missingVerificationCount: f.missingVerification.length,
              reviewMode: f.reviewMode,
              reviewedAt: f.reviewedAt,
            };
          }
          return appendNextAction(JSON.stringify(convergedResp), finalState);
        }

        // Non-converged: when subagentEnabled, attach a fresh obligation for
        // the next iteration so the orchestrator can dispatch the subagent
        // again. Mirrors plan.ts:499-516.
        const nextIteration = iteration;
        const nextObligation = subagentEnabledModeB
          ? createReviewObligation({
              obligationType: 'architecture',
              iteration: nextIteration,
              planVersion: expectedPlanVersion,
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

        const nonConvergedNext = subagentEnabledModeB
          ? 'INDEPENDENT_REVIEW_REQUIRED: Call the flowguard-reviewer subagent via Task tool ' +
            'to review the revised ADR. Use subagent_type "flowguard-reviewer" with a prompt ' +
            'that includes: (1) the revised ADR text, (2) the ADR title, (3) the ticket text, ' +
            '(4) iteration=' +
            nextIteration +
            ', (5) planVersion=' +
            expectedPlanVersion +
            '. ' +
            'Parse the JSON ReviewFindings and submit with your next selfReviewVerdict.'
          : 'Review the ADR again. Check if the revisions address all issues. ' +
            'Call flowguard_architecture with selfReviewVerdict.';

        const nonConvergedResp: Record<string, unknown> = {
          phase: finalState.phase,
          status: `${
            subagentEnabledModeB ? 'Independent review' : 'ADR self-review'
          } iteration ${iteration}/${maxSelfReviewIterations}. Verdict: ${verdict}.`,
          adrId: currentAdr.id,
          adrDigest: currentAdr.digest,
          selfReviewIteration: iteration,
          revisionDelta,
          reviewMode: subagentEnabledModeB ? 'subagent' : 'self',
          ...(nextObligation
            ? {
                reviewObligation: {
                  obligationId: nextObligation.obligationId,
                  obligationType: 'architecture' as const,
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
          next: nonConvergedNext,
          _audit: { transitions },
        };

        return appendNextAction(JSON.stringify(nonConvergedResp), finalState);
      }
    } catch (err) {
      return formatError(err);
    }
  },
};
