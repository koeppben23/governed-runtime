/**
 * Real-process SIGKILL matrix for the canonical audit publisher.
 *
 * npm run build
 * node scripts/perf/audit-crash-matrix.mjs
 *
 * Each child starts a real append and is killed after a deterministic delay.
 * The parent reopens the trail and requires a final newline plus a valid chain.
 * A killed append may be absent or fully present; a partial committed record is
 * a failure.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAuditEvent, readAuditTrail } from '../../dist/adapters/persistence-audit.js';
import { verifyChain } from '../../dist/audit/integrity.js';

const sessionId = '00000000-0000-4000-8000-000000000001';
const delays = [1, 3, 5, 7, 9];
const childCode = `
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import * as fs from 'node:fs/promises';
const moduleUrl = pathToFileURL(join(process.cwd(), 'dist/adapters/persistence-audit.js')).href;
const { appendAuditEvent } = await import(moduleUrl);
await fs.writeFile(process.env.MARKER, 'started');
await appendAuditEvent(process.env.DIR, {
  id: randomUUID(),
  flowguardSessionId: process.env.SESSION,
  hostSessionId: 'ses_host',
  phase: 'IMPLEMENTATION',
  event: 'state_write',
  occurredAt: '2026-11-15T12:00:00.000Z',
  actor: 'machine',
  detail: { operationId: randomUUID(), index: 999, pad: 'x'.repeat(4 * 1024 * 1024) },
});
`;

// Deterministic crash exactly between the durable continuity-marker write and
// the audit publication. The diagnostics channel is only an observation seam;
// production has no subscribers.
const markerGapChildCode = `
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { subscribe } from 'node:diagnostics_channel';
const moduleUrl = pathToFileURL(join(process.cwd(), 'dist/adapters/persistence-audit.js')).href;
const { appendAuditEvent } = await import(moduleUrl);
subscribe('flowguard.audit.continuity-marker', () => process.kill(process.pid, 'SIGKILL'));
await appendAuditEvent(process.env.DIR, {
  id: randomUUID(),
  flowguardSessionId: process.env.SESSION,
  hostSessionId: 'ses_host',
  phase: 'IMPLEMENTATION',
  event: 'state_write',
  occurredAt: '2026-11-15T12:00:00.000Z',
  actor: 'machine',
  detail: { operationId: randomUUID(), index: 1000, pad: 'x'.repeat(100) },
});
`;

function body(index) {
  return {
    id: randomUUID(),
    flowguardSessionId: sessionId,
    hostSessionId: 'ses_host',
    phase: 'IMPLEMENTATION',
    event: 'state_write',
    occurredAt: '2026-11-15T12:00:00.000Z',
    actor: 'machine',
    detail: { operationId: randomUUID(), index, pad: 'x'.repeat(100) },
  };
}

async function waitForMarker(marker) {
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      await readFile(marker);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return false;
}

const results = [];
for (const [index, delayMs] of delays.entries()) {
  const dir = await mkdtemp(join(tmpdir(), 'fg-audit-crash-'));
  const marker = join(dir, 'marker');
  try {
    for (let seed = 0; seed < 100; seed++) await appendAuditEvent(dir, body(seed));
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
      cwd: process.cwd(),
      env: { ...process.env, DIR: dir, MARKER: marker, SESSION: sessionId },
      stdio: 'ignore',
    });
    const started = await waitForMarker(marker);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));

    let valid = started;
    let reason = started ? null : 'child did not start';
    let events = 0;
    if (started) {
      try {
        const raw = await readFile(join(dir, 'audit.jsonl'), 'utf8');
        if (raw.length > 0 && !raw.endsWith('\n')) {
          valid = false;
          reason = 'missing final newline';
        }
        const trail = await readAuditTrail(dir);
        events = trail.length;
        const verified = verifyChain(trail);
        if (!verified.valid) {
          valid = false;
          reason = verified.reason ?? 'invalid chain';
        }
        if (trail.length !== 100 && trail.length !== 101) {
          valid = false;
          reason = `unexpected event count ${trail.length}`;
        }
      } catch (error) {
        valid = false;
        reason = error instanceof Error ? error.message : String(error);
      }
    }
    results.push({ iteration: index + 1, delayMs, events, valid, reason });
    if (!valid) process.exitCode = 1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Deterministic cut-point: the child kills itself after the durable marker
// write and before audit publication. A crash there must leave the marker and
// no trail, and the next writer must fail closed instead of starting genesis.
{
  const dir = await mkdtemp(join(tmpdir(), 'fg-audit-marker-gap-'));
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', markerGapChildCode], {
      cwd: process.cwd(),
      env: { ...process.env, DIR: dir, SESSION: sessionId },
      stdio: 'ignore',
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const exit = await new Promise((resolve) =>
      child.on('exit', (code, signal) => resolve({ code, signal })),
    );
    clearTimeout(timeout);
    const marker = existsSync(join(dir, '.audit-history'));
    const trail = existsSync(join(dir, 'audit.jsonl'));
    let valid = exit.signal === 'SIGKILL' && marker && !trail;
    let reason = valid
      ? null
      : `marker gap state invalid (signal=${exit.signal}, code=${exit.code}, marker=${marker}, trail=${trail})`;
    if (valid) {
      try {
        await appendAuditEvent(dir, body(1001));
        valid = false;
        reason = 'append after marker-only crash did not fail closed';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/explicit recovery is required/i.test(message)) {
          valid = false;
          reason = `unexpected failure after marker-only crash: ${message}`;
        }
      }
    }
    results.push({ scenario: 'marker-before-publication', valid, reason });
    if (!valid) process.exitCode = 1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log(
  JSON.stringify({
    benchmark: 'audit-sigkill-matrix',
    iterations: results.length,
    results,
    result: results.every((entry) => entry.valid) ? 'PASS' : 'FAIL',
    scope:
      'time-based SIGKILL cut-points plus one deterministic marker-before-publication cut-point; not every fsync/rename boundary',
  }),
);
