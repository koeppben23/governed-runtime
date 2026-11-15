/**
 * @module audit/outbox-compaction
 * @description Bounded, cryptographically checked reconciled-outbox retention.
 *
 * The canonical audit JSONL is the historic correlation ledger. A state
 * checkpoint binds retirement to one exact chain position. No unresolved
 * outbox item is ever removed. The caller atomically commits the resulting
 * state under the session write lock.
 */
import { computeCanonicalEventDigest } from './canonical-digest.js';
import { verifyChain } from './integrity.js';
import { PersistenceError } from '../adapters/persistence.js';
import { SessionState, type AuditOutboxCheckpoint } from '../state/schema.js';
import type { AuditEvent } from '../state/evidence.js';

export const MAX_RECONCILED_OUTBOX_OPERATIONS = 32;

function invalid(reason: string): never {
  throw new PersistenceError('SCHEMA_VALIDATION_FAILED', reason);
}

function verifyAnchor(
  checkpoint: AuditOutboxCheckpoint | undefined,
  events: readonly AuditEvent[],
): void {
  if (!checkpoint) return;
  const event = events[checkpoint.auditSequence - 1];
  if (
    !event ||
    event.auditSequence !== checkpoint.auditSequence ||
    event.id !== checkpoint.lastOperationId ||
    event.chainHash !== checkpoint.chainHash ||
    computeCanonicalEventDigest(event) !== checkpoint.auditEventDigest
  ) {
    invalid('Audit outbox checkpoint is not anchored in canonical evidence');
  }
}

/** Retire only the oldest fully verified reconciled state duplicates. */
export function compactVerifiedOutbox(
  state: SessionState,
  events: AuditEvent[],
): SessionState {
  const reconciled = state.pendingAuditOperations.filter(
    (operation) => operation.status === 'reconciled',
  );
  if (reconciled.length <= MAX_RECONCILED_OUTBOX_OPERATIONS) return state;
  const verified = verifyChain(events, { expectedFlowguardSessionId: state.flowguardSessionId });
  if (!verified.valid) {
    invalid(`Cannot retire outbox items from an invalid audit chain: ${verified.reason ?? 'unknown'}`);
  }
  verifyAnchor(state.auditOutboxCheckpoint, events);

  const retireCount = reconciled.length - MAX_RECONCILED_OUTBOX_OPERATIONS;
  const toRetire = reconciled.slice(0, retireCount);
  const eventsById = new Map<string, AuditEvent>();
  for (const event of events) {
    if (eventsById.has(event.id)) invalid(`Duplicate audit identity ${event.id}`);
    eventsById.set(event.id, event);
  }
  let lastRetired: AuditEvent | undefined;
  for (const operation of toRetire) {
    const event = eventsById.get(operation.operationId);
    if (
      !event ||
      event.detail.operationId !== operation.operationId ||
      computeCanonicalEventDigest(event) !== operation.auditEventDigest
    ) {
      invalid(`Reconciled outbox operation ${operation.operationId} lacks bound audit evidence`);
    }
    lastRetired = event;
  }
  if (!lastRetired) invalid('Cannot retire zero reconciled operations');
  const prior = state.auditOutboxCheckpoint;
  if (prior && lastRetired.auditSequence <= prior.auditSequence) {
    invalid('Outbox checkpoint sequence must advance monotonically');
  }
  const retiredIds = new Set(toRetire.map((op) => op.operationId));
  const result = SessionState.safeParse({
    ...state,
    pendingAuditOperations: state.pendingAuditOperations.filter(
      (op) => !retiredIds.has(op.operationId),
    ),
    auditOutboxCheckpoint: {
      version: 1,
      reconciledCount: (prior?.reconciledCount ?? 0) + retireCount,
      lastOperationId: lastRetired.id,
      auditSequence: lastRetired.auditSequence,
      chainHash: lastRetired.chainHash,
      auditEventDigest: computeCanonicalEventDigest(lastRetired),
    },
  });
  if (!result.success) invalid(`Compacted state violates schema: ${result.error.message}`);
  return result.data;
}
