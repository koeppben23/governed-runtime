/**
 * @module integration/tools/audit-outbox-order
 * @description Order-invariant check for merging prepared and durable audit outbox operations.
 *
 * The durable order is authoritative. Membership lookup is linear-time over the
 * entire input; a prepared mutation may never reorder persisted common IDs.
 */
import { PersistenceError } from '../../adapters/persistence.js';
import type { PendingAuditOperation } from '../../state/schema.js';

/** Fail closed if a prepared outbox reorders any durable operation identity. */
export function assertPreparedOrderMatchesPersisted(
  prepared: readonly PendingAuditOperation[],
  persisted: readonly PendingAuditOperation[],
  persistedById: ReadonlyMap<string, PendingAuditOperation>,
): void {
  const commonIds = prepared
    .map((operation) => operation.operationId)
    .filter((id) => persistedById.has(id));
  const commonIdSet = new Set(commonIds);
  const persistedCommonIds = persisted
    .map((operation) => operation.operationId)
    .filter((id) => commonIdSet.has(id));
  if (!sameOrder(commonIds, persistedCommonIds)) {
    throw new PersistenceError(
      'OUTBOX_ORDER_CONFLICT',
      'Refusing prepared state that reorders persisted pending audit operations',
    );
  }
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
