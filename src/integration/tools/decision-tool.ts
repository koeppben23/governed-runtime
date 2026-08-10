/**
 * @module integration/tools/decision-tool
 * @description FlowGuard decision tool — record human review verdict at User Gates.
 *
 * Records a human review decision at PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW.
 * In regulated mode, four-eyes principle is enforced: the reviewer must differ
 * from the session initiator.
 *
 * Post-rail finalization is delegated to the decision-finalization service:
 * - MADR artifact writing for architecture completions
 * - P26 regulated completion (audit emit → archive → verify)
 *
 * @version v1
 */

import { z } from 'zod';

import type { ToolDefinition } from './helpers.js';
import {
  withMutableSession,
  withMutableSessionTransaction,
  formatBlocked,
  formatError,
  persistAndFormat,
} from './helpers.js';
import { getAdapterLogger, getLogTraceFields } from '../../logging/adapter-logger.js';
import type { ReviewVerdict } from '../../state/evidence.js';

// Rails
import { executeReviewDecision } from '../../rails/review-decision.js';

// Identity
import { resolveActorForPolicy } from '../../adapters/actor-context.js';
import { ActorIdentityError } from '../../adapters/actor.js';

// Candidate observation
import { resolveImplementationApprovalObservation } from '../implementation-candidate.js';

// Finalization service
import { finalizeDecision } from '../services/decision-finalization.js';
import { consumeUserDecisionIntent, peekUserDecisionIntent } from '../user-decision-intent.js';

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_decision — Human Verdict at User Gates
// ═══════════════════════════════════════════════════════════════════════════════

function requireHumanDecisionIntent(input: {
  readonly sessionId: string;
  readonly verdict: ReviewVerdict;
  readonly requireHumanGates: boolean;
}): string | null {
  if (!input.requireHumanGates) return null;
  // Non-destructive gate: a valid intent is left in place so that a decision
  // failing at a later, independent stage (schema validation, actor assurance)
  // can be retried without the user re-issuing the /approve command. The intent
  // is only consumed once the decision is actually processed (see execute()).
  // Anti-replay for expired/verdict_mismatch is still enforced inside peek.
  const gate = peekUserDecisionIntent({
    sessionId: input.sessionId,
    verdict: input.verdict,
  });
  if (gate.ok) return null;
  return formatBlocked('HUMAN_DECISION_REQUIRED', {
    reason: gate.reason,
  });
}

async function resolveApprovalObservation(
  verdict: ReviewVerdict,
  state: import('../../state/schema.js').SessionState,
  worktree: string,
): Promise<import('../../rails/review-decision.js').ReviewDecisionRuntimeEvidence> {
  if (state.phase !== 'EVIDENCE_REVIEW' || verdict !== 'approve') return {};
  const observation = await resolveImplementationApprovalObservation(state, worktree);
  return observation ? { implementationApprovalObservation: observation } : {};
}

export const decision: ToolDefinition = {
  description:
    'Record a human review decision at a User Gate (PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW). ' +
    "Verdicts: 'approve' (proceed), 'changes_requested' (revise), 'reject' (restart from ticket). " +
    'This tool ONLY works at PLAN_REVIEW, EVIDENCE_REVIEW, and ARCH_REVIEW phases. ' +
    'In regulated mode, four-eyes principle is enforced: the reviewer must differ from the session initiator.',
  args: {
    verdict: z
      .enum(['approve', 'changes_requested', 'reject'])
      .describe(
        "Review verdict. 'approve' advances the workflow. " +
          "'changes_requested' returns to revision. " +
          "'reject' restarts from TICKET (or READY for architecture flow).",
      ),
    rationale: z.string().default('').describe('Reason for the decision. Recorded in audit trail.'),
  },
  async execute(args, context) {
    try {
      const probe = await withMutableSession(context);
      const requireHumanGates = probe.policy.requireHumanGates === true;
      const humanOriginBlocked = requireHumanDecisionIntent({
        sessionId: context.sessionID,
        verdict: args.verdict,
        requireHumanGates,
      });
      if (humanOriginBlocked) {
        getAdapterLogger().warn('tool', 'decision_origin_missing', {
          sessionId: context.sessionID,
          code: 'HUMAN_DECISION_REQUIRED',
          ...getLogTraceFields(),
        });
        return humanOriginBlocked;
      }

      const actorInfo = await resolveActorForPolicy(
        context.worktree || context.directory,
        probe.policy,
      );

      return await withMutableSessionTransaction(
        context,
        async ({ fingerprint, sessDir, state, ctx }) => {
          // P30/P34: Structured decision identity from resolved actor info
          const result = executeReviewDecision(
            state,
            {
              verdict: args.verdict,
              rationale: args.rationale ?? '',
              decidedBy: actorInfo.id,
              decisionIdentity: {
                actorId: actorInfo.id,
                actorEmail: actorInfo.email,
                actorDisplayName: actorInfo.displayName,
                actorSource: actorInfo.source,
                actorAssurance: actorInfo.assurance,
              },
            },
            ctx,
            await resolveApprovalObservation(
              args.verdict,
              state,
              context.worktree || context.directory,
            ),
          );

          // Delegate post-rail finalization (MADR + P26 regulated completion)
          const finalResult = await finalizeDecision({
            sessDir,
            fingerprint,
            sessionID: context.sessionID,
            priorPhase: state.phase,
            verdict: args.verdict,
            result,
          });

          const persisted = await persistAndFormat(sessDir, finalResult, {
            evidenceApprovalCompletion:
              state.phase === 'EVIDENCE_REVIEW' && args.verdict === 'approve',
          });

          // Consume user-decision intent on success only — failures leave intent for retry
          if (requireHumanGates && finalResult.kind === 'ok') {
            consumeUserDecisionIntent({
              sessionId: context.sessionID,
              verdict: args.verdict,
            });
          }

          if (finalResult.kind === 'ok') {
            getAdapterLogger().info('tool', 'decision_persisted', {
              sessionId: context.sessionID,
              verdict: args.verdict,
              ...getLogTraceFields(),
            });
          }
          return persisted;
        },
      );
    } catch (err) {
      if (err instanceof ActorIdentityError) {
        return formatBlocked(err.code, { reason: err.message });
      }
      return formatError(err);
    }
  },
};
