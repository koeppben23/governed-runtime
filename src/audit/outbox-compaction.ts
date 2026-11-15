/**
 * @module audit/outbox-compaction
 * @description Bounded, cryptographically verified audit outbox retention.
 *
 * The canonical audit JSONL is the historic correlation ledger. The atomic
 * state checkpoint binds retirement to an exact chain position. Unresolved
 * operations remain in state.
 */
import { computeCanonicalEventDigest } from './canonical-digest.js';
import { verifyChain } from './integrity.js';
import { SessionState, type AuditOutboxCheckpoint, type PendingAuditOperation } from '../state/schema.js';
import type { AuditEvent } from '../state/evidence.js';

export const MAX_RECONCILED_OUTBOX_OPERATIONS = 32;

class AuditOutboxCompactionError extends Error {
  readonly code = 'SCHEMA_VALIDATION_FAILED' as const;

  constructor(reason: string) {
    super(reason);
    this.name = 'AuditOutboxCompactionError';
  }
}

function invalid(reason: string): never {
  throw new AuditOutboxCompactionError(reason);
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

/** Validate the full trail before using any retired-operation evidence. */
function verifiedEvents(
  state: SessionState,
  events: AuditEvent[],
): Map<string, AuditEvent> {
  const expectedFlowguardSessionId = state.flowguardSessionId;
  const verified = verifyChain(events, { expectedFlowguardSessionId });
  if (!verified.valid) {
    invalid(`Cannot retire outbox items: invalid audit chain (${verified.reason ?? 'unknown'})`);
  }
  verifyAnchor(state.auditOutboxCheckpoint, events);
  const byId = new Map<string, AuditEvent>();
  for (const event of events) {
    if (byId.has(event.id)) invalid(`Duplicate canonical audit identity ${event.id}`);
    byId.set(event.id, event);
  }
  return byId;
}

/** Every retired operation must already have exactly matching immutable evidence. */
function lastVerifiedRetiredEvent(
  retiring: readonly PendingAuditOperation[],
  events: ReadonlyMap<string, AuditEvent>,
): AuditEvent {
  let last: AuditEvent | undefined;
  for (const operation of retiring) {
    const event = events.get(operation.operationId);
    if (
      !event ||
      event.detail.operationId !== operation.operationId ||
      computeCanonicalEventDigest(event) !== operation.auditEventDigest
    ) {
      invalid(`Missing bound audit evidence for reconciled ${operation.operationId}`);
    }
    last = event;
  }
  if (!last) invalid('No verified reconciled operation to retire');
  return last;
}

function nextCheckpoint(
  lastRetired: AuditEvent,
  prior: AuditOutboxCheckpoint | undefined,
  retiredCount: number,
): AuditOutboxCheckpoint {
  if (prior && lastRetired.auditSequence <= prior.auditSequence) {
    invalid('Outbox checkpoint sequence must advance monotonically');
  }
  return {
    version: 1,
    reconciledCount: (prior?.reconciledCount ?? 0) + retiredCount,
    lastOperationId: lastRetired.id,
    auditSequence: lastRetired.auditSequence,
    chainHash: lastRetired.chainHash,
    auditEventDigest: computeCanonicalEventDigest(lastRetired),
  };
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

  const count = reconciled.length - MAX_RECONCILED_OUTBOX_OPERATIONS;
  const retiring = reconciled.slice(0, count);
  const byId = verifiedEvents(state, events);
  const last = lastVerifiedRetiredEvent(retiring, byId);
  const checkpoint = nextCheckpoint(last, state.auditOutboxCheckpoint, count);
  const retiredIds = new Set(retiring.map((operation) => operation.operationId));
  const result = SessionState.safeParse({
    ...state,
    pendingAuditOperations: state.pendingAuditOperations.filter(
      (operation) => !retiredIds.has(operation.operationId),
    ),
    auditOutboxCheckpoint: checkpoint,
  });
  if (!result.success) invalid(`Compacted state is invalid: ${result.error.message}`);
  return result.data;
}
