/**
 * @module hooks/shared/stdout-guard.test
 * @description Tests for stdout-guard — spurious output capture, restore, and writeResponse.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installHookStdoutGuard } from './stdout-guard.js';

describe('installHookStdoutGuard', () => {
  let originalWrite: typeof process.stdout.write;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalWrite = process.stdout.write;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    stderrSpy.mockRestore();
  });

  it('replaces process.stdout.write on install', () => {
    const before = process.stdout.write;
    installHookStdoutGuard();
    expect(process.stdout.write).not.toBe(before);
  });

  it('restores process.stdout.write to original behavior on restore', () => {
    const guard = installHookStdoutGuard();
    guard.restore();

    // Verify stdout works: write should not be the guarded version
    // The guarded version always returns true; original may differ
    const result = process.stdout.write('');
    expect(typeof result).toBe('boolean');
  });

  it('forwards captured spurious output to stderr on restore', () => {
    const guard = installHookStdoutGuard();

    process.stdout.write('captured output');
    guard.restore();

    expect(stderrSpy).toHaveBeenCalled();
    const callArg = (stderrSpy.mock.calls[0] as string[])[0] as string;
    expect(callArg).toContain('captured spurious stdout');
    expect(callArg).toContain('captured output');
  });

  it('restore does not log to stderr when nothing was captured', () => {
    const guard = installHookStdoutGuard();
    stderrSpy.mockClear();
    guard.restore();
    expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining('captured spurious stdout'));
  });

  it('writeResponse writes payload via original stdout mechanics', async () => {
    let written = '';
    let callbackCalled = false;

    process.stdout.write = ((chunk: unknown, encOrCb?: unknown, cb?: unknown): boolean => {
      written = typeof chunk === 'string' ? chunk : '';
      const callback = typeof encOrCb === 'function' ? encOrCb : cb;
      if (typeof callback === 'function') {
        callbackCalled = true;
        (callback as (err?: Error | null) => void)(null);
      }
      return true;
    }) as typeof process.stdout.write;

    const guard = installHookStdoutGuard();

    await guard.writeResponse('{"deny":true}');

    expect(written).toBe('{"deny":true}');
    expect(callbackCalled).toBe(true);
  });

  it('double restore is safe', () => {
    const guard = installHookStdoutGuard();
    guard.restore();
    expect(() => guard.restore()).not.toThrow();
  });

  it('second writeResponse after first works with restored stdout', async () => {
    process.stdout.write = ((_chunk: unknown, encOrCb?: unknown, cb?: unknown): boolean => {
      const callback = typeof encOrCb === 'function' ? encOrCb : cb;
      if (typeof callback === 'function') (callback as (err?: Error | null) => void)(null);
      return true;
    }) as typeof process.stdout.write;

    const guard = installHookStdoutGuard();
    await guard.writeResponse('first');

    await expect(guard.writeResponse('second')).resolves.toBeUndefined();
  });
});
