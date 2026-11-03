/**
 * @module integration/tools/decision/decision-tool
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

import type { ToolDefinition, ToolResult, WorkspaceToolContext } from '../helpers.js';
import { formatError } from '../error-format.js';
import { formatBlocked } from '../../blocked-result.js';
import { withMutableSessionTransaction } from '../helpers.js';
import { persistAndFormat } from '../helpers-rail-presentation.js';
import { getAdapterLogger, getLogTraceFields } from '../../../logging/adapter-logger.js';
import { ReviewVerdict, type ActorInfo } from '../../../state/evidence.js';
import type { SessionState } from '../../../state/schema.js';
import type { RailResult } from '../../../rails/types.js';
import type { SemanticAuditIntent } from '../../audit-outbox.js';
import { TOOL_FLOWGUARD_DECISION } from '../../tool-names.js';
import { requiresGovernanceOverride } from '../../../machine/workflow-directive.js';

// Rails
import { executeReviewDecision } from '../../../rails/review-decision.js';

// Identity
import { resolveActorForPolicy } from '../../../adapters/actor-context.js';
import { ActorIdentityError } from '../../../adapters/actor.js';

// Finalization service
import { finalizeDecision } from '../../services/decision-finalization.js';
import { buildDecisionAuditIntent } from '../../services/decision-audit-intent.js';
import { createSessionCompletionAuditDeps } from '../../services/regulated-completion.js';
import {
  DecisionArgsSchema,
  readDecisionInvocation,
  verifyDecisionInvocation,
  type DecisionInvocation,
} from '../../workflow-decision-invocation.js';
import {
  attestApprovalWorktreeSubject,
  attestReducedCeremonySubject,
} from '../reduced-ceremony-attestation.js';

// Automatic validation on entry to VALIDATION
import {
  decidePostCommandAutoValidation,
  runActiveChecksAutomatically,
} from '../auto-validation.js';

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_decision — Human Verdict at User Gates
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The agent never owns a user gate. When it calls the decision tool on its own,
 * the refusal names the command the USER must run and, at an exhausted review
 * gate, the only admissible override path.
 */
function decisionOriginAgentInstruction(state: SessionState): string {
  return requiresGovernanceOverride(state)
    ? 'Do not call flowguard_decision yourself. The independent review is exhausted: present the governance override option and ask the user to run /override-approve with a durable rationale, or /request-changes to revise the artifact.'
    : 'Do not call flowguard_decision yourself. Ask the user to run /approve, /request-changes, or /reject; only the user may decide this gate.';
}

type DecisionFinalization = Awaited<ReturnType<typeof finalizeDecision>>;

interface PersistedDecision {
  readonly output: ToolResult;
  readonly finalResult: DecisionFinalization;
}

/**
 * Build the durable decision receipt for a successful decision.
 *
 * The sequence is reserved under the already-held session write lock from
 * persisted receipts plus committed-but-unreconciled semantic operations; the
 * builder only formats it. The intent is committed atomically with the
 * decision, BEFORE any automatic validation runs in the same tool call.
 */
async function decisionReceiptIntents(input: {
  readonly sessDir: string;
  readonly sessionID: string;
  readonly finalResult: RailResult;
  readonly auditDeps: { nextDecisionSequence(sessDir: string, sessionId: string): Promise<number> };
  readonly actor: string;
  /** The actor that actually decided — never the session initiator's ActorInfo. */
  readonly actorInfo: ActorInfo;
  readonly invocation: DecisionInvocation | undefined;
}): Promise<readonly SemanticAuditIntent[]> {
  const { finalResult } = input;
  if (finalResult.kind !== 'ok') return [];
  const decision = finalResult.decisionEvidence;
  const transition = finalResult.transitions[0];
  if (decision === undefined || transition === undefined) return [];
  const decisionSequence = await input.auditDeps.nextDecisionSequence(
    input.sessDir,
    input.sessionID,
  );
  return [
    buildDecisionAuditIntent({
      transition,
      decision,
      policyMode: finalResult.state.policySnapshot.mode,
      decisionSequence,
      actor: input.actor,
      actorInfo: input.actorInfo,
      ...(input.invocation === undefined ? {} : { operation: input.invocation.operation }),
    }),
  ];
}

/**
 * Bind every final full-review approval to the live governed subject: an
 * unchanged session state does not prove the worktree bytes still match the
 * reviewed implementation. Reduced ceremony keeps its own binding path
 * (implReview is null there); this check covers the full independent review.
 */
async function approvedFullReviewWorktreeBlock(input: {
  readonly state: SessionState;
  readonly verdict: ReviewVerdict;
  readonly worktree: string;
  readonly digest: (text: string) => string;
}): Promise<PersistedDecision | null> {
  if (
    input.state.phase !== 'EVIDENCE_REVIEW' ||
    input.state.implReview === null ||
    (input.verdict !== 'approve' && input.verdict !== 'approve_with_governance_override')
  ) {
    return null;
  }
  const worktreeAttestation = await attestApprovalWorktreeSubject({
    state: input.state,
    worktree: input.worktree,
    digest: input.digest,
  });
  if (worktreeAttestation?.kind !== 'subject_changed') return null;
  return {
    output: formatBlocked(
      'IMPLEMENTATION_REVIEW_SUBJECT_MISMATCH',
      {
        reviewedDigest: worktreeAttestation.expected,
        currentDigest: worktreeAttestation.actual,
      },
      { phase: input.state.phase },
    ),
    finalResult: {
      kind: 'blocked',
      code: 'IMPLEMENTATION_REVIEW_SUBJECT_MISMATCH',
      reason: 'The governed worktree no longer matches the reviewed implementation.',
    },
  };
}

function missingCommandDecision(state: SessionState): PersistedDecision {
  return {
    output: formatBlocked(
      'HUMAN_DECISION_REQUIRED',
      { reason: 'missing host-command operation' },
      { agentInstruction: decisionOriginAgentInstruction(state) },
    ),
    finalResult: {
      kind: 'blocked',
      code: 'HUMAN_DECISION_REQUIRED',
      reason: 'An explicit host-command decision is required by the frozen policy.',
    },
  };
}

async function persistHumanDecision(
  context: WorkspaceToolContext,
  args: { readonly verdict: ReviewVerdict; readonly rationale: string },
): Promise<PersistedDecision> {
  return withMutableSessionTransaction(
    context,
    async ({ fingerprint, sessDir, state, policy, ctx }) => {
      const probe = { context, state, verdict: args.verdict, rationale: args.rationale };
      const invocation = readDecisionInvocation(probe);
      if (policy.requireHumanGates && invocation?.operation.source !== 'host_command')
        return missingCommandDecision(state);
      if (invocation !== undefined) await verifyDecisionInvocation(invocation, probe);
      const actorInfo = await resolveActorForPolicy(context.worktree, policy);
      const worktreeBlock = await approvedFullReviewWorktreeBlock({
        state,
        verdict: args.verdict,
        worktree: context.worktree,
        digest: ctx.digest,
      });
      if (worktreeBlock) return worktreeBlock;

      // P30/P34: Build structured decision identity directly from resolved actor info
      // actorAssurance comes from the canonical ActorInfo — not re-derived from source
      const decisionIdentity = {
        actorId: actorInfo.id,
        actorEmail: actorInfo.email,
        actorDisplayName: actorInfo.displayName,
        actorSource: actorInfo.source,
        actorAssurance: actorInfo.assurance,
      };
      const actor = policy.actorClassification[TOOL_FLOWGUARD_DECISION] ?? 'system';

      // Reduced-ceremony approval binding: the integration boundary re-attests
      // the frozen worktree bytes; the rail checks the outcome. Non-reduced
      // decisions receive no attestation.
      const subjectAttestation = await attestReducedCeremonySubject({
        state,
        worktree: context.worktree,
        digest: ctx.digest,
      });

      const result = executeReviewDecision(
        state,
        {
          verdict: args.verdict,
          rationale: args.rationale,
          decisionIdentity,
          ...(subjectAttestation !== null ? { subjectAttestation } : {}),
        },
        ctx,
      );

      const auditDeps = createSessionCompletionAuditDeps({
        sessDir,
        sessionID: context.sessionID,
        fingerprint,
        state,
      });

      // Approval now stops at EXPORT_READY. Completion side effects belong
      // exclusively to flowguard_export after package verification.
      const finalResult = await finalizeDecision({
        sessDir,
        fingerprint,
        sessionID: context.sessionID,
        priorPhase: state.phase,
        verdict: args.verdict,
        result,
        auditDeps,
      });

      const semanticIntents = await decisionReceiptIntents({
        sessDir,
        sessionID: context.sessionID,
        finalResult,
        auditDeps,
        actor,
        actorInfo,
        invocation,
      });

      const persisted = await persistAndFormat(sessDir, finalResult, {
        evidenceApprovalCompletion:
          state.phase === 'EVIDENCE_REVIEW' &&
          (args.verdict === 'approve' || args.verdict === 'approve_with_governance_override'),
        semanticIntents,
      });
      if (finalResult.kind === 'ok' && invocation !== undefined) invocation.committed = true;

      return { output: persisted, finalResult };
    },
  );
}

const DecisionArgs = DecisionArgsSchema;
export const decision: ToolDefinition = {
  description:
    'Record a human review decision at a User Gate (PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW). ' +
    "Verdicts: 'approve' (proceed), 'approve_with_governance_override' (accept an exhausted review gate), " +
    "'changes_requested' (revise), 'reject' (end the governed workflow). " +
    'This tool ONLY works at PLAN_REVIEW, EVIDENCE_REVIEW, and ARCH_REVIEW phases. ' +
    'In regulated mode, four-eyes principle is enforced: the reviewer must differ from the session initiator.',
  args: DecisionArgs.shape,
  async execute(args, context) {
    try {
      const parsed = DecisionArgs.parse(args);
      const settled = await persistHumanDecision(context, parsed);
      const finalResult = settled.finalResult;
      const output = settled.output;

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
      if (finalResult.kind === 'ok') {
        const outputText = typeof output === 'string' ? output : output.output;
        const autoValidation = decidePostCommandAutoValidation({
          response: outputText,
          phase: finalResult.state.phase,
        });
        if (autoValidation.kind === 'run') {
          const autoValidationResponse = await runActiveChecksAutomatically(context);
          if (autoValidationResponse !== null) return autoValidationResponse;
        }
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
