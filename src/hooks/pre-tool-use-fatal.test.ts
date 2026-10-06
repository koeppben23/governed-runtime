/**
 * @module hooks/pre-tool-use-fatal.test
 * @description Regression tests for pre-tool-use fatal fail-closed delivery.
 *
 * The fatal path stays inside the guard lifetime and uses the same robust
 * stdout transport as every other decision:
 * - delivered DENY → deny JSON + exit 0,
 * - undeliverable DENY → exit code 2 + best-effort stderr payload,
 * - a previous DenyOutputError is terminal (no second delivery).
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

interface Captured {
  readonly stdout: () => string;
  readonly stderr: () => string;
}

/** Install stdout/stderr capture before the hook module (and its guard) loads. */
function capture(): Captured {
  let stdout = '';
  let stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk, encodingOrCallback, callback) => {
    stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const cb = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (cb) cb(null);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    return true;
  });
  return { stdout: () => stdout, stderr: () => stderr };
}

function mutatingPayload(): Record<string, unknown> {
  return {
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    session_id: 'sess_h6',
    cwd: '/project',
  };
}

describe('pre-tool-use fatal fail-closed delivery', () => {
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

  it('BAD: delivers fatal DENY inside the guard lifetime for unexpected mutating-tool errors', async () => {
    const output = capture();

    mockReadStdin.mockResolvedValue(mutatingPayload());
    mockResolveSession.mockRejectedValue(new TypeError('corrupted state object'));

    await import('./pre-tool-use.js');

    await vi.waitFor(() => {
      expect(output.stdout()).toContain('HOOK_FATAL_ERROR');
    });

    expect(output.stdout().trim()).not.toBe('');
    const parsed = JSON.parse(output.stdout().trim()) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('HOOK_FATAL_ERROR');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('corrupted state object');
    // A delivered DENY keeps the success exit code (the JSON decision is authority).
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('exits 2 with stderr fallback when the fatal DENY write throws synchronously', async () => {
    const output = capture();
    vi.mocked(process.stdout.write).mockImplementation(() => {
      throw new Error('sync EPIPE');
    });

    mockReadStdin.mockResolvedValue(mutatingPayload());
    mockResolveSession.mockRejectedValue(new TypeError('fatal sync delivery'));

    await import('./pre-tool-use.js');

    await vi.waitFor(() => {
      expect(process.exitCode).toBe(2);
    });
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain('DENY_OUTPUT_FAILED');
    expect(output.stderr()).toContain('HOOK_FATAL_ERROR');
  });

  it('exits 2 with stderr fallback when the fatal DENY write callback reports an error', async () => {
    const output = capture();
    const writeImpl: typeof process.stdout.write = (_chunk, callback) => {
      if (typeof callback === 'function') callback(new Error('callback EPIPE'));
      return true;
    };
    vi.mocked(process.stdout.write).mockImplementation(writeImpl);

    mockReadStdin.mockResolvedValue(mutatingPayload());
    mockResolveSession.mockRejectedValue(new TypeError('fatal callback delivery'));

    await import('./pre-tool-use.js');

    await vi.waitFor(() => {
      expect(process.exitCode).toBe(2);
    });
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain('DENY_OUTPUT_FAILED');
    expect(output.stderr()).toContain('HOOK_FATAL_ERROR');
  });

  it('exits 2 with stderr fallback when stdout emits an error during the fatal DENY', async () => {
    const output = capture();
    vi.mocked(process.stdout.write).mockImplementation(() => {
      process.stdout.emit('error', new Error('stream EPIPE'));
      return true;
    });

    mockReadStdin.mockResolvedValue(mutatingPayload());
    mockResolveSession.mockRejectedValue(new TypeError('fatal stream delivery'));

    await import('./pre-tool-use.js');

    await vi.waitFor(() => {
      expect(process.exitCode).toBe(2);
    });
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain('DENY_OUTPUT_FAILED');
    expect(output.stderr()).toContain('HOOK_FATAL_ERROR');
  });

  it('does not reconstruct a second DENY after a failed normal DENY delivery', async () => {
    const output = capture();
    vi.mocked(process.stdout.write).mockImplementation(() => {
      throw new Error('sync EPIPE');
    });

    mockReadStdin.mockResolvedValue(mutatingPayload());
    mockResolveSession.mockResolvedValue({
      ok: false,
      code: 'SESSION_DIR_NOT_FOUND',
      reason: 'session missing',
    });

    await import('./pre-tool-use.js');

    await vi.waitFor(() => {
      expect(process.exitCode).toBe(2);
    });
    expect(output.stderr()).toContain('SESSION_DIR_NOT_FOUND');
    expect(output.stderr()).not.toContain('HOOK_FATAL_ERROR');
    // Exactly one payload attempt, not two protocol deliveries.
    expect(output.stderr().match(/permissionDecision"/g)).toHaveLength(1);
  });
});
