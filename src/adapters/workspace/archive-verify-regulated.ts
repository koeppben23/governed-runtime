import { isTerminalPhase } from '../../machine/topology.js';
import type { ArchiveFinding } from '../../archive/types.js';
import type { ChainedAuditEvent } from '../../audit/types.js';
import type { SessionState } from '../../state/schema.js';
import { isApprovalVerdict } from '../../state/evidence.js';
import type { DecisionIdentity } from '../../state/evidence-identity.js';

function isRegulatedCompletionArchive(state: SessionState | null): state is SessionState {
  return !!state && state.policySnapshot.mode === 'regulated' && !!state.regulatedArchiveStatus;
}

function ensureTerminalState(state: SessionState, findings: ArchiveFinding[]): boolean {
  // A regulated completion archive must never contain a non-terminal or
  // failed snapshot. Fail closed here — skipping would let an incomplete
  // archive pass every other integrity check.
  if (isTerminalPhase(state.phase) && !state.error) return true;
  findings.push({
    code: 'regulated_terminal_transition_missing',
    severity: 'error',
    message: 'Regulated completion archive lacks terminal completion authority',
    file: 'state/session-state.json',
  });
  return false;
}

function addUnreconciledOperationFindings(state: SessionState, findings: ArchiveFinding[]): void {
  if (!state.pendingAuditOperations.some((operation) => operation.status !== 'reconciled')) return;
  findings.push({
    code: 'regulated_audit_outbox_unreconciled',
    severity: 'error',
    message: 'Regulated completion archive contains unreconciled audit operations',
    file: 'state/session-state.json',
  });
}

function addCompletionEvidenceFindings(
  events: readonly ChainedAuditEvent[],
  transition: NonNullable<SessionState['transition']>,
  decision: NonNullable<SessionState['reviewDecision']>,
  actorClassification: Readonly<Record<string, string>>,
  findings: ArchiveFinding[],
): void {
  const completionEvidence = locateCompletionEvidence(events, transition);
  addCompletenessFindings(
    findings,
    completionEvidence.approvalTransitionIndex,
    completionEvidence.exportTransitionIndex,
    completionEvidence.decisions.length,
    completionEvidence.lifecycle.length,
  );
  const { decisions } = completionEvidence;
  const [decisionEntry] = decisions;
  if (!hasValidCompletionOrder(completionEvidence)) {
    findings.push({
      code: 'regulated_completion_order_invalid',
      severity: 'error',
      message:
        'Regulated completion evidence must order the approval transition, decision, export transition, then session_completed',
      file: 'audit/audit.jsonl',
    });
  }
  if (decisions.length === 1 && decisionEntry !== undefined) {
    addDecisionBindingFindings(findings, decisionEntry.event, decision, actorClassification);
  }
}

export function verifyRegulatedCompletionCompleteness(
  state: SessionState | null,
  events: readonly ChainedAuditEvent[],
  findings: ArchiveFinding[],
): void {
  if (!isRegulatedCompletionArchive(state)) return;
  if (!ensureTerminalState(state, findings)) return;
  addUnreconciledOperationFindings(state, findings);
  const transition = state.transition;
  const isExactCompletionTransition =
    !!transition &&
    transition.from === 'EXPORT_READY' &&
    transition.to === 'COMPLETE' &&
    transition.event === 'EXPORT_MATERIALIZED';
  if (!isExactCompletionTransition) {
    findings.push({
      code: 'regulated_terminal_transition_missing',
      severity: 'error',
      message:
        'Regulated completion archive lacks the authoritative EXPORT_READY EXPORT_MATERIALIZED to COMPLETE transition',
      file: 'state/session-state.json',
    });
    return;
  }
  const decision = state.reviewDecision;
  if (!decision || !isApprovalVerdict(decision.verdict)) {
    findings.push({
      code: 'regulated_terminal_decision_invalid',
      severity: 'error',
      message:
        'Regulated completion archive lacks the bound approval decision authority in reviewDecision',
      file: 'state/session-state.json',
    });
    return;
  }
  addCompletionEvidenceFindings(
    events,
    transition,
    decision,
    state.policySnapshot.actorClassification,
    findings,
  );
}

/**
 * Whether completion evidence orders the approval transition, the decision,
 * the export transition, and the session_completed event.
 */
function hasValidCompletionOrder(evidence: CompletionEvidence): boolean {
  const { approvalTransitionIndex, exportTransitionIndex, decisions, lifecycle } = evidence;
  const [decisionEntry] = decisions;
  const [lifecycleEntry] = lifecycle;
  if (
    approvalTransitionIndex < 0 ||
    exportTransitionIndex < 0 ||
    decisionEntry === undefined ||
    lifecycleEntry === undefined ||
    decisions.length !== 1 ||
    lifecycle.length !== 1
  ) {
    return false;
  }
  return (
    approvalTransitionIndex < decisionEntry.index &&
    decisionEntry.index < lifecycleEntry.index &&
    approvalTransitionIndex < exportTransitionIndex &&
    exportTransitionIndex < lifecycleEntry.index
  );
}

interface CompletionEvidence {
  readonly approvalTransitionIndex: number;
  readonly exportTransitionIndex: number;
  readonly decisions: ReadonlyArray<{ event: ChainedAuditEvent; index: number }>;
  readonly lifecycle: ReadonlyArray<{ event: ChainedAuditEvent; index: number }>;
}

function locateCompletionEvidence(
  events: readonly ChainedAuditEvent[],
  transition: NonNullable<SessionState['transition']>,
): CompletionEvidence {
  const approvalTransitionIndex = events.findIndex(
    (event) =>
      event.detail.kind === 'transition' &&
      event.detail.from === 'EVIDENCE_REVIEW' &&
      event.detail.to === 'EXPORT_READY' &&
      event.detail.event === 'APPROVE',
  );
  const exportTransitionIndex = events.findIndex(
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
        event.detail.fromPhase === 'EVIDENCE_REVIEW' &&
        event.detail.toPhase === 'EXPORT_READY' &&
        event.detail.transitionEvent === 'APPROVE',
    );
  const lifecycle = events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        event.event === 'lifecycle:session_completed' &&
        event.detail.action === 'session_completed' &&
        event.detail.finalPhase === transition.to,
    );
  return { approvalTransitionIndex, exportTransitionIndex, decisions, lifecycle };
}

function addDecisionBindingFindings(
  findings: ArchiveFinding[],
  event: ChainedAuditEvent,
  decision: NonNullable<SessionState['reviewDecision']>,
  actorClassification: Readonly<Record<string, string>>,
): void {
  const { detail } = event;
  if (
    detail.verdict !== decision.verdict ||
    detail.rationale !== decision.rationale ||
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
  addDecisionIdentityBindingFindings(findings, detail, decision.decisionIdentity);
  addDecisionActorBindingFindings(findings, event, decision, actorClassification);
}

/**
 * The receipt actor must be either the frozen policy classification for the
 * decision tool (current receipts) or the deciding actor id (archives created
 * before the classification contract). Every other value is a contradiction
 * inside the audit envelope and fails closed.
 */
function addDecisionActorBindingFindings(
  findings: ArchiveFinding[],
  event: ChainedAuditEvent,
  decision: NonNullable<SessionState['reviewDecision']>,
  actorClassification: Readonly<Record<string, string>>,
): void {
  const frozenClassification = actorClassification['flowguard_decision'];
  const matchesLegacyActorId = event.actor === decision.decisionIdentity.actorId;
  const matchesFrozenClassification =
    frozenClassification !== undefined && event.actor === frozenClassification;
  if (!matchesLegacyActorId && !matchesFrozenClassification) {
    findings.push({
      code: 'regulated_terminal_decision_invalid',
      severity: 'error',
      message:
        'Regulated completion decision receipt actor is neither the frozen policy classification nor the deciding authority',
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
  approvalTransitionIndex: number,
  exportTransitionIndex: number,
  decisionCount: number,
  lifecycleCount: number,
): void {
  if (approvalTransitionIndex < 0)
    findings.push({
      code: 'regulated_terminal_transition_missing',
      severity: 'error',
      message: 'Regulated completion archive lacks the approval transition audit evidence',
      file: 'audit/audit.jsonl',
    });
  if (exportTransitionIndex < 0)
    findings.push({
      code: 'regulated_terminal_transition_missing',
      severity: 'error',
      message: 'Regulated completion archive lacks the export transition audit evidence',
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
