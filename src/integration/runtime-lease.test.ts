import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireRuntimeLease, RUNTIME_LEASE_FILE } from './runtime-lease.js';

const INSTANCE_A = '00000000-0000-4000-8000-00000000000a';
const INSTANCE_B = '00000000-0000-4000-8000-00000000000b';
const NOW = '2026-08-27T20:00:00.000Z';
const LATER = '2026-08-27T20:10:00.000Z';

describe('runtime lease (fenced runtime epoch)', () => {
  let sessDir: string;

  beforeEach(async () => {
    sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-lease-'));
  });

  afterEach(async () => {
    await fs.rm(sessDir, { recursive: true, force: true });
  });

  it('mints generation 1 for the first holder and refreshes its heartbeat', async () => {
    const first = await acquireRuntimeLease({
      sessDir,
      runtimeInstanceId: INSTANCE_A,
      pid: process.pid,
      now: NOW,
    });
    expect(first.kind).toBe('held');
    if (first.kind !== 'held') return;
    expect(first.lease.generation).toBe(1);

    const refreshed = await acquireRuntimeLease({
      sessDir,
      runtimeInstanceId: INSTANCE_A,
      pid: process.pid,
      now: LATER,
    });
    expect(refreshed.kind).toBe('held');
    if (refreshed.kind !== 'held') return;
    expect(refreshed.lease.generation).toBe(1);
    expect(refreshed.lease.lastHeartbeatAt).toBe(LATER);
  });

  it('blocks a concurrent instance while the holder is alive and fresh', async () => {
    await acquireRuntimeLease({
      sessDir,
      runtimeInstanceId: INSTANCE_A,
      pid: process.pid,
      now: NOW,
    });
    const blocked = await acquireRuntimeLease({
      sessDir,
      runtimeInstanceId: INSTANCE_B,
      pid: process.pid,
      now: NOW,
    });
    expect(blocked.kind).toBe('blocked');
    if (blocked.kind !== 'blocked') return;
    expect(blocked.lease.holderRuntimeInstanceId).toBe(INSTANCE_A);
    expect(blocked.lease.generation).toBe(1);
  });

  it('supersedes a dead holder with a later generation (fencing)', async () => {
    await acquireRuntimeLease({
      sessDir,
      runtimeInstanceId: INSTANCE_A,
      pid: 999999,
      now: NOW,
    });
    const superseded = await acquireRuntimeLease({
      sessDir,
      runtimeInstanceId: INSTANCE_B,
      pid: process.pid,
      now: LATER,
    });
    expect(superseded.kind).toBe('held');
    if (superseded.kind !== 'held') return;
    expect(superseded.lease.holderRuntimeInstanceId).toBe(INSTANCE_B);
    expect(superseded.lease.generation).toBe(2);
  });

  it('supersedes a stale heartbeat with a later generation', async () => {
    await acquireRuntimeLease({
      sessDir,
      runtimeInstanceId: INSTANCE_A,
      pid: process.pid,
      now: NOW,
    });
    // The holder is alive, but the heartbeat is far outside the TTL window.
    const superseded = await acquireRuntimeLease({
      sessDir,
      runtimeInstanceId: INSTANCE_B,
      pid: process.pid,
      now: '2026-08-28T20:00:00.000Z',
      ttlMs: 60_000,
    });
    expect(superseded.kind).toBe('held');
    if (superseded.kind !== 'held') return;
    expect(superseded.lease.generation).toBe(2);
  });

  it('fails closed on a corrupt lease file', async () => {
    await fs.writeFile(path.join(sessDir, RUNTIME_LEASE_FILE), '{not-valid', 'utf-8');
    await expect(
      acquireRuntimeLease({
        sessDir,
        runtimeInstanceId: INSTANCE_A,
        pid: process.pid,
        now: NOW,
      }),
    ).rejects.toThrow();
  });
});
