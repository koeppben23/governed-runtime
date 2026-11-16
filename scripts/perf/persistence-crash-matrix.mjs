/**
 * Deterministic SIGKILL matrix at every durable state/audit publish phase.
 *
 * npm run build
 * node scripts/perf/persistence-crash-matrix.mjs
 *
 * Each child is killed by a diagnostics-channel subscriber immediately after a
 * named fsync/rename phase. The parent verifies that state/audit are either the
 * old or the new complete version, never a partial record, and that a fresh
 * process can continue safely. Clone-only phases are reported NOT_VERIFIED on
 * filesystems without forced reflink support; the explicit fallback phase is
 * still exercised.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendAuditEvent, readAuditTrail } from '../../dist/adapters/persistence-audit.js';
import { readState, writeState } from '../../dist/adapters/persistence.js';
import { verifyChain } from '../../dist/audit/integrity.js';

const sessionId = '00000000-0000-4000-8000-000000000001';
const fixturePath = fileURLToPath(
  new URL('./fixtures/minimal-session-state.json', import.meta.url),
);
const durablePhases = ['temp-opened', 'temp-written', 'temp-fsynced', 'renamed', 'dir-fsynced'];
const clonePhases = ['clone-created', 'clone-line-written', 'clone-fsynced'];
const childCommon = `
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { subscribe } from 'node:diagnostics_channel';
const target = process.env.TARGET_BASENAME;
const phase = process.env.TARGET_PHASE;
subscribe('flowguard.persistence.atomic-write', (message) => {
  if (message.filePath.endsWith(target) && message.phase === phase) {
    writeFileSync(process.env.HIT, phase);
    process.kill(process.pid, 'SIGKILL');
  }
});
`;
const auditChildCode = `${childCommon}
const { appendAuditEvent } = await import(pathToFileURL(join(process.cwd(), 'dist/adapters/persistence-audit.js')).href);
await appendAuditEvent(process.env.DIR, {
  id: randomUUID(),
  flowguardSessionId: process.env.SESSION,
  hostSessionId: 'ses_host',
  phase: 'IMPLEMENTATION',
  event: 'state_write',
  occurredAt: '2026-11-16T09:00:00.000Z',
  actor: 'machine',
  detail: { operationId: randomUUID(), index: 999, pad: 'x'.repeat(4 * 1024 * 1024) },
});
`;
const stateChildCode = `${childCommon}
import { readFile } from 'node:fs/promises';
const { writeState } = await import(pathToFileURL(join(process.cwd(), 'dist/adapters/persistence.js')).href);
const state = JSON.parse(await readFile(process.env.STATE_FIXTURE, 'utf8'));
state.phase = 'TICKET';
state.transition = { from: 'READY', to: 'TICKET', event: 'TICKET_SELECTED', at: '2026-11-16T09:00:00.000Z' };
await writeState(process.env.DIR, state);
`;

function body(index, pad = 100) {
  return {
    id: randomUUID(),
    flowguardSessionId: sessionId,
    hostSessionId: 'ses_host',
    phase: 'IMPLEMENTATION',
    event: 'state_write',
    occurredAt: '2026-11-16T09:00:00.000Z',
    actor: 'machine',
    detail: { operationId: randomUUID(), index, pad: 'x'.repeat(pad) },
  };
}

async function waitForExit(child, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function runChild(code, env, hitPath) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, HIT: hitPath },
    stdio: 'ignore',
  });
  const exit = await waitForExit(child);
  return { exit, hit: existsSync(hitPath) };
}

async function verifyAuditRestart(dir, expectedCount) {
  const trail = await readAuditTrail(dir);
  if (trail.length !== expectedCount) {
    return {
      valid: false,
      reason: `expected ${expectedCount} events after restart, got ${trail.length}`,
    };
  }
  const verified = verifyChain(trail);
  return verified.valid
    ? { valid: true, reason: null }
    : { valid: false, reason: verified.reason ?? 'invalid chain after restart' };
}

async function runAuditPhase({ label, seed, phase, firstAppend, target = 'audit.jsonl' }) {
  const dir = await mkdtemp(join(tmpdir(), 'fg-phase-audit-'));
  const hit = join(dir, 'phase-hit');
  try {
    for (let index = 0; index < seed; index++) await appendAuditEvent(dir, body(index));
    const { exit, hit: phaseHit } = await runChild(
      auditChildCode,
      {
        DIR: dir,
        SESSION: sessionId,
        TARGET_BASENAME: target,
        TARGET_PHASE: phase,
      },
      hit,
    );

    let valid = true;
    let reason = null;
    if (!phaseHit) {
      const skipped = phase.startsWith('clone-');
      return {
        label,
        phase,
        skipped,
        valid: skipped,
        reason: skipped ? 'clone phase unavailable on this filesystem' : 'phase was never reached',
      };
    }
    if (exit.signal !== 'SIGKILL') {
      return {
        label,
        phase,
        skipped: false,
        valid: false,
        reason: `child did not die by SIGKILL (code=${exit.code}, signal=${exit.signal})`,
      };
    }

    const auditPath = join(dir, 'audit.jsonl');
    const raw = existsSync(auditPath) ? await readFile(auditPath, 'utf8') : '';
    if (raw.length > 0 && !raw.endsWith('\n')) {
      valid = false;
      reason = 'committed audit lacks final newline';
    }
    const trail = await readAuditTrail(dir);
    if (trail.length !== seed && trail.length !== seed + 1) {
      valid = false;
      reason = `unexpected audit count ${trail.length} after crash (seed=${seed})`;
    }
    const verified = verifyChain(trail);
    if (!verified.valid) {
      valid = false;
      reason = verified.reason ?? 'invalid chain after crash';
    }
    if (valid && firstAppend && trail.length === 0) {
      const marker = existsSync(join(dir, '.audit-history'));
      if (!marker) {
        valid = false;
        reason = 'marker missing before first audit publication';
      } else {
        try {
          await appendAuditEvent(dir, body(seed + 1));
          valid = false;
          reason = 'restart after marker-only first append did not fail closed';
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/explicit recovery is required/i.test(message)) {
            valid = false;
            reason = `unexpected restart failure: ${message}`;
          }
        }
      }
    } else if (valid) {
      await appendAuditEvent(dir, body(seed + trail.length));
      const restart = await verifyAuditRestart(dir, trail.length + 1);
      valid = restart.valid;
      reason = restart.reason;
    }
    return { label, phase, skipped: false, valid, reason };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runMarkerPhase(phase) {
  const dir = await mkdtemp(join(tmpdir(), 'fg-phase-marker-'));
  const hit = join(dir, 'phase-hit');
  try {
    const { exit, hit: phaseHit } = await runChild(
      auditChildCode,
      {
        DIR: dir,
        SESSION: sessionId,
        TARGET_BASENAME: '.audit-history',
        TARGET_PHASE: phase,
      },
      hit,
    );
    if (!phaseHit)
      return {
        label: 'marker',
        phase,
        skipped: false,
        valid: false,
        reason: 'phase was never reached',
      };
    if (exit.signal !== 'SIGKILL')
      return {
        label: 'marker',
        phase,
        skipped: false,
        valid: false,
        reason: `child did not die by SIGKILL (code=${exit.code}, signal=${exit.signal})`,
      };
    if (existsSync(join(dir, 'audit.jsonl'))) {
      return {
        label: 'marker',
        phase,
        skipped: false,
        valid: false,
        reason: 'audit was published before marker phase crash',
      };
    }
    const marker = existsSync(join(dir, '.audit-history'));
    if (marker) {
      try {
        await appendAuditEvent(dir, body(1));
        return {
          label: 'marker',
          phase,
          skipped: false,
          valid: false,
          reason: 'marker-only crash did not fail closed on restart',
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          label: 'marker',
          phase,
          skipped: false,
          valid: /explicit recovery is required/i.test(message),
          reason: /explicit recovery is required/i.test(message)
            ? null
            : `unexpected restart failure: ${message}`,
        };
      }
    }
    await appendAuditEvent(dir, body(1));
    return verifyAuditRestart(dir, 1).then((restart) => ({
      label: 'marker',
      phase,
      skipped: false,
      valid: restart.valid,
      reason: restart.reason,
    }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runStatePhase(phase) {
  const dir = await mkdtemp(join(tmpdir(), 'fg-phase-state-'));
  const hit = join(dir, 'phase-hit');
  try {
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
    await writeState(dir, fixture);
    const { exit, hit: phaseHit } = await runChild(
      stateChildCode,
      {
        DIR: dir,
        STATE_FIXTURE: fixturePath,
        TARGET_BASENAME: 'session-state.json',
        TARGET_PHASE: phase,
      },
      hit,
    );
    if (!phaseHit)
      return {
        label: 'state',
        phase,
        skipped: false,
        valid: false,
        reason: 'phase was never reached',
      };
    if (exit.signal !== 'SIGKILL')
      return {
        label: 'state',
        phase,
        skipped: false,
        valid: false,
        reason: `child did not die by SIGKILL (code=${exit.code}, signal=${exit.signal})`,
      };
    const after = await readState(dir);
    const expected = ['temp-opened', 'temp-written', 'temp-fsynced'].includes(phase)
      ? 'READY'
      : 'TICKET';
    if (after?.phase !== expected) {
      return {
        label: 'state',
        phase,
        skipped: false,
        valid: false,
        reason: `state phase ${after?.phase} != ${expected}`,
      };
    }
    return { label: 'state', phase, skipped: false, valid: true, reason: null };
  } catch (error) {
    return {
      label: 'state',
      phase,
      skipped: false,
      valid: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const results = [];
for (const phase of durablePhases) results.push(await runMarkerPhase(phase));
for (const phase of durablePhases)
  results.push(await runAuditPhase({ label: 'audit-first', seed: 0, phase, firstAppend: true }));
for (const phase of durablePhases)
  results.push(await runAuditPhase({ label: 'audit-existing', seed: 100, phase }));
for (const phase of [...clonePhases, 'clone-unsupported'])
  results.push(await runAuditPhase({ label: 'audit-clone', seed: 100, phase }));
for (const phase of durablePhases) results.push(await runStatePhase(phase));

const failed = results.filter((entry) => !entry.valid && !entry.skipped);
const skipped = results.filter((entry) => entry.skipped);
console.log(
  JSON.stringify({
    benchmark: 'persistence-sigkill-phase-matrix',
    results,
    failures: failed.length,
    skipped: skipped.length,
    result: failed.length === 0 ? 'PASS' : 'FAIL',
    scope:
      'deterministic fsync/rename phases for marker, first audit, existing audit, clone fallback and session-state writes',
  }),
);
if (failed.length > 0) process.exitCode = 1;
