import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRuntimeInstanceId, resetRuntimeInstanceIdForTest } from './runtime-instance.js';
import { acquireRuntimeLease } from './runtime-lease.js';

afterEach(() => {
  resetRuntimeInstanceIdForTest();
});

describe('process-owned runtime identity', () => {
  it('survives a real module re-evaluation without creating a new lease epoch', async () => {
    const before = getRuntimeInstanceId();
    const first = acquireRuntimeLease({
      current: null,
      runtimeInstanceId: before,
      pid: process.pid,
      now: new Date().toISOString(),
    });
    expect(first.kind).toBe('held');
    vi.resetModules();
    const reloaded = await import('./runtime-instance.js');
    expect(reloaded.getRuntimeInstanceId()).toBe(before);
    const after = acquireRuntimeLease({
      current: first.lease,
      runtimeInstanceId: reloaded.getRuntimeInstanceId(),
      pid: process.pid,
      now: new Date().toISOString(),
    });
    expect(after.kind).toBe('held');
    expect(after.lease.generation).toBe(1);
  });

  it('keeps a distinct live process identity blocked instead of granting takeover', () => {
    const old = getRuntimeInstanceId();
    const first = acquireRuntimeLease({
      current: null,
      runtimeInstanceId: old,
      pid: process.pid,
      now: new Date().toISOString(),
    });
    const next = resetRuntimeInstanceIdForTest();
    expect(next).not.toBe(old);
    expect(
      acquireRuntimeLease({
        current: first.lease,
        runtimeInstanceId: next,
        pid: process.pid,
        now: new Date().toISOString(),
      }).kind,
    ).toBe('blocked');
  });
});
