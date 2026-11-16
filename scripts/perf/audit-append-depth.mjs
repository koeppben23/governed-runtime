/**
 * Audit append cost at a pre-built history depth.
 *
 * npm run build
 * node scripts/perf/audit-append-depth.mjs
 * AUDIT_DEPTH_COUNTS=10000,100000 AUDIT_DEPTH_APPENDS=5 node scripts/perf/audit-append-depth.mjs
 *
 * Seeding writes a canonical chain once (O(n)); measured appends then run at
 * that depth. This reports the per-append read/hash/rewrite cost and memory
 * without performing O(n^2) total work for every event in a 100,000-event run.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  appendAuditEvent,
  auditAppendCacheForTests,
  readAuditTrail,
} from '../../dist/adapters/persistence-audit.js';
import { verifyChain } from '../../dist/audit/integrity.js';
import { AUDIT_ID_FILTER_BYTES } from '../../dist/adapters/persistence-audit-id-filter.js';
import { computeCanonicalEventDigest } from '../../dist/audit/canonical-digest.js';
import {
  CURRENT_AUDIT_FORMAT_VERSION,
  GENESIS_HASH,
  computeChainHash,
} from '../../dist/audit/types.js';

const counts = (process.env.AUDIT_DEPTH_COUNTS ?? '10000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const appends = Number(process.env.AUDIT_DEPTH_APPENDS ?? '5');
const sessionId = '00000000-0000-4000-8000-000000000001';
const occurredAt = '2026-11-15T12:00:00.000Z';

function seededLine(index, prevHash) {
  const body = {
    id: randomUUID(),
    flowguardSessionId: sessionId,
    hostSessionId: 'ses_depth',
    phase: 'IMPLEMENTATION',
    event: 'state_write',
    occurredAt,
    actor: 'machine',
    detail: { operationId: randomUUID(), index, pad: 'x'.repeat(100) },
    auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
    auditSequence: index + 1,
    recordedAt: occurredAt,
    prevHash,
  };
  const semanticEventDigest = computeCanonicalEventDigest(body);
  const finalized = { ...body, semanticEventDigest };
  const chainHash = computeChainHash(prevHash, finalized);
  return { line: `${JSON.stringify({ ...finalized, chainHash })}\n`, chainHash };
}

function body(index) {
  return {
    id: randomUUID(),
    flowguardSessionId: sessionId,
    hostSessionId: 'ses_depth',
    phase: 'IMPLEMENTATION',
    event: 'state_write',
    occurredAt,
    actor: 'machine',
    detail: { operationId: randomUUID(), index, pad: 'x'.repeat(100) },
  };
}

function distribution(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p) =>
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  return { p50: percentile(50), p95: percentile(95), p99: percentile(99) };
}

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

async function run(count) {
  const dir = await mkdtemp(join(tmpdir(), 'fg-audit-depth-'));
  try {
    const filePath = join(dir, 'audit.jsonl');
    const handle = await open(filePath, 'w', 0o600);
    const seedStarted = performance.now();
    let prevHash = GENESIS_HASH;
    try {
      for (let index = 0; index < count; index++) {
        const seeded = seededLine(index, prevHash);
        prevHash = seeded.chainHash;
        await handle.write(seeded.line, null, 'utf8');
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    const seedMs = performance.now() - seedStarted;

    const verifyStarted = performance.now();
    const trail = await readAuditTrail(dir);
    const verified = verifyChain(trail);
    const readVerifyMs = performance.now() - verifyStarted;
    if (!verified.valid) throw new Error(`seeded chain invalid: ${verified.reason}`);

    const memoryBefore = process.memoryUsage();
    const times = [];
    for (let index = 0; index < appends; index++) {
      const started = performance.now();
      await appendAuditEvent(dir, body(count + index));
      times.push(performance.now() - started);
    }
    const restart = await restartVerify(dir);
    if (
      !restart.valid ||
      restart.before !== count + appends ||
      restart.after !== count + appends + 1
    ) {
      throw new Error(`restart verification failed: ${JSON.stringify(restart)}`);
    }
    const memoryAfter = process.memoryUsage();
    const file = await stat(filePath);
    const retainedFilterBytes = auditAppendCacheForTests(dir)?.idFilterBytes ?? 0;
    if (retainedFilterBytes !== AUDIT_ID_FILTER_BYTES) {
      throw new Error(
        `retained id filter is ${retainedFilterBytes} bytes, expected ${AUDIT_ID_FILTER_BYTES}`,
      );
    }
    return {
      count,
      appends,
      seedMs: Number(seedMs.toFixed(1)),
      readVerifyMs: Number(readVerifyMs.toFixed(1)),
      trailBytes: file.size,
      bytesRewrittenPerAppend: file.size,
      firstAppendMs: Number(times[0].toFixed(2)),
      appendDistribution: distribution(times),
      retainedFilterBytes,
      restart,
      heapDelta: memoryAfter.heapUsed - memoryBefore.heapUsed,
      rssDelta: memoryAfter.rss - memoryBefore.rss,
      chain: 'valid',
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

for (const count of counts) console.log(JSON.stringify(await run(count)));
