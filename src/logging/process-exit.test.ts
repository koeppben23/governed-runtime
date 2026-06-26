/**
 * @module logging/process-exit.test
 * @description Tests for the process-exit registrar seam.
 *
 * Verifies the production registrar binds exit signals once, runs the callback
 * at most once across multiple signals, swallows callback errors, and that the
 * dispose function removes the listeners.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { processExitRegistrar } from './process-exit.js';

const SIGNALS = ['SIGTERM', 'SIGINT', 'beforeExit'] as const;

function listenerCounts(): Record<string, number> {
  return Object.fromEntries(SIGNALS.map((s) => [s, process.listenerCount(s)]));
}

describe('processExitRegistrar', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('HAPPY: registers a listener on each exit signal and dispose removes them', () => {
    const before = listenerCounts();
    const dispose = processExitRegistrar.register(() => {});
    const during = listenerCounts();
    for (const s of SIGNALS) {
      expect(during[s]).toBe(before[s]! + 1);
    }
    dispose();
    const after = listenerCounts();
    for (const s of SIGNALS) {
      expect(after[s]).toBe(before[s]!);
    }
  });

  it('HAPPY: callback runs when a signal fires', async () => {
    const cb = vi.fn();
    const dispose = processExitRegistrar.register(cb);
    process.emit('beforeExit', 0 as never);
    // allow the fire-and-forget microtask to settle
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('CORNER: callback runs at most once across multiple signals', async () => {
    const cb = vi.fn();
    const dispose = processExitRegistrar.register(cb);
    process.emit('SIGINT', 'SIGINT' as never);
    process.emit('SIGTERM', 'SIGTERM' as never);
    process.emit('beforeExit', 0 as never);
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('BAD: a throwing callback does not propagate out of the handler', async () => {
    const cb = vi.fn(() => {
      throw new Error('boom');
    });
    const dispose = processExitRegistrar.register(cb);
    expect(() => process.emit('beforeExit', 0 as never)).not.toThrow();
    await Promise.resolve();
    dispose();
  });

  it('BAD: a rejecting async callback is swallowed', async () => {
    const cb = vi.fn().mockRejectedValue(new Error('async boom'));
    const dispose = processExitRegistrar.register(cb);
    expect(() => process.emit('beforeExit', 0 as never)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('EDGE: dispose before any signal prevents the callback from running', async () => {
    const cb = vi.fn();
    const dispose = processExitRegistrar.register(cb);
    dispose();
    process.emit('beforeExit', 0 as never);
    await Promise.resolve();
    expect(cb).not.toHaveBeenCalled();
  });
});
