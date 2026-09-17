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
import { formatError } from './error-format.js';
import {
  withMutableSession,
  withMutableSessionTransaction,
  formatBlocked,
  persistAndFormat,
} from './helpers.js';
import { getAdapterLogger, getLogTraceFields } from '../../logging/adapter-logger.js';
import type { ReviewVerdict } from '../../state/evidence.js';

// Rails
import { executeReviewDecision } from '../../rails/review-decision.js';

// Identity
import { resolveActorForPolicy } from '../../adapters/actor-context.js';
import { ActorIdentityError } from '../../adapters/actor.js';

// Finalization service
import { finalizeDecision } from '../services/decision-finalization.js';
import { createSessionCompletionAuditDeps } from '../services/regulated-completion.js';
import { consumeUserDecisionIntent, peekUserDecisionIntent } from '../user-decision-intent.js';

// Automatic validation on entry to VALIDATION
import { runActiveChecksAutomatically } from './auto-validation.js';

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

export const decision: ToolDefinition = {
  description:
    'Record a human review decision at a User Gate (PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW). ' +
    "Verdicts: 'approve' (proceed), 'approve_with_governance_override' (accept an exhausted review gate), " +
    "'changes_requested' (revise), 'reject' (end the governed workflow). " +
    'This tool ONLY works at PLAN_REVIEW, EVIDENCE_REVIEW, and ARCH_REVIEW phases. ' +
    'In regulated mode, four-eyes principle is enforced: the reviewer must differ from the session initiator.',
  args: {
    verdict: z
      .enum(['approve', 'approve_with_governance_override', 'changes_requested', 'reject'])
      .describe(
        "Review verdict. 'approve' advances a reviewer-accepted workflow. " +
          "'approve_with_governance_override' accepts an exhausted review gate with a recorded override. " +
          "'changes_requested' returns to revision. " +
          "'reject' ends the governed workflow at REJECTED.",
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

      const settled = await withMutableSessionTransaction(
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
              // Fall back to an empty string here rather than relying on the Zod
              // `.default('')`: the MCP boundary strips null-valued args (some
              // models inject `rationale: null`), which removes the key entirely
              // and leaves the value undefined by the time it reaches state
              // serialization. Without this guard SessionState.safeParse rejects
              // the decision with SCHEMA_VALIDATION_FAILED.
              rationale: args.rationale ?? '',
              decisionIdentity,
            },
            ctx,
          );

          // Approval now stops at EXPORT_READY. Completion side effects belong
          // exclusively to flowguard_export after package verification.
          const finalResult = await finalizeDecision({
            sessDir,
            fingerprint,
            sessionID: context.sessionID,
            priorPhase: state.phase,
            verdict: args.verdict,
            result,
            auditDeps: createSessionCompletionAuditDeps({
              sessDir,
              sessionID: context.sessionID,
              fingerprint,
              state,
            }),
          });

          const persisted = await persistAndFormat(sessDir, finalResult, {
            evidenceApprovalCompletion:
              state.phase === 'EVIDENCE_REVIEW' &&
              (args.verdict === 'approve' || args.verdict === 'approve_with_governance_override'),
          });

          return { kind: 'formatted' as const, output: persisted, finalResult };
        },
      );

      const finalResult = settled.finalResult;
      const output = settled.output;

      // Consume the user-decision intent ONLY on a fully successful decision,
      // and only in human-gated mode. Placing this after finalizeDecision (and
      // after persistAndFormat) guarantees that any failure which produces a
      // non-ok result or throws before this point — schema validation, actor
      // assurance, missing evidence artifacts — leaves the intent intact for
      // retry. A successful decision still burns it exactly once, preserving
      // anti-replay. The consume is in-memory and cannot fail.
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

      // Automatic validation: an approval that lands in VALIDATION runs the
      // active checks in-flow, so the user never has to type a check step. The
      // decision itself is already persisted and audited; the check response
      // (evidence + post-validation phase/directive) supersedes the decision
      // output only when checks actually ran.
      if (finalResult.kind === 'ok' && finalResult.state.phase === 'VALIDATION') {
        const autoValidationResponse = await runActiveChecksAutomatically(context);
        if (autoValidationResponse !== null) return autoValidationResponse;
      }
      return output;
    } catch (err) {
      if (err instanceof ActorIdentityError) {
        return formatBlocked(err.code, { reason: err.message });
      }
      return formatError(err);
    }
  },
};
