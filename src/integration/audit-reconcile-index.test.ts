/**
 * @module integration/audit-reconcile-index.test
 * @description Bounded durable audit-operation snapshot matching.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE.
 */
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../state/evidence.js';
import { indexCommittedOperationAudits } from './audit-reconcile-index.js';

function event(id: string, operationId: string): AuditEvent {
  return {
    id,
    detail: { kind: 'state_write', operationId },
  } as AuditEvent;
}

describe('audit reconciliation snapshot index', () => {
  it('HAPPY: matches relevant committed operation identities', () => {
    const committed = event('operation-1', 'operation-1');
    const unrelated = event('other-event', 'other-event');
    const result = indexCommittedOperationAudits(
      [unrelated, committed],
      new Set(['operation-1']),
    );
    expect([...result.keys()]).toEqual(['operation-1']);
    expect(result.get('operation-1')).toBe(committed);
  });

  it('BAD: rejects a mismatched event detail operation identity', () => {
    const forged = event('operation-1', 'operation-2');
    expect(
      indexCommittedOperationAudits([forged], new Set(['operation-1'])).size,
    ).toBe(0);
  });

  it('CORNER: preserves the original first-match semantics', () => {
    const first = event('operation-1', 'operation-1');
    const duplicate = event('operation-1', 'operation-1');
    expect(
      indexCommittedOperationAudits([first, duplicate], new Set(['operation-1'])).get(
        'operation-1',
      ),
    ).toBe(first);
  });

  it('EDGE: index stays bounded by pending IDs even with 10,000 history entries', () => {
    const history = Array.from({ length: 10_000 }, (_, i) =>
      event(`audit-${i}`, `audit-${i}`),
    );
    const wanted = new Set(['audit-7', 'audit-7000', 'absent']);
    const result = indexCommittedOperationAudits(history, wanted);
    expect([...result.keys()]).toEqual(['audit-7', 'audit-7000']);
    expect(result.size).toBeLessThanOrEqual(wanted.size);
  });
});
