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
  appendReviewObligation,
  consumeReviewObligation,
  createReviewObligation,
  ensureReviewAssurance,
  findAcceptedInvocationForFindings,
  findLatestObligation,
  findLatestUnconsumedObligation,
  reviewObligationResponseFields,
} from '../review-assurance.js';

// Review findings validation (shared with plan.ts and implement.ts; F13 slice 7c)
import { resolveHostTaskEffectiveFindings, requireReviewFindings } from './review-validation.js';

import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';

// Presentation
import {
  PHASE_LABELS,
  buildArchitectureReviewCard,
  buildProductNextAction,
} from '../../presentation/index.js';
import { materializeReviewCardArtifact } from '../../adapters/workspace/index.js';
import { resolveNextAction } from '../../machine/next-action.js';

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
    `by the ${REVIEWER_SUBAGENT_TYPE} subagent and the verdict submission MUST include reviewFindings ` +
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
      `Structured findings from the ${REVIEWER_SUBAGENT_TYPE} subagent (F13). ` +
        'Required when selfReviewVerdict is "approve" and subagentEnabled=true. ' +
        'Use exactly the JSON object the subagent returned — do not modify it.',
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
      const { sessDir } = await resolveWorkspacePaths(context);
      const state = await requireStateForMutation(sessDir);
      const policy = resolvePolicyFromState(state);
      const ctx = createPolicyContext(policy);
      const maxSelfReviewIterations = policy.maxSelfReviewIterations;

      const hasTitle = typeof args.title === 'string' && args.title.trim().length > 0;
      const hasAdrText = typeof args.adrText === 'string' && args.adrText.trim().length > 0;
      // BUG-21: Use typeof checks — `!== undefined` is true for null (which LLMs
      // may send for absent optional fields). Defense-in-depth.
      const hasVerdict =
        typeof args.selfReviewVerdict === 'string' && args.selfReviewVerdict.length > 0;
      const isInitialSubmission = !hasVerdict;

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
        // Recovery: if the last architecture obligation is blocked (orchestration failed),
        // allow re-submission to create a fresh obligation and retry.
        // Max-cap: if >=3 architecture obligations are blocked, report permanent failure.
        const assurance = ensureReviewAssurance(state.reviewAssurance);
        const blockedArchObligations = assurance.obligations.filter(
          (o) => o.obligationType === 'architecture' && o.status === 'blocked',
        );
        const lastArchObligation = [...assurance.obligations]
          .reverse()
          .find((o) => o.obligationType === 'architecture');

        if (lastArchObligation?.status === 'blocked') {
          if (blockedArchObligations.length >= 3) {
            return formatBlocked('ORCHESTRATION_PERMANENTLY_FAILED', {
              attempts: String(blockedArchObligations.length),
            });
          }
          // Fall through to Mode A — treat as fresh submission.
          // selfReview will be reset by executeArchitecture() rail.
        } else {
          return formatBlocked('ADR_REVIEW_IN_PROGRESS');
        }
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
        // Architecture reviews reuse ReviewObligation.planVersion as the generic
        // review-subject version binding. For ADR/MADR subjects this is fixed to 1;
        // it is not a task-plan version.
        const archPlanVersion = 1;
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
              reviewAssurance: appendReviewObligation(result.state.reviewAssurance, nextObligation),
            }
          : result.state;

        await writeStateWithArtifacts(sessDir, augmentedState);

        const modeANext = subagentEnabled
          ? `INDEPENDENT_REVIEW_REQUIRED: Before submitting your review verdict, ` +
            `you MUST call the ${REVIEWER_SUBAGENT_TYPE} subagent via the Task tool. ` +
            `Use subagent_type "${REVIEWER_SUBAGENT_TYPE}" with a prompt that includes: ` +
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
          ...reviewObligationResponseFields(nextObligation),
          next: modeANext,
          _audit: { transitions: result.transitions },
        };

        return appendNextAction(JSON.stringify(modeAResponse), augmentedState);
      } else {
        // ── Mode B: Review verdict (F13 slice 7c: subagent-driven by default) ──
        // Admissibility: Mode B is only valid from ARCHITECTURE phase.
        if (state.phase !== 'ARCHITECTURE') {
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

        // ── Obligation lookup (before findings resolution) ─────────
        // ADRs are immutable per id; planVersion is fixed at 1, iteration is
        // the loop counter. Use the centralized obligation lookup (matches
        // both pending and fulfilled — plugin-orchestrated obligations are
        // set to 'fulfilled' before Mode B submission).
        const assuranceBaseModeB = ensureReviewAssurance(state.reviewAssurance);
        const pendingObligation = findLatestUnconsumedObligation(
          assuranceBaseModeB,
          'architecture',
        );
        const expectedIteration = pendingObligation?.iteration ?? state.selfReview.iteration;
        const expectedPlanVersion = pendingObligation?.planVersion ?? 1;

        // ── Resolve effective findings ──────────────────────────────
        // BUG-17: In host_task_required mode, plugin-captured evidence is
        // the SSOT. Agent-submitted reviewFindings are ignored — the
        // non-deterministic LLM reconstruction adds zero information and
        // non-zero risk (key reordering, Zod stripping, hallucinated fields).
        // SDK path (sdk_session_prompt) continues to use agent-submitted
        // findings with full validation.
        const resolved = resolveHostTaskEffectiveFindings({
          pendingObligation,
          expected: {
            obligationType: 'architecture',
            iteration: expectedIteration,
            planVersion: expectedPlanVersion,
          },
          policy: {
            reviewInvocationPolicy: policy.reviewInvocationPolicy,
            strictEnforcement,
            subagentEnabled: subagentEnabledModeB,
            fallbackToSelf,
          },
          input: {
            reviewFindings: args.reviewFindings,
            reviewerUnavailable: args.reviewerUnavailable,
            verdict: args.selfReviewVerdict,
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
            obligationId: pendingObligation?.obligationId ?? 'unknown',
          });
        }

        // Guard: submitted selfReviewVerdict must match the findings overallVerdict.
        // (unable_to_review already handled by defense-in-depth check above)
        if (effectiveFindings && effectiveFindings.overallVerdict !== args.selfReviewVerdict) {
          return formatBlocked('SUBAGENT_FINDINGS_VERDICT_MISMATCH', {
            submittedVerdict: args.selfReviewVerdict,
            findingsVerdict: effectiveFindings.overallVerdict,
          });
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
        const newReviewFindings = effectiveFindings
          ? [...(existingReviewFindings ?? []), effectiveFindings]
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

        // BUG-15 Stufe 2: For evidence-resolved findings, use known invocationId
        const consumedAssurance = consumeReviewObligation(
          assuranceBaseModeB,
          strictObligation,
          ctx.now(),
          evidenceInvocationId ??
            findAcceptedInvocationForFindings(
              assuranceBaseModeB,
              strictObligation,
              args.reviewFindings as ReviewFindings | undefined,
            )?.invocationId,
        );

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
            obligations: consumedAssurance.obligations,
            invocations: consumedAssurance.invocations,
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

        // Check convergence before building the next obligation.
        const approvedConverged = revisionDelta === 'none' && verdict === 'approve';
        const maxReached = iteration >= maxSelfReviewIterations;

        // Max iterations reached without approval: fail-closed, not converged.
        if (maxReached && !approvedConverged) {
          await writeStateWithArtifacts(sessDir, finalState);
          return formatBlocked('MAX_REVIEW_ITERATIONS_REACHED', {
            iteration: String(iteration),
            maxIterations: String(maxSelfReviewIterations),
            lastVerdict: verdict,
          });
        }

        if (approvedConverged) {
          await writeStateWithArtifacts(sessDir, finalState);
          const isComplete = finalState.phase === 'ARCH_COMPLETE';
          const convergedResp: Record<string, unknown> = {
            phase: finalState.phase,
            status: subagentEnabledModeB
              ? `Independent review converged at iteration ${iteration}. ADR ${isComplete ? 'approved' : 'ready for approval'}.`
              : `ADR self-review converged at iteration ${iteration}. ADR ${isComplete ? 'approved' : 'ready for approval'}.`,
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

          // Build the Architecture Review Card as a markdown presentation layer.
          const nextAction = resolveNextAction(finalState.phase, finalState);
          const productNext = buildProductNextAction(nextAction, finalState.phase);
          const reviewFindings = convergedResp.latestReview as Record<string, unknown> | undefined;
          const f = args.reviewFindings ? (args.reviewFindings as ReviewFindings) : null;
          convergedResp.reviewCard = buildArchitectureReviewCard({
            phase: finalState.phase,
            phaseLabel: PHASE_LABELS[finalState.phase],
            adrTitle: currentAdr.title,
            adrId: currentAdr.id,
            adrDigest: currentAdr.digest,
            iteration,
            overallVerdict: reviewFindings?.overallVerdict as string | undefined,
            blockingIssues: f?.blockingIssues,
            majorRisks: f?.majorRisks,
            missingVerification: f?.missingVerification,
            scopeCreep: f?.scopeCreep,
            unknowns: f?.unknowns,
            productNextAction: productNext,
            isApproved: isComplete,
          });
          const artifactErr = await materializeReviewCardArtifact(
            sessDir,
            'architecture-review-card',
            convergedResp.reviewCard as string,
            finalState,
            currentAdr.digest,
          );
          if (artifactErr) convergedResp.artifactWarning = artifactErr;
          return appendNextAction(JSON.stringify(convergedResp), finalState);
        }

        // Non-converged: build next obligation and write atomically.
        const nextIteration = iteration;
        const nextObligation = subagentEnabledModeB
          ? createReviewObligation({
              obligationType: 'architecture',
              iteration: nextIteration,
              planVersion: expectedPlanVersion,
              now: ctx.now(),
            })
          : null;
        const stateToPersist = nextObligation
          ? {
              ...finalState,
              reviewAssurance: appendReviewObligation(finalState.reviewAssurance, nextObligation),
            }
          : finalState;
        await writeStateWithArtifacts(sessDir, stateToPersist);

        const nonConvergedNext = subagentEnabledModeB
          ? `INDEPENDENT_REVIEW_REQUIRED: Call the ${REVIEWER_SUBAGENT_TYPE} subagent via Task tool ` +
            `to review the revised ADR. Use subagent_type "${REVIEWER_SUBAGENT_TYPE}" with a prompt ` +
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
          ...reviewObligationResponseFields(nextObligation),
          next: nonConvergedNext,
          _audit: { transitions },
        };

        return appendNextAction(JSON.stringify(nonConvergedResp), stateToPersist);
      }
    } catch (err) {
      return formatError(err);
    }
  },
};
