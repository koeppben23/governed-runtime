import { isTerminalPhase } from '../../machine/topology.js';
import type { ArchiveFinding } from '../../archive/types.js';
import type { ChainedAuditEvent } from '../../audit/types.js';
import type { SessionState } from '../../state/schema.js';
import type { DecisionIdentity } from '../../state/evidence-identity.js';

// eslint-disable-next-line complexity -- each branch maps a distinct regulated archive finding.
export function verifyRegulatedCompletionCompleteness(
  state: SessionState | null,
  events: readonly ChainedAuditEvent[],
  findings: ArchiveFinding[],
): void {
  if (!state || state.policySnapshot.mode !== 'regulated' || !state.regulatedArchiveStatus) return;
  // A regulated completion archive must never contain a non-terminal or
  // failed snapshot. Fail closed here — skipping would let an incomplete
  // archive pass every other integrity check.
  if (!isTerminalPhase(state.phase) || state.error) {
    findings.push({
      code: 'regulated_terminal_transition_missing',
      severity: 'error',
      message: 'Regulated completion archive lacks terminal completion authority',
      file: 'state/session-state.json',
    });
    return;
  }
  if (state.pendingAuditOperations.some((operation) => operation.status !== 'reconciled')) {
    findings.push({
      code: 'regulated_audit_outbox_unreconciled',
      severity: 'error',
      message: 'Regulated completion archive contains unreconciled audit operations',
      file: 'state/session-state.json',
    });
  }
  const transition = state.transition;
  const isExactCompletionTransition =
    !!transition &&
    transition.from === 'EVIDENCE_REVIEW' &&
    transition.to === 'COMPLETE' &&
    transition.event === 'APPROVE';
  if (!isExactCompletionTransition) {
    findings.push({
      code: 'regulated_terminal_transition_missing',
      severity: 'error',
      message:
        'Regulated completion archive lacks the authoritative EVIDENCE_REVIEW APPROVE to COMPLETE transition',
      file: 'state/session-state.json',
    });
    return;
  }
  const decision = state.reviewDecision;
  if (!decision || decision.verdict !== 'approve') {
    findings.push({
      code: 'regulated_terminal_decision_invalid',
      severity: 'error',
      message:
        'Regulated completion archive lacks the bound approval decision authority in reviewDecision',
      file: 'state/session-state.json',
    });
    return;
  }
  const transitionIndex = locateCompletionEvidence(events, transition);
  addCompletenessFindings(
    findings,
    transitionIndex.transitionIndex,
    transitionIndex.decisions.length,
    transitionIndex.lifecycle.length,
  );
  const { decisions, lifecycle } = transitionIndex;
  if (
    transitionIndex.transitionIndex >= 0 &&
    decisions.length === 1 &&
    lifecycle.length === 1 &&
    !(
      transitionIndex.transitionIndex < decisions[0]!.index &&
      decisions[0]!.index < lifecycle[0]!.index
    )
  ) {
    findings.push({
      code: 'regulated_completion_order_invalid',
      severity: 'error',
      message:
        'Regulated completion evidence must order transition, decision, then session_completed',
      file: 'audit/audit.jsonl',
    });
  }
  if (decisions.length === 1) {
    addDecisionBindingFindings(findings, decisions[0]!.event, decision);
  }
}

interface CompletionEvidence {
  readonly transitionIndex: number;
  readonly decisions: ReadonlyArray<{ event: ChainedAuditEvent; index: number }>;
  readonly lifecycle: ReadonlyArray<{ event: ChainedAuditEvent; index: number }>;
}

function locateCompletionEvidence(
  events: readonly ChainedAuditEvent[],
  transition: NonNullable<SessionState['transition']>,
): CompletionEvidence {
  const transitionIndex = events.findIndex(
    (event) =>
      event.detail.kind === 'transition' &&
      event.detail.from === transition.from &&
      event.detail.to === transition.to &&
      event.detail.event === transition.event &&
      event.occurredAt === transition.at,
  );
  const decisions = events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        event.detail.kind === 'decision' &&
        event.detail.fromPhase === transition.from &&
        event.detail.toPhase === transition.to &&
        event.detail.transitionEvent === transition.event,
    );
  const lifecycle = events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        event.event === 'lifecycle:session_completed' &&
        event.detail.action === 'session_completed' &&
        event.detail.finalPhase === transition.to,
    );
  return { transitionIndex, decisions, lifecycle };
}

function addDecisionBindingFindings(
  findings: ArchiveFinding[],
  event: ChainedAuditEvent,
  decision: NonNullable<SessionState['reviewDecision']>,
): void {
  const { detail } = event;
  if (
    detail.verdict !== decision.verdict ||
    detail.rationale !== decision.rationale ||
    detail.decidedBy !== decision.decidedBy ||
    detail.decidedAt !== decision.decidedAt
  ) {
    findings.push({
      code: 'regulated_terminal_decision_invalid',
      severity: 'error',
      message:
        'Regulated completion decision receipt does not bind the persisted reviewDecision authority',
      file: 'audit/audit.jsonl',
    });
  }
  if (decision.decisionIdentity) {
    addDecisionIdentityBindingFindings(findings, detail, decision.decisionIdentity);
  }
  if (event.actor !== (decision.decisionIdentity?.actorId ?? decision.decidedBy)) {
    findings.push({
      code: 'regulated_terminal_decision_invalid',
      severity: 'error',
      message: 'Regulated completion decision receipt actor does not match the deciding authority',
      file: 'audit/audit.jsonl',
    });
  }
}

function addDecisionIdentityBindingFindings(
  findings: ArchiveFinding[],
  detail: Readonly<Record<string, unknown>>,
  identity: DecisionIdentity,
): void {
  const eventIdentity = detail.decisionIdentity as Partial<DecisionIdentity> | undefined;
  if (
    !eventIdentity ||
    eventIdentity.actorId !== identity.actorId ||
    eventIdentity.actorEmail !== identity.actorEmail ||
    eventIdentity.actorSource !== identity.actorSource ||
    eventIdentity.actorAssurance !== identity.actorAssurance ||
    (eventIdentity.actorDisplayName ?? null) !== (identity.actorDisplayName ?? null)
  ) {
    findings.push({
      code: 'regulated_terminal_decision_invalid',
      severity: 'error',
      message:
        'Regulated completion decision receipt decisionIdentity does not match the persisted decision identity',
      file: 'audit/audit.jsonl',
    });
  }
}

function addCompletenessFindings(
  findings: ArchiveFinding[],
  transitionIndex: number,
  decisionCount: number,
  lifecycleCount: number,
): void {
  if (transitionIndex < 0)
    findings.push({
      code: 'regulated_terminal_transition_missing',
      severity: 'error',
      message: 'Regulated completion archive lacks terminal transition audit evidence',
      file: 'audit/audit.jsonl',
    });
  if (decisionCount !== 1)
    findings.push({
      code: 'regulated_terminal_decision_invalid',
      severity: 'error',
      message: `Regulated completion archive requires exactly one terminal approval decision; found ${decisionCount}`,
      file: 'audit/audit.jsonl',
    });
  if (lifecycleCount !== 1)
    findings.push({
      code: 'regulated_completion_lifecycle_invalid',
      severity: 'error',
      message: `Regulated completion archive requires exactly one session_completed event; found ${lifecycleCount}`,
      file: 'audit/audit.jsonl',
    });
}
