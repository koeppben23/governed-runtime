/**
 * @module audit/outbox-compaction.test
 * @description Crash-safe outbox history compaction with canonical proof.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeState } from '../fixtures.js';
import { appendAuditEvent, readAuditTrail } from '../adapters/persistence-audit.js';
import { readState, writeState } from '../adapters/persistence.js';
import { computeStateDigest } from '../integration/audit-outbox.js';
import type { PendingAuditOperation, SessionState } from '../state/schema.js';
import { buildStateWriteBody } from './types.js';
import { computeCanonicalEventDigest } from './canonical-digest.js';
import { compactVerifiedOutbox, MAX_RECONCILED_OUTBOX_OPERATIONS } from './outbox-compaction.js';

const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const AT = '2026-11-15T12:00:00.000Z';

async function prepared(count: number, unresolved = 0) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-outbox-compact-'));
  const state = makeState('PLAN', { id: SESSION_ID });
  const operations: PendingAuditOperation[] = [];
  for (let index = 0; index < count; index++) {
    const id = randomUUID();
    const detail = {
      operationId: id,
      preStateDigest: 'a'.repeat(64),
      mutationDigest: 'b'.repeat(64),
      postStateDigest: 'c'.repeat(64),
    };
    const event = buildStateWriteBody({
      flowguardSessionId: SESSION_ID,
      hostSessionId: state.binding.hostSessionId,
      phase: 'PLAN',
      detail,
      occurredAt: AT,
      prevHash: 'genesis',
    });
    await appendAuditEvent(dir, event);
    operations.push({
      kind: 'state_write',
      operationId: id,
      ...detail,
      auditEventDigest: computeCanonicalEventDigest(event),
      stateWrite: { phase: 'PLAN', at: AT },
      status: index >= count - unresolved ? 'state_committed' : 'reconciled',
    });
  }
  const withOps: SessionState = { ...state, pendingAuditOperations: operations };
  await writeState(dir, withOps);
  return { dir, withOps };
}

describe('verified outbox compaction', () => {
  it('HAPPY: bounds reconciled entries and preserves unresolved and digest', async () => {
    const { dir, withOps } = await prepared(MAX_RECONCILED_OUTBOX_OPERATIONS + 5, 2);
    try {
      const next = compactVerifiedOutbox(withOps, await readAuditTrail(dir));
      const reconciled = next.pendingAuditOperations.filter((op) => op.status === 'reconciled');
      const unresolved = next.pendingAuditOperations.filter((op) => op.status !== 'reconciled');
      expect(reconciled).toHaveLength(MAX_RECONCILED_OUTBOX_OPERATIONS);
      expect(unresolved).toHaveLength(2);
      expect(next.auditOutboxCheckpoint?.reconciledCount).toBe(3);
      expect(computeStateDigest(next)).toBe(computeStateDigest(withOps));
      await writeState(dir, next);
      expect((await readState(dir))?.auditOutboxCheckpoint).toEqual(next.auditOutboxCheckpoint);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('BAD: rejects tampered chain before retiring anything', async () => {
    const { dir, withOps } = await prepared(MAX_RECONCILED_OUTBOX_OPERATIONS + 1);
    try {
      const events = await readAuditTrail(dir);
      const altered = events.map((event) => ({ ...event }));
      altered[0] = { ...altered[0]!, chainHash: '0'.repeat(64) };
      expect(() => compactVerifiedOutbox(withOps, altered)).toThrow();
      expect((await readState(dir))?.pendingAuditOperations).toHaveLength(events.length);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('CORNER: rejects the wrong operation digest even with valid chain', async () => {
    const { dir, withOps } = await prepared(MAX_RECONCILED_OUTBOX_OPERATIONS + 1);
    try {
      const wrong = {
        ...withOps,
        pendingAuditOperations: withOps.pendingAuditOperations.map((op, i) =>
          i === 0 ? { ...op, auditEventDigest: 'f'.repeat(64) } : op,
        ),
      };
      expect(() => compactVerifiedOutbox(wrong, await readAuditTrail(dir))).toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('EDGE: checkpoint must match its original audit sequence', async () => {
    const { dir, withOps } = await prepared(MAX_RECONCILED_OUTBOX_OPERATIONS + 2);
    try {
      const events = await readAuditTrail(dir);
      const compacted = compactVerifiedOutbox(withOps, events);
      const expanded = {
        ...compacted,
        pendingAuditOperations: [
          ...compacted.pendingAuditOperations,
          ...withOps.pendingAuditOperations.slice(0, 2).map((op) => ({
            ...op,
            operationId: randomUUID(),
          })),
        ],
      };
      expect(() => compactVerifiedOutbox(expanded, events.slice(1))).toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
