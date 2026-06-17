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
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import type { ReviewVerdict } from '../../state/evidence.js';

// Rails
import { executeReviewDecision } from '../../rails/review-decision.js';

// Identity
import { resolveActorForPolicy } from '../../adapters/actor-context.js';
import { ActorIdentityError } from '../../adapters/actor.js';

// Finalization service
import { finalizeDecision } from '../services/decision-finalization.js';
import { consumeUserDecisionIntent } from '../user-decision-intent.js';

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_decision — Human Verdict at User Gates
// ═══════════════════════════════════════════════════════════════════════════════

function requireHumanDecisionIntent(input: {
  readonly sessionId: string;
  readonly verdict: ReviewVerdict;
  readonly requireHumanGates: boolean;
}): string | null {
  if (!input.requireHumanGates) return null;
  const consumed = consumeUserDecisionIntent({
    sessionId: input.sessionId,
    verdict: input.verdict,
  });
  if (consumed.ok) return null;
  return formatBlocked('HUMAN_DECISION_REQUIRED', {
    reason: consumed.reason,
  });
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
      const humanOriginBlocked = requireHumanDecisionIntent({
        sessionId: context.sessionID,
        verdict: args.verdict,
        requireHumanGates: probe.policy.requireHumanGates === true,
      });
      if (humanOriginBlocked) {
        getAdapterLogger().warn('tool', 'decision_origin_missing', {
          sessionId: context.sessionID,
          code: 'HUMAN_DECISION_REQUIRED',
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
          // P30/P34: Build structured decision identity directly from resolved actor info
          // actorAssurance comes from the canonical ActorInfo — not re-derived from source
          const decisionIdentity = {
            actorId: actorInfo.id,
            actorEmail: actorInfo.email,
            actorDisplayName: actorInfo.displayName,
            actorSource: actorInfo.source,
            actorAssurance: actorInfo.assurance,
          };

          const result = executeReviewDecision(
            state,
            {
              verdict: args.verdict,
              rationale: args.rationale,
              decidedBy: actorInfo.id,
              decisionIdentity,
            },
            ctx,
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

          const persisted = await persistAndFormat(sessDir, finalResult);
          if (finalResult.kind === 'ok') {
            getAdapterLogger().info('tool', 'decision_persisted', {
              sessionId: context.sessionID,
              verdict: args.verdict,
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
