/**
 * @module hooks/pre-tool-use-fatal.test
 * @description Regression tests for pre-tool-use fatal fail-closed stdout delivery.
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/354
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadStdin = vi.hoisted(() => vi.fn());
const mockResolveSession = vi.hoisted(() => vi.fn());

vi.mock('./shared/stdin-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shared/stdin-reader.js')>();
  return {
    ...actual,
    readStdin: (...args: unknown[]) => mockReadStdin(...args),
  };
});

vi.mock('./shared/session-resolver.js', () => ({
  resolveSession: (...args: unknown[]) => mockResolveSession(...args),
}));

const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

describe('pre-tool-use fatal stdout guard regression', () => {
  beforeEach(() => {
    vi.resetModules();
    mockReadStdin.mockReset();
    mockResolveSession.mockReset();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('BAD: restores stdout guard before fatal DENY for unexpected mutating-tool errors', async () => {
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk, encodingOrCallback, callback) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const cb = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      if (cb) cb(null);
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    mockReadStdin.mockResolvedValue({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      session_id: 'sess_354',
      cwd: '/project',
    });
    mockResolveSession.mockRejectedValue(new TypeError('corrupted state object'));

    await import('./pre-tool-use.js');

    await vi.waitFor(() => {
      expect(stdout).toContain('HOOK_FATAL_ERROR');
    });

    expect(stdout.trim()).not.toBe('');
    const parsed = JSON.parse(stdout.trim()) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('HOOK_FATAL_ERROR');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('corrupted state object');
  });
});
