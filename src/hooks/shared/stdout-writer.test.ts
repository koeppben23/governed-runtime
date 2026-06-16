/**
 * @module hooks/shared/stdout-writer.test
 * @description Tests for stdout-writer — deny output formatting, stdout writing, and fallback behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DenyOutputError, formatDenyOutput, writeDeny, writeLog } from './stdout-writer.js';

// ─── formatDenyOutput ─────────────────────────────────────────────────────────

describe('formatDenyOutput', () => {
  it('formats a deny decision with all fields', () => {
    const result = formatDenyOutput(
      'PreToolUse',
      'HOST_TOOL_PHASE_DENIED',
      'Tool not allowed during archiving',
    );
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'HOST_TOOL_PHASE_DENIED: Tool not allowed during archiving',
      },
    });
  });

  it('formats with different event names', () => {
    const result = formatDenyOutput('PostToolUse', 'CODE', 'reason');
    expect(result.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

// ─── writeLog ─────────────────────────────────────────────────────────────────

describe('writeLog', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('writes prefixed message to stderr', () => {
    writeLog('test message');
    expect(stderrSpy).toHaveBeenCalledWith('[FlowGuard Hook] test message\n');
  });
});

// ─── writeDeny ────────────────────────────────────────────────────────────────

describe('writeDeny', () => {
  const originalExitCode = process.exitCode;
  let stdoutWriteSaved: typeof process.stdout.write;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.exitCode = undefined;
    stdoutWriteSaved = process.stdout.write;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.stdout.write = stdoutWriteSaved;
    stderrSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it('writes deny JSON to stdout on success', async () => {
    let written = '';
    process.stdout.write = ((chunk: unknown, encOrCb?: unknown, cb?: unknown): boolean => {
      written = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString();
      const callback = typeof encOrCb === 'function' ? encOrCb : cb;
      if (typeof callback === 'function') (callback as (err?: Error | null) => void)(null);
      return true;
    }) as typeof process.stdout.write;

    const stdoutOnce = vi.spyOn(process.stdout, 'once').mockImplementation(() => process.stdout);
    const stdoutOff = vi.spyOn(process.stdout, 'off').mockImplementation(() => process.stdout);

    await writeDeny('PreToolUse', 'PHASE_DENIED', 'archiving in progress');

    expect(written).toContain('"permissionDecision":"deny"');
    expect(written).toContain('PHASE_DENIED');
    expect(process.exitCode).toBeUndefined();

    stdoutOnce.mockRestore();
    stdoutOff.mockRestore();
  });

  it('sets exitCode=2 and writes to stderr when stdout write throws synchronously', async () => {
    process.stdout.write = (() => {
      throw new Error('stdout broken');
    }) as unknown as typeof process.stdout.write;

    const stdoutOnce = vi.spyOn(process.stdout, 'once').mockImplementation(() => process.stdout);
    const stdoutOff = vi.spyOn(process.stdout, 'off').mockImplementation(() => process.stdout);

    await expect(writeDeny('PreToolUse', 'CODE', 'reason')).rejects.toThrow(DenyOutputError);
    expect(process.exitCode).toBe(2);
    expect(stderrSpy).toHaveBeenCalled();

    stdoutOnce.mockRestore();
    stdoutOff.mockRestore();
  });

  it('sets exitCode=2 when stdout write calls back with error', async () => {
    process.stdout.write = ((_chunk: unknown, encOrCb?: unknown, _cb?: unknown): boolean => {
      const callback = typeof encOrCb === 'function' ? encOrCb : undefined;
      if (typeof callback === 'function')
        (callback as (err?: Error | null) => void)(new Error('write failed'));
      return false;
    }) as typeof process.stdout.write;

    const stdoutOnce = vi.spyOn(process.stdout, 'once').mockImplementation(() => process.stdout);
    const stdoutOff = vi.spyOn(process.stdout, 'off').mockImplementation(() => process.stdout);

    await expect(writeDeny('PreToolUse', 'CODE', 'reason')).rejects.toThrow(DenyOutputError);
    expect(process.exitCode).toBe(2);

    stdoutOnce.mockRestore();
    stdoutOff.mockRestore();
  });
});
