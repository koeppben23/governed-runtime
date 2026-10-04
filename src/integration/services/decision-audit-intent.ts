/**
 * @module integration/services/decision-audit-intent
 * @description Pure authority for the durable human-decision audit intent.
 *
 * A successful `/review-decision` commits its receipt as a semantic outbox
 * operation in the SAME state write as the decision itself. The receipt is
 * therefore independent of any automatic system work (validation) that runs
 * afterwards in the same tool call, and independent of the final state: the
 * exact decision evidence — verdict, rationale, identity, decidedAt — is
 * captured before any verdict-specific state clearing.
 *
 * The builder receives an already reserved sequence and never allocates IDs;
 * sequence reservation happens under the caller's session write lock.
 */

import type { ActorInfo, AuditEvent, ReviewDecision } from '../../state/evidence.js';
import type { PendingAuditOperation } from '../../state/schema.js';
import type { TransitionRecord } from '../../rails/types.js';
import type { SemanticAuditIntent } from '../audit-outbox.js';

export interface BuildDecisionAuditIntentInput {
  readonly transition: TransitionRecord;
  readonly decision: ReviewDecision;
  readonly policyMode: string;
  readonly decisionSequence: number;
  /**
   * Frozen policy classification of the deciding tool (`human`, `machine`,
   * `system`). The concrete identity travels in `decisionIdentity`/`actorInfo`.
   */
  readonly actor: string;
  readonly actorInfo?: ActorInfo;
}

/** Build the durable semantic intent for one human decision. Pure. */
export function buildDecisionAuditIntent(
  input: BuildDecisionAuditIntentInput,
): SemanticAuditIntent {
  const { transition, decision, policyMode, decisionSequence } = input;
  const decisionId = `DEC-${String(decisionSequence).padStart(3, '0')}`;
  return {
    phase: transition.from,
    event: `decision:${decisionId}`,
    occurredAt: decision.decidedAt,
    detail: {
      kind: 'decision',
      gatePhase: transition.from,
      decisionId,
      decisionSequence,
      verdict: decision.verdict,
      rationale: decision.rationale,
      decisionIdentity: decision.decisionIdentity,
      decidedAt: decision.decidedAt,
      fromPhase: transition.from,
      toPhase: transition.to,
      transitionEvent: transition.event,
      policyMode,
    },
    actor: input.actor,
    ...(input.actorInfo !== undefined ? { actorInfo: input.actorInfo } : {}),
  };
}

function decisionSequenceOf(detail: Record<string, unknown>): number {
  return detail.kind === 'decision' && typeof detail.decisionSequence === 'number'
    ? detail.decisionSequence
    : 0;
}

/**
 * Reserve the next decision sequence under the caller's session write lock.
 *
 * Considers persisted decision receipts AND committed-but-unreconciled
 * semantic operations, so a crash between the state commit and the audit
 * append can never cause a duplicate DEC number after restart.
 */
export function resolveDecisionSequence(
  events: readonly AuditEvent[],
  pendingOperations: readonly PendingAuditOperation[],
): number {
  let maxSequence = 0;
  for (const event of events) {
    maxSequence = Math.max(maxSequence, decisionSequenceOf(event.detail));
  }
  for (const operation of pendingOperations) {
    if (operation.kind !== 'semantic') continue;
    maxSequence = Math.max(maxSequence, decisionSequenceOf(operation.semantic.detail));
  }
  return maxSequence + 1;
}
