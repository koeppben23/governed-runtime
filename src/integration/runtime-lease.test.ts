import { describe, expect, it } from 'vitest';
import { acquireRuntimeLease } from './runtime-lease.js';
import type { RuntimeLease } from '../state/runtime-lease.js';
import { SessionState } from '../state/schema.js';
import { makeState } from '../fixtures.js';

const INSTANCE_A = '00000000-0000-4000-8000-00000000000a';
const INSTANCE_B = '00000000-0000-4000-8000-00000000000b';
const NOW = '2026-08-27T20:00:00.000Z';
const LATER = '2026-08-27T20:10:00.000Z';

function heldLease(result: ReturnType<typeof acquireRuntimeLease>): RuntimeLease {
  if (result.kind !== 'held') throw new Error(`expected a held lease, got ${result.kind}`);
  return result.lease;
}

describe('runtime lease (fenced runtime epoch)', () => {
  it('mints generation 1 for the first holder and refreshes its heartbeat', () => {
    const first = acquireRuntimeLease({
      current: null,
      runtimeInstanceId: INSTANCE_A,
      pid: process.pid,
      now: NOW,
    });
    expect(first.kind).toBe('held');
    expect(heldLease(first).generation).toBe(1);

    const refreshed = acquireRuntimeLease({
      current: heldLease(first),
      runtimeInstanceId: INSTANCE_A,
      pid: process.pid,
      now: LATER,
    });
    expect(heldLease(refreshed).generation).toBe(1);
    expect(heldLease(refreshed).lastHeartbeatAt).toBe(LATER);
  });

  it('blocks a concurrent instance while the holder is alive', () => {
    const held = heldLease(
      acquireRuntimeLease({
        current: null,
        runtimeInstanceId: INSTANCE_A,
        pid: process.pid,
        now: NOW,
      }),
    );
    const blocked = acquireRuntimeLease({
      current: held,
      runtimeInstanceId: INSTANCE_B,
      pid: process.pid,
      now: NOW,
    });
    expect(blocked.kind).toBe('blocked');
    expect(blocked.lease.holderRuntimeInstanceId).toBe(INSTANCE_A);
    expect(blocked.lease.generation).toBe(1);
  });

  it('supersedes a dead holder with a later generation (fencing)', () => {
    const dead = heldLease(
      acquireRuntimeLease({
        current: null,
        runtimeInstanceId: INSTANCE_A,
        pid: 999999,
        now: NOW,
      }),
    );
    const superseded = acquireRuntimeLease({
      current: dead,
      runtimeInstanceId: INSTANCE_B,
      pid: process.pid,
      now: LATER,
    });
    expect(heldLease(superseded).holderRuntimeInstanceId).toBe(INSTANCE_B);
    expect(heldLease(superseded).generation).toBe(2);
  });

  it('never fences a live holder, not even on a stale heartbeat', () => {
    const held = heldLease(
      acquireRuntimeLease({
        current: null,
        runtimeInstanceId: INSTANCE_A,
        pid: process.pid,
        now: NOW,
      }),
    );
    // The holder PID is provably alive. A heartbeat that is arbitrarily old
    // must never be fenced — the live process may still be executing its host
    // mutation.
    const blocked = acquireRuntimeLease({
      current: held,
      runtimeInstanceId: INSTANCE_B,
      pid: process.pid,
      now: '2026-08-28T20:00:00.000Z',
    });
    expect(blocked.kind).toBe('blocked');
    expect(blocked.lease.holderRuntimeInstanceId).toBe(INSTANCE_A);
    expect(blocked.lease.generation).toBe(1);
  });

  it('advances the generation strictly across successive dead-holder supersessions', () => {
    // Monotonicity is what makes the generation usable as a fencing token for
    // unknown-outcome resolutions. It now rests on the durable state write
    // rather than on a separately written lease file.
    let lease = heldLease(
      acquireRuntimeLease({
        current: null,
        runtimeInstanceId: INSTANCE_A,
        pid: 999999,
        now: NOW,
      }),
    );
    const seen = [lease.generation];
    for (const instance of [INSTANCE_B, INSTANCE_A, INSTANCE_B]) {
      lease = heldLease(
        acquireRuntimeLease({ current: lease, runtimeInstanceId: instance, pid: 999999, now: NOW }),
      );
      seen.push(lease.generation);
    }
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it('fails closed on a corrupt persisted lease (BAD)', () => {
    // Corruption is no longer this module's concern: the lease is part of
    // SessionState, so the canonical state schema rejects it on read instead
    // of a bespoke parse in the lease module.
    const base = makeState();
    expect(
      SessionState.safeParse({ ...base, runtimeLease: { holderRuntimeInstanceId: 'not-a-uuid' } })
        .success,
    ).toBe(false);
    expect(SessionState.safeParse({ ...base, runtimeLease: { generation: 0 } }).success).toBe(
      false,
    );
    expect(SessionState.safeParse({ ...base, runtimeLease: null }).success).toBe(true);
  });
});
