/**
 * Real-JSONL baseline vs optimized reconciliation lookup benchmark.
 *
 * npm ci && npm run build && node scripts/perf/audit-reconcile-snapshot.mjs
 *
 * Separately prepares canonical audit records with the production writer.
 * Timed portions measure only the read+lookup path, not fixture generation,
 * audit writes, state locking, fsync or crash recovery.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import * as auditPersistence from '../../dist/adapters/persistence-audit.js';
import * as auditIndex from '../../dist/audit/reconcile-index.js';

const SESSION_ID = randomUUID();
const QUERIES = 20;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function duration(task, rounds = 7) {
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    const t0 = performance.now();
    await task();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

async function legacyLookup(dir, wanted) {
  for (const id of wanted) {
    const audit = await auditPersistence.readAuditTrail(dir);
    const match = audit.find(
      (entry) => entry.id === id && entry.detail.operationId === id,
    );
    if (!match) throw new Error(`Missing baseline event ${id}`);
  }
}

async function snapshotLookup(dir, wanted) {
  const events = await auditPersistence.readAuditTrail(dir);
  const byId = auditIndex.indexCommittedOperationAudits(events, new Set(wanted));
  for (const id of wanted) {
    if (!byId.has(id)) throw new Error(`Missing indexed event ${id}`);
  }
}

console.log('Audit reconciliation reads, median milliseconds (real v3 JSONL).');
console.log('Events\tBaseline (20 reads)\tSnapshot (1 read)\tSpeedup');
for (const count of [100, 500, 1_000]) {
  const dir = await mkdtemp(join(tmpdir(), 'fg-audit-read-bench-'));
  try {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const id = randomUUID();
      ids.push(id);
      await auditPersistence.appendAuditEvent(dir, {
        id,
        flowguardSessionId: SESSION_ID,
        hostSessionId: 'ses_bench',
        phase: 'PLAN',
        event: 'state_write',
        occurredAt: '2026-11-15T12:00:00.000Z',
        actor: 'machine',
        detail: {
          kind: 'state_write',
          operationId: id,
          preStateDigest: 'a'.repeat(64),
          mutationDigest: 'b'.repeat(64),
          postStateDigest: 'c'.repeat(64),
        },
      });
    }
    const step = Math.max(1, Math.floor(count / QUERIES));
    const wanted = ids.filter((_, i) => i % step === 0).slice(0, QUERIES);
    await legacyLookup(dir, wanted);
    await snapshotLookup(dir, wanted);
    const before = await duration(() => legacyLookup(dir, wanted));
    const after = await duration(() => snapshotLookup(dir, wanted));
    const speedup = before / after;
    const row = [
      String(count),
      `${before.toFixed(2)} ms`,
      `${after.toFixed(2)} ms`,
      `${speedup.toFixed(2)}x`,
    ];
    console.log(row.join('\t'));
    if (count === 1_000 && speedup < 3) {
      console.error('NOT_VERIFIED: fewer than 3x faster at 1,000 events');
      process.exitCode = 1;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
