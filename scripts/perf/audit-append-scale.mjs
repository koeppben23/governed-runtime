/**
 * Canonical audit append scale benchmark.
 *
 * npm run build
 * node scripts/perf/audit-append-scale.mjs
 * AUDIT_SCALE_COUNTS=1000,10000,100000 node scripts/perf/audit-append-scale.mjs
 *
 * Reports p50/p95/p99, total time, final bytes and RSS for each event count.
 * The run is intentionally sequential and uses fresh temp sessions.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { appendAuditEvent, readAuditTrail } from '../../dist/adapters/persistence-audit.js';
import { verifyChain } from '../../dist/audit/integrity.js';

const counts = (process.env.AUDIT_SCALE_COUNTS ?? '1000,10000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const pad = Number(process.env.AUDIT_SCALE_PAD ?? '200');
const sessionId = '00000000-0000-4000-8000-000000000001';

function distribution(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.ceil((p / 100) * sorted.length) - 1];
  return {
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
  };
}

async function run(count) {
  const dir = await mkdtemp(join(tmpdir(), 'fg-audit-scale-'));
  const times = [];
  const rssBefore = process.memoryUsage().rss;
  try {
    for (let index = 0; index < count; index++) {
      const started = performance.now();
      await appendAuditEvent(dir, {
        id: randomUUID(),
        flowguardSessionId: sessionId,
        hostSessionId: 'ses_bench',
        phase: 'IMPLEMENTATION',
        event: 'state_write',
        occurredAt: '2026-11-15T12:00:00.000Z',
        actor: 'machine',
        detail: { operationId: randomUUID(), index, pad: 'x'.repeat(pad) },
      });
      times.push(performance.now() - started);
    }
    const file = await stat(join(dir, 'audit.jsonl'));
    const events = await readAuditTrail(dir);
    const verified = verifyChain(events);
    if (!verified.valid) throw new Error(`chain invalid: ${verified.reason}`);
    const result = {
      count,
      totalMs: Number(times.reduce((sum, value) => sum + value, 0).toFixed(1)),
      bytes: file.size,
      rssBefore,
      rssAfter: process.memoryUsage().rss,
      distribution: distribution(times),
      chain: 'valid',
    };
    console.log(JSON.stringify(result));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

for (const count of counts) await run(count);
