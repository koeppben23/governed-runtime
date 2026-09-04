import { isTerminalPhase } from '../../machine/topology.js';
import type { ArchiveFinding } from '../../archive/types.js';
import type { ChainedAuditEvent } from '../../audit/types.js';
import type { SessionState } from '../../state/schema.js';

// eslint-disable-next-line complexity -- each branch maps a distinct regulated archive finding.
export function verifyRegulatedCompletionCompleteness(
  state: SessionState | null,
  events: readonly ChainedAuditEvent[],
  findings: ArchiveFinding[],
): void {
  if (
    state?.policySnapshot.mode !== 'regulated' ||
    !isTerminalPhase(state.phase) ||
    state.error ||
    !state.regulatedArchiveStatus
  )
    return;
  if (state.pendingAuditOperations.some((operation) => operation.status !== 'reconciled')) {
    findings.push({
      code: 'regulated_audit_outbox_unreconciled',
      severity: 'error',
      message: 'Regulated completion archive contains unreconciled audit operations',
      file: 'state/session-state.json',
    });
  }
  const transition = state.transition;
  if (!transition || transition.from !== 'EVIDENCE_REVIEW' || !isTerminalPhase(transition.to)) {
    findings.push({
      code: 'regulated_terminal_transition_missing',
      severity: 'error',
      message:
        'Regulated completion archive lacks the authoritative EVIDENCE_REVIEW to COMPLETE transition',
      file: 'state/session-state.json',
    });
    return;
  }
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
        event.detail.transitionEvent === transition.event &&
        event.detail.verdict === 'approve',
    );
  const lifecycle = events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        event.event === 'lifecycle:session_completed' &&
        event.detail.action === 'session_completed',
    );
  addCompletenessFindings(findings, transitionIndex, decisions.length, lifecycle.length);
  if (
    transitionIndex >= 0 &&
    decisions.length === 1 &&
    lifecycle.length === 1 &&
    !(transitionIndex < decisions[0]!.index && decisions[0]!.index < lifecycle[0]!.index)
  ) {
    findings.push({
      code: 'regulated_completion_order_invalid',
      severity: 'error',
      message:
        'Regulated completion evidence must order transition, decision, then session_completed',
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
