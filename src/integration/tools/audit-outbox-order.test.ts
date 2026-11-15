/**
 * @module integration/tools/audit-outbox-order.test
 * @description Deterministic durable-order and identity conflict regressions.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE.
 */
import { describe, expect, it } from 'vitest';
import type { PendingAuditOperation } from '../../state/schema.js';
import { assertPreparedOrderMatchesPersisted } from './audit-outbox-order.js';

const digest = 'a'.repeat(64);
function operation(index: number): PendingAuditOperation {
  return {
    operationId: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    preStateDigest: digest,
    mutationDigest: digest,
    postStateDigest: digest,
    auditEventDigest: digest,
    status: 'reconciled',
    kind: 'state_write',
    stateWrite: { phase: 'PLAN', at: '2026-11-15T12:00:00.000Z' },
  };
}

function assertOrder(
  prepared: readonly PendingAuditOperation[],
  persisted: readonly PendingAuditOperation[],
): void {
  const byId = new Map(persisted.map((entry) => [entry.operationId, entry]));
  assertPreparedOrderMatchesPersisted(prepared, persisted, byId);
}

describe('durable audit outbox ordering', () => {
  it('HAPPY: accepts identical durable and prepared identity orders', () => {
    const persisted = Array.from({ length: 1_000 }, (_, index) => operation(index));
    expect(() => assertOrder(persisted, persisted)).not.toThrow();
  });

  it('CORNER: missing common entries do not affect relative order', () => {
    const persisted = [operation(1), operation(2), operation(3), operation(4)];
    expect(() => assertOrder([persisted[0]!, persisted[2]!, persisted[3]!], persisted)).not.toThrow();
  });

  it('BAD: rejects a reordered prepared outbox instead of normalizing it', () => {
    const persisted = [operation(1), operation(2), operation(3)];
    expect(() => assertOrder([persisted[1]!, persisted[0]!, persisted[2]!], persisted)).toThrow(
      'Refusing prepared state that reorders persisted pending audit operations',
    );
  });

  it('EDGE: rejects duplicate durable identity appearances', () => {
    const persisted = [operation(1), operation(2)];
    expect(() => assertOrder([persisted[0]!, persisted[0]!, persisted[1]!], persisted)).toThrow(
      'Refusing prepared state that reorders persisted pending audit operations',
    );
  });

  it('HAPPY: checks 10,000 operations without quadratic membership work', () => {
    const persisted = Array.from({ length: 10_000 }, (_, index) => operation(index));
    expect(() => assertOrder(persisted, persisted)).not.toThrow();
  });
});
