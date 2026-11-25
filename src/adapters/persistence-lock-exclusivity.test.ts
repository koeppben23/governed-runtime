/**
 * @module persistence-lock-exclusivity
 * @description Deterministic regression tests for the lock ownership,
 * reclamation and release boundaries (L1-L4, L6).
 *
 * These tests target the two defects the v1 lock could not express:
 * - a bare PID is not an owner identity (PID reuse blocks a session forever),
 * - a resource-owning owner was deleted through a `read -> unlink` window.
 *
 * The multi-process exclusivity matrix (L5) lives in
 * `scripts/perf/lock-exclusivity.mjs` because it needs separate processes and
 * the built `dist/` entry points.
 *
 * @test-policy BAD, EDGE, CORNER
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  acquireNamedWriteLock,
  acquireSessionWriteLock,
  sessionLockPath,
} from './persistence-lock.js';
import { acquireReclaimGuard, RECLAIM_GUARD_SUFFIX } from './persistence-lock-guard.js';
import {
  bootRefMs,
  classifyLockOwner,
  formatLockOwner,
  parseLockOwner,
  readProcessStartIdentity,
  type LivenessProbe,
} from './persistence-lock-owner.js';

const LOCK_FILE = 'session-state.json.lock';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function makeSessionDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-lock-exclusivity-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function ownerBody(overrides: Partial<Parameters<typeof formatLockOwner>[0]> = {}): string {
  return formatLockOwner({
    token: 'crashed-token',
    pid: 4242,
    host: os.hostname(),
    bootRefMs: bootRefMs(),
    startIdentity: null,
    ...overrides,
  });
}

/** Probe whose owner process is alive but whose start identity never matches. */
function recycledPidProbe(identity: string): LivenessProbe {
  return {
    host: os.hostname(),
    bootRefMs: bootRefMs(),
    isProcessAlive: () => true,
    processStartIdentity: async () => identity,
  };
}

describe('persistence-lock owner identity', () => {
  it('HAPPY: round-trips the owner record and keeps pid/token as the first lines', () => {
    const raw = ownerBody({ startIdentity: 'proc-starttime:42', pid: 77 });
    expect(raw.startsWith('pid=77\ntoken=crashed-token\n')).toBe(true);
    expect(parseLockOwner(raw)).toMatchObject({
      token: 'crashed-token',
      pid: 77,
      host: os.hostname(),
      startIdentity: 'proc-starttime:42',
    });
  });

  it('BAD: a record without pid or token stays unparseable (fail-closed owner)', () => {
    expect(parseLockOwner('not a lock\n')).toBeNull();
    expect(parseLockOwner('pid=12\n')).toBeNull();
    expect(parseLockOwner('token=abc\n')).toBeNull();
    expect(parseLockOwner('pid=0\ntoken=abc\n')).toBeNull();
  });

  it('BAD: a record from a different host is never reclaimed', async () => {
    const owner = parseLockOwner(ownerBody({ host: 'other-host', pid: process.pid }));
    expect(owner).not.toBeNull();
    const verdict = await classifyLockOwner(owner!, {
      host: os.hostname(),
      bootRefMs: bootRefMs(),
      isProcessAlive: () => false,
      processStartIdentity: async () => null,
    });
    expect(verdict.verdict).toBe('alive');
  });

  it('CORNER: a wall-clock adjustment never makes a live owner stale', async () => {
    const owner = parseLockOwner(
      ownerBody({
        pid: process.pid,
        startIdentity: 'proc-starttime:7',
        bootRefMs: bootRefMs() - 61_000,
      }),
    );
    const verdict = await classifyLockOwner(owner!, {
      host: os.hostname(),
      bootRefMs: bootRefMs(),
      isProcessAlive: () => true,
      processStartIdentity: async () => 'proc-starttime:7',
    });
    expect(verdict.verdict).toBe('alive');
  });

  it('CORNER: a lock from a previous boot is stale when its owner is gone', async () => {
    const owner = parseLockOwner(
      ownerBody({ pid: 4242, bootRefMs: bootRefMs() - 6 * 60 * 60 * 1000 }),
    );
    const verdict = await classifyLockOwner(owner!, {
      host: os.hostname(),
      bootRefMs: bootRefMs(),
      isProcessAlive: () => false,
      processStartIdentity: async () => null,
    });
    expect(verdict.verdict).toBe('stale');
  });

  it('CORNER: an underivable start identity keeps a live owner alive (fail-closed)', async () => {
    const owner = parseLockOwner(
      ownerBody({ pid: process.pid, startIdentity: 'proc-starttime:1' }),
    );
    const verdict = await classifyLockOwner(owner!, {
      host: os.hostname(),
      bootRefMs: bootRefMs(),
      isProcessAlive: () => true,
      processStartIdentity: async () => null,
    });
    expect(verdict.verdict).toBe('alive');
  });
});

describe('persistence-lock reclamation guard', () => {
  it('L1: exactly one reclaimer can hold the guard', async () => {
    const dir = await makeSessionDir();

    const first = await acquireReclaimGuard(dir, LOCK_FILE, 500);
    expect(first).not.toBeNull();

    // A second reclaimer must not be able to act while the first holds it.
    const second = await acquireReclaimGuard(dir, LOCK_FILE, 100);
    expect(second).toBeNull();

    await first?.release();
    const third = await acquireReclaimGuard(dir, LOCK_FILE, 500);
    expect(third).not.toBeNull();
    await third?.release();
  });

  it('L6: releasing the guard never removes a foreign owner entry', async () => {
    const dir = await makeSessionDir();
    const guard = await acquireReclaimGuard(dir, LOCK_FILE, 500);
    expect(guard).not.toBeNull();

    const guardDir = path.join(dir, `${LOCK_FILE}${RECLAIM_GUARD_SUFFIX}`);
    const foreign = path.join(guardDir, 'owner.foreign-claimant');
    await fs.writeFile(foreign, ownerBody({ token: 'foreign-claimant' }), 'utf-8');

    await guard?.release();

    // The foreign entry survives: release only ever unlinks its own entry.
    await expect(fs.readFile(foreign, 'utf-8')).resolves.toContain('foreign-claimant');
  });

  it('L1: a stale guard entry is reclaimed by a later process', async () => {
    const dir = await makeSessionDir();
    const guardDir = path.join(dir, `${LOCK_FILE}${RECLAIM_GUARD_SUFFIX}`);
    await fs.mkdir(guardDir);
    const deadPid = await deadProcessPid();
    await fs.writeFile(
      path.join(guardDir, 'owner.crashed'),
      ownerBody({ token: 'crashed', pid: deadPid }),
      'utf-8',
    );

    const guard = await acquireReclaimGuard(dir, LOCK_FILE, 2_000);
    expect(guard).not.toBeNull();
    await guard?.release();
  });
});

describe('persistence-lock stale reclamation', () => {
  it('L2: a live PID with a different start identity is reclaimed', async () => {
    const dir = await makeSessionDir();
    await fs.writeFile(
      sessionLockPath(dir),
      ownerBody({ pid: process.pid, startIdentity: 'proc-starttime:1' }),
      'utf-8',
    );

    const lock = await acquireNamedWriteLock(
      dir,
      LOCK_FILE,
      'session write',
      1_000,
      recycledPidProbe('proc-starttime:2'),
    );
    const raw = await fs.readFile(sessionLockPath(dir), 'utf-8');
    expect(raw).not.toContain('crashed-token');
    await lock.release();
  });

  it('L2: a recycled PID is reclaimed through the real /proc start identity', async () => {
    const recordedIdentity = await readProcessStartIdentity(process.pid);
    // NOT_VERIFIED on platforms without /proc: the probe returns null and a live
    // PID stays alive by the fail-closed rule.
    if (recordedIdentity === null) {
      expect(recordedIdentity).toBeNull();
      return;
    }
    const dir = await makeSessionDir();
    await fs.writeFile(
      sessionLockPath(dir),
      ownerBody({ pid: process.pid, startIdentity: 'proc-starttime:0000000001' }),
      'utf-8',
    );

    const lock = await acquireSessionWriteLock(dir, 1_000);
    await lock.release();
  });

  it('L1: a reclaimer never deletes a lock replaced after its stale verdict', async () => {
    const dir = await makeSessionDir();
    const lockPath = sessionLockPath(dir);
    await fs.writeFile(
      lockPath,
      ownerBody({ pid: 4242, startIdentity: 'proc-starttime:1' }),
      'utf-8',
    );

    // The first classification blocks on this gate. While it is blocked the
    // "other reclaimer" removes the stale lock and a fresh owner acquires it.
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let classificationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      classificationStarted = resolve;
    });
    let calls = 0;
    const probe: LivenessProbe = {
      host: os.hostname(),
      bootRefMs: bootRefMs(),
      isProcessAlive: () => true,
      processStartIdentity: async (pid) => {
        calls += 1;
        if (calls === 1) {
          classificationStarted();
          await gate;
          return 'proc-starttime:2';
        }
        return readProcessStartIdentity(pid);
      },
    };

    const acquisition = acquireNamedWriteLock(dir, LOCK_FILE, 'session write', 300, probe);
    await started;

    const winnerIdentity = await readProcessStartIdentity(process.pid);
    const winnerBody = ownerBody({
      token: 'winner-token',
      pid: process.pid,
      startIdentity: winnerIdentity,
    });
    await fs.writeFile(lockPath, winnerBody, 'utf-8');
    openGate();

    await expect(acquisition).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    await expect(fs.readFile(lockPath, 'utf-8')).resolves.toBe(winnerBody);
  });

  it('L3: a lock left by a crashed process is reclaimed without intervention', async () => {
    const dir = await makeSessionDir();
    const deadPid = await deadProcessPid();
    await fs.writeFile(sessionLockPath(dir), ownerBody({ pid: deadPid }), 'utf-8');

    const lock = await acquireSessionWriteLock(dir, 2_000);
    const raw = await fs.readFile(sessionLockPath(dir), 'utf-8');
    expect(raw).not.toContain('crashed-token');
    await lock.release();
  });

  it('L3: a crashed writer staging file never blocks or corrupts acquisition', async () => {
    const dir = await makeSessionDir();
    // A writer killed between staging and publish leaves only this file behind.
    await fs.writeFile(path.join(dir, `.${LOCK_FILE}.crashed.tmp`), 'pid=12', 'utf-8');

    const lock = await acquireSessionWriteLock(dir, 500);
    const raw = await fs.readFile(sessionLockPath(dir), 'utf-8');
    // Every visible lockfile carries a complete, parseable owner record: the
    // publish is a link of an already-fsynced staging file, never a partial write.
    expect(parseLockOwner(raw)).not.toBeNull();
    await lock.release();
  });

  it('L4: a live owner is never evicted and its lock is never removed', async () => {
    const dir = await makeSessionDir();
    const owner = await acquireSessionWriteLock(dir);
    const lockPath = sessionLockPath(dir);
    const before = await fs.stat(lockPath);
    const bodyBefore = await fs.readFile(lockPath, 'utf-8');

    await expect(acquireSessionWriteLock(dir, 150)).rejects.toMatchObject({
      code: 'LOCK_TIMEOUT',
    });

    const after = await fs.stat(lockPath);
    expect(await fs.readFile(lockPath, 'utf-8')).toBe(bodyBefore);
    // Same inode: the file was neither replaced nor deleted.
    expect(after.ino).toBe(before.ino);
    await owner.release();
  });

  it('L4: a shifted boot reference never evicts the live owner', async () => {
    const dir = await makeSessionDir();
    const owner = await acquireSessionWriteLock(dir);
    const lockPath = sessionLockPath(dir);
    const body = await fs.readFile(lockPath, 'utf-8');
    const shifted = body.replace(
      /^boot=(\d+)$/m,
      (_match, value: string) => `boot=${Number(value) - 61_000}`,
    );
    expect(shifted).not.toBe(body);
    await fs.writeFile(lockPath, shifted, 'utf-8');

    await expect(acquireSessionWriteLock(dir, 150)).rejects.toMatchObject({
      code: 'LOCK_TIMEOUT',
    });
    // The live owner keeps its exact lock: a wall-clock step is not proof of absence.
    await expect(fs.readFile(lockPath, 'utf-8')).resolves.toBe(shifted);
    await owner.release();
  });
});

/** Spawn a process that exits immediately, so its PID is provably not running. */
async function deadProcessPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', () => resolve());
  });
  if (pid === undefined) throw new Error('child process did not produce a pid');
  return pid;
}
