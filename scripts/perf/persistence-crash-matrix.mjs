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
import { appendAuditEvent } from '../../dist/adapters/persistence-audit.js';
import { readState, writeState } from '../../dist/adapters/persistence.js';
import { computeStateDigest } from '../../dist/integration/audit-outbox.js';
import { SessionState } from '../../dist/state/schema.js';

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

const freshAuditProbeCode = `
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const audit = await import(pathToFileURL(join(process.cwd(), 'dist/adapters/persistence-audit.js')).href);
const integrity = await import(pathToFileURL(join(process.cwd(), 'dist/audit/integrity.js')).href);
const dir = process.env.DIR;
const mode = process.env.MODE;
async function readTrail() {
  const trail = await audit.readAuditTrail(dir);
  const verified = integrity.verifyChain(trail);
  let raw = '';
  try { raw = await readFile(join(dir, 'audit.jsonl'), 'utf8'); } catch {}
  return {
    count: trail.length,
    valid: verified.valid,
    reason: verified.reason ?? null,
    finalNewline: raw.length === 0 || raw.endsWith('\\n'),
  };
}
function body() {
  return {
    id: randomUUID(),
    flowguardSessionId: process.env.SESSION,
    hostSessionId: 'ses_restart',
    phase: 'IMPLEMENTATION',
    event: 'state_write',
    occurredAt: '2026-11-16T09:00:00.000Z',
    actor: 'machine',
    detail: { operationId: randomUUID(), index: Number(process.env.BODY_INDEX ?? '0'), pad: 'restart' },
  };
}
const before = await readTrail();
if (mode === 'read') {
  console.log(JSON.stringify({ mode, ...before }));
} else if (mode === 'failclosed') {
  try {
    await audit.appendAuditEvent(dir, body());
    console.log(JSON.stringify({ mode, failedClosed: false, message: null }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({ mode, failedClosed: /explicit recovery is required/i.test(message), message }));
  }
} else if (mode === 'append') {
  await audit.appendAuditEvent(dir, body());
  const after = await readTrail();
  console.log(JSON.stringify({ mode, before, after }));
}
`;

const freshStateProbeCode = `
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const persistence = await import(pathToFileURL(join(process.cwd(), 'dist/adapters/persistence.js')).href);
const outbox = await import(pathToFileURL(join(process.cwd(), 'dist/integration/audit-outbox.js')).href);
try {
  const state = await persistence.readState(process.env.DIR);
  console.log(JSON.stringify({
    phase: state?.phase ?? null,
    digest: state ? outbox.computeStateDigest(state) : null,
    valid: state !== null,
  }));
} catch (error) {
  console.log(JSON.stringify({ valid: false, error: error instanceof Error ? error.message : String(error) }));
}
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

function runProbe(code, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
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
          new Error(
            `probe failed (code=${code}, signal=${signal}): ${stderr.trim().slice(0, 500)}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim().split('\n').at(-1)));
      } catch (error) {
        reject(
          new Error(
            `probe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  });
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

    const crashRead = await runProbe(freshAuditProbeCode, {
      DIR: dir,
      MODE: 'read',
      SESSION: sessionId,
    });
    if (!crashRead.valid) {
      valid = false;
      reason = crashRead.reason ?? 'fresh process rejected the crashed audit trail';
    }
    if (crashRead.count !== seed && crashRead.count !== seed + 1) {
      valid = false;
      reason = `unexpected audit count ${crashRead.count} after crash (seed=${seed})`;
    }
    if (!crashRead.finalNewline) {
      valid = false;
      reason = 'committed audit lacks final newline';
    }
    if (valid && firstAppend && crashRead.count === 0) {
      if (!existsSync(join(dir, '.audit-history'))) {
        valid = false;
        reason = 'marker missing before first audit publication';
      } else {
        const failClosed = await runProbe(freshAuditProbeCode, {
          DIR: dir,
          MODE: 'failclosed',
          SESSION: sessionId,
          BODY_INDEX: String(seed + 1),
        });
        if (!failClosed.failedClosed) {
          valid = false;
          reason = 'fresh process did not fail closed after marker-only first append';
        }
      }
    } else if (valid) {
      const restart = await runProbe(freshAuditProbeCode, {
        DIR: dir,
        MODE: 'append',
        SESSION: sessionId,
        BODY_INDEX: String(seed + crashRead.count),
      });
      if (
        !restart.before?.valid ||
        restart.before.count !== crashRead.count ||
        !restart.after?.valid ||
        restart.after.count !== crashRead.count + 1
      ) {
        valid = false;
        reason = `fresh-process restart failed: ${JSON.stringify(restart)}`;
      }
    }
    return { label, phase, skipped: false, valid, reason };
  } catch (error) {
    return {
      label,
      phase,
      skipped: false,
      valid: false,
      reason: error instanceof Error ? error.message : String(error),
    };
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
      const failClosed = await runProbe(freshAuditProbeCode, {
        DIR: dir,
        MODE: 'failclosed',
        SESSION: sessionId,
        BODY_INDEX: '1',
      });
      return {
        label: 'marker',
        phase,
        skipped: false,
        valid: failClosed.failedClosed,
        reason: failClosed.failedClosed
          ? null
          : 'fresh process did not fail closed after marker-only crash',
      };
    }
    const restart = await runProbe(freshAuditProbeCode, {
      DIR: dir,
      MODE: 'append',
      SESSION: sessionId,
      BODY_INDEX: '1',
    });
    const valid =
      restart.before?.valid &&
      restart.before.count === 0 &&
      restart.after?.valid &&
      restart.after.count === 1;
    return {
      label: 'marker',
      phase,
      skipped: false,
      valid,
      reason: valid ? null : `fresh-process restart failed: ${JSON.stringify(restart)}`,
    };
  } catch (error) {
    return {
      label: 'marker',
      phase,
      skipped: false,
      valid: false,
      reason: error instanceof Error ? error.message : String(error),
    };
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
    const seeded = await readState(dir);
    if (seeded === null) throw new Error('seeded state is missing');
    const oldDigest = computeStateDigest(seeded);
    const expectedNewState = SessionState.parse({
      ...fixture,
      phase: 'TICKET',
      transition: {
        from: 'READY',
        to: 'TICKET',
        event: 'TICKET_SELECTED',
        at: '2026-11-16T09:00:00.000Z',
      },
    });
    const newDigest = computeStateDigest(expectedNewState);
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
    const probe = await runProbe(freshStateProbeCode, { DIR: dir });
    const expectedPhase = ['temp-opened', 'temp-written', 'temp-fsynced'].includes(phase)
      ? 'READY'
      : 'TICKET';
    const expectedDigest = expectedPhase === 'READY' ? oldDigest : newDigest;
    if (!probe.valid) {
      return {
        label: 'state',
        phase,
        skipped: false,
        valid: false,
        reason: `fresh process could not read state: ${probe.error ?? 'unknown error'}`,
      };
    }
    if (probe.phase !== expectedPhase || probe.digest !== expectedDigest) {
      return {
        label: 'state',
        phase,
        skipped: false,
        valid: false,
        reason: `fresh state mismatch: phase=${probe.phase}/${expectedPhase}, digest=${probe.digest}/${expectedDigest}`,
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
