/**
 * @module integration/audit-reconcile-index
 * @description Bounded index of already committed operations in one audit snapshot.
 *
 * A live reconciliation may have many operations but substantially more
 * historical audit records. Index only relevant IDs, retaining the original
 * first-match behavior when a duplicate identity occurs in a supplied trail.
 */
import type { AuditEvent } from '../state/evidence.js';

/** Return only valid matching operation identities from a parsed audit snapshot. */
export function indexCommittedOperationAudits(
  events: readonly AuditEvent[],
  operationIds: ReadonlySet<string>,
): ReadonlyMap<string, AuditEvent> {
  const found = new Map<string, AuditEvent>();
  for (const event of events) {
    if (
      operationIds.has(event.id) &&
      event.detail.operationId === event.id &&
      !found.has(event.id)
    ) {
      found.set(event.id, event);
    }
  }
  return found;
}
