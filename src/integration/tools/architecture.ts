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
import type { LoopVerdict, RevisionDelta } from '../../state/evidence.js';
import { validateAdrSections } from '../../state/evidence.js';

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_architecture — Submit ADR OR Self-Review Verdict (Multi-Mode)
// ═══════════════════════════════════════════════════════════════════════════════

export const architecture: ToolDefinition = {
  description:
    'Submit an Architecture Decision Record (ADR) OR record a self-review verdict. Two modes:\n' +
    'Mode A (submit ADR): provide title and adrText. ADR ID is auto-generated. Records the ADR and starts self-review loop.\n' +
    "Mode B (self-review): provide selfReviewVerdict ('approve' or 'changes_requested'). " +
    "If 'changes_requested', also provide revised adrText.\n" +
    'The self-review loop runs up to maxIterations (from policy). ' +
    'On convergence, auto-advances to ARCH_REVIEW.\n' +
    'Only allowed in READY phase (starts the architecture flow) or ARCHITECTURE phase (re-submit after revision).',
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
        'Self-review verdict. Omit for initial ADR submission. ' +
          "'approve' = ADR is good, advance. " +
          "'changes_requested' = ADR needs revision, provide updated adrText.",
      ),
  },
  async execute(args, context) {
    try {
      const { sessDir } = await resolveWorkspacePaths(context);
      const state = await requireStateForMutation(sessDir);
      const policy = resolvePolicyFromState(state);
      const ctx = createPolicyContext(policy);
      const maxSelfReviewIterations = policy.maxSelfReviewIterations;

      const isInitialSubmission = !args.selfReviewVerdict;

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

        await writeStateWithArtifacts(sessDir, result.state);

        return appendNextAction(
          JSON.stringify({
            phase: result.state.phase,
            status: `ADR ${result.state.architecture!.id} submitted: ${args.title}`,
            adrId: result.state.architecture!.id,
            adrDigest: result.state.architecture!.digest,
            selfReviewIteration: 0,
            maxSelfReviewIterations,
            next:
              'Self-review needed. Review the ADR critically against MADR standards. ' +
              'Check for completeness, clarity, and consequences coverage. ' +
              'Then call flowguard_architecture with selfReviewVerdict.',
            _audit: { transitions: result.transitions },
          }),
          result.state,
        );
      } else {
        // ── Mode B: Self-review verdict ──────────────────────────
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

        if (!state.selfReview) {
          return formatBlocked('NO_SELF_REVIEW');
        }
        if (!state.architecture) {
          return formatBlocked('NO_ARCHITECTURE');
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

        // Build updated state
        const nextState: SessionState = {
          ...state,
          architecture: currentAdr,
          selfReview: {
            iteration,
            maxIterations: maxSelfReviewIterations,
            prevDigest,
            currDigest: currentAdr.digest,
            revisionDelta,
            verdict,
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
          return appendNextAction(
            JSON.stringify({
              phase: finalState.phase,
              status: `ADR self-review converged at iteration ${iteration}. ADR approved.`,
              adrId: currentAdr.id,
              adrDigest: currentAdr.digest,
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
            status: `ADR self-review iteration ${iteration}/${maxSelfReviewIterations}. Verdict: ${verdict}.`,
            adrId: currentAdr.id,
            adrDigest: currentAdr.digest,
            selfReviewIteration: iteration,
            revisionDelta,
            next:
              'Review the ADR again. Check if the revisions address all issues. ' +
              'Call flowguard_architecture with selfReviewVerdict.',
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
