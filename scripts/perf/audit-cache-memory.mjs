/**
 * Audit append-proof retained-memory harness.
 *
 * npm run build
 * node --expose-gc scripts/perf/audit-cache-memory.mjs
 * AUDIT_MEMORY_SESSIONS=4 AUDIT_MEMORY_EVENTS=250 node --expose-gc scripts/perf/audit-cache-memory.mjs
 *
 * The proof may retain one fixed-size id filter per session (64 sessions max),
 * never one string per historical event. The harness verifies the structural
 * bound and reports heap/RSS deltas for realistic histories.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendAuditEvent,
  auditAppendCacheForTests,
} from '../../dist/adapters/persistence-audit.js';
import { AUDIT_ID_FILTER_BYTES } from '../../dist/adapters/persistence-audit-id-filter.js';

if (typeof global.gc !== 'function') {
  throw new Error('audit-cache-memory requires node --expose-gc');
}

const sessionCount = Number(process.env.AUDIT_MEMORY_SESSIONS ?? '4');
const eventCount = Number(process.env.AUDIT_MEMORY_EVENTS ?? '250');
const maxCaches = 64;

function measuredMemory() {
  global.gc();
  const usage = process.memoryUsage();
  return { heapUsed: usage.heapUsed, rss: usage.rss };
}

const dirs = [];
try {
  for (let session = 0; session < sessionCount; session++) {
    dirs.push(await mkdtemp(join(tmpdir(), 'fg-audit-memory-')));
  }
  const before = measuredMemory();
  const sessionIds = dirs.map(() => randomUUID());
  for (const [session, dir] of dirs.entries()) {
    for (let index = 0; index < eventCount; index++) {
      await appendAuditEvent(dir, {
        id: randomUUID(),
        flowguardSessionId: sessionIds[session],
        hostSessionId: 'ses_memory',
        phase: 'IMPLEMENTATION',
        event: 'state_write',
        occurredAt: '2026-11-15T12:00:00.000Z',
        actor: 'machine',
        detail: { operationId: randomUUID(), index, pad: 'x'.repeat(100) },
      });
    }
  }
  const after = measuredMemory();
  const caches = dirs.map((dir) => auditAppendCacheForTests(dir));
  const retainedFilterBytes = caches.reduce((sum, cache) => sum + (cache?.idFilterBytes ?? 0), 0);
  const historyBytes = (
    await Promise.all(dirs.map((dir) => stat(join(dir, 'audit.jsonl'))))
  ).reduce((sum, file) => sum + file.size, 0);
  const result = {
    benchmark: 'audit-cache-retained-memory',
    sessions: sessionCount,
    eventsPerSession: eventCount,
    totalEvents: sessionCount * eventCount,
    historyBytes,
    cachedSessions: caches.filter(Boolean).length,
    fixedFilterBytes: AUDIT_ID_FILTER_BYTES,
    retainedFilterBytes,
    structuralLimitBytes: maxCaches * AUDIT_ID_FILTER_BYTES,
    heapDelta: after.heapUsed - before.heapUsed,
    rssDelta: after.rss - before.rss,
    result:
      caches.every((cache) => cache?.idFilterBytes === AUDIT_ID_FILTER_BYTES) &&
      retainedFilterBytes <= maxCaches * AUDIT_ID_FILTER_BYTES
        ? 'PASS'
        : 'FAIL',
  };
  console.log(JSON.stringify(result));
  if (result.result !== 'PASS') process.exitCode = 1;
} finally {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}
