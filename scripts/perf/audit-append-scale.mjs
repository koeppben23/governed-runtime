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
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { appendAuditEvent, readAuditTrail } from '../../dist/adapters/persistence-audit.js';
import { verifyChain } from '../../dist/audit/integrity.js';

const restartChildCode = `
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const audit = await import(pathToFileURL(join(process.cwd(), 'dist/adapters/persistence-audit.js')).href);
const integrity = await import(pathToFileURL(join(process.cwd(), 'dist/audit/integrity.js')).href);
const before = await audit.readAuditTrail(process.env.DIR);
if (!integrity.verifyChain(before).valid) throw new Error('pre-restart chain invalid');
await audit.appendAuditEvent(process.env.DIR, {
  id: randomUUID(),
  flowguardSessionId: process.env.SESSION,
  hostSessionId: 'ses_restart',
  phase: 'IMPLEMENTATION',
  event: 'state_write',
  occurredAt: '2026-11-15T12:00:00.000Z',
  actor: 'machine',
  detail: { operationId: randomUUID(), index: -1, pad: 'restart' },
});
const after = await audit.readAuditTrail(process.env.DIR);
const verified = integrity.verifyChain(after);
console.log(JSON.stringify({ before: before.length, after: after.length, valid: verified.valid, reason: verified.reason ?? null }));
`;

function restartVerify(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', restartChildCode], {
      cwd: process.cwd(),
      env: { ...process.env, DIR: dir, SESSION: sessionId },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(`restart child failed (code=${code}, signal=${signal}): ${stderr.trim()}`),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim().split('\n').at(-1)));
      } catch (error) {
        reject(
          new Error(
            `restart child returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  });
}

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
    const events = await readAuditTrail(dir);
    const verified = verifyChain(events);
    if (!verified.valid) throw new Error(`chain invalid: ${verified.reason}`);
    const restart = await restartVerify(dir);
    if (!restart.valid || restart.before !== count || restart.after !== count + 1) {
      throw new Error(`restart verification failed: ${JSON.stringify(restart)}`);
    }
    const file = await stat(join(dir, 'audit.jsonl'));
    const result = {
      count,
      totalMs: Number(times.reduce((sum, value) => sum + value, 0).toFixed(1)),
      bytes: file.size,
      rssBefore,
      rssAfter: process.memoryUsage().rss,
      distribution: distribution(times),
      chain: 'valid',
      restart,
    };
    console.log(JSON.stringify(result));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

for (const count of counts) await run(count);
