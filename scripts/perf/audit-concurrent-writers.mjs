/**
 * Independent-process audit append concurrency check.
 *
 * npm run build
 * AUDIT_WRITERS=32 node scripts/perf/audit-concurrent-writers.mjs
 *
 * Every writer is a separate Node process. The canonical audit lock must
 * serialize them without lost updates, duplicate IDs, sequence gaps or a chain
 * fork. This is not a throughput benchmark; it is a correctness acceptance.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyChain } from '../../dist/audit/integrity.js';

const writers = Number(process.env.AUDIT_WRITERS ?? '32');
const dir = await mkdtemp(join(tmpdir(), 'fg-audit-writers-'));
const sessionId = '00000000-0000-4000-8000-000000000001';
const childCode = `
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const moduleUrl = pathToFileURL(join(process.cwd(), 'dist/adapters/persistence-audit.js')).href;
const { appendAuditEvent } = await import(moduleUrl);
await appendAuditEvent(process.env.AUDIT_DIR, {
  id: randomUUID(),
  flowguardSessionId: process.env.AUDIT_SESSION,
  hostSessionId: 'ses_host',
  phase: 'IMPLEMENTATION',
  event: 'state_write',
  occurredAt: '2026-11-15T12:00:00.000Z',
  actor: 'machine',
  detail: { operationId: randomUUID(), index: Number(process.env.AUDIT_INDEX) },
});
`;

function runChild(index) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUDIT_DIR: dir,
        AUDIT_SESSION: sessionId,
        AUDIT_INDEX: String(index),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`writer ${index} exited ${code}: ${stderr}`)),
    );
  });
}

try {
  const started = performance.now();
  await Promise.all(Array.from({ length: writers }, (_, index) => runChild(index)));
  const elapsed = performance.now() - started;
  const raw = await readFile(join(dir, 'audit.jsonl'), 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const events = lines.map((line) => JSON.parse(line));
  const ids = new Set(events.map((event) => event.id));
  const sequences = events.map((event) => event.auditSequence);
  const contiguous = sequences.every((value, index) => value === index + 1);
  const chainValid = verifyChain(events).valid;
  const file = await stat(join(dir, 'audit.jsonl'));
  const passed = events.length === writers && ids.size === writers && contiguous && chainValid;
  console.log(
    JSON.stringify({
      benchmark: 'audit-independent-writers',
      writers,
      events: events.length,
      uniqueIds: ids.size,
      contiguousSequences: contiguous,
      chainValid,
      bytes: file.size,
      elapsedMs: Number(elapsed.toFixed(1)),
      perAppendMs: Number((elapsed / writers).toFixed(2)),
      result: passed ? 'PASS' : 'FAIL',
    }),
  );
  if (!passed) process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
