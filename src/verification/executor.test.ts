/**
 * @module verification/executor.test
 * @description Tests for subprocess-based verification command executor.
 *
 * Tests cover:
 * - HAPPY: Successful command execution (exit 0, passed=true)
 * - BAD: Non-zero exit code (exit 1, passed=false)
 * - BAD: Command not found (exit 127)
 * - CORNER: Timeout handling (timedOut=true, exitCode=124)
 * - CORNER: Output truncation (stdout > MAX_OUTPUT_BYTES)
 * - EDGE: outputDigest is sha256 of FULL output (before truncation)
 * - EDGE: Per-kind timeout defaults applied correctly
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { executeCheck, KIND_TIMEOUTS, type ExecuteCheckInput } from './executor.js';

// ─── Mock child_process.execFile ─────────────────────────────────────────────

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

interface MockExecFileOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  windowsHide?: boolean;
  env?: Record<string, string | undefined>;
}

let mockExecFileImpl: (
  file: string,
  args: string[],
  options: MockExecFileOptions,
  callback: ExecFileCallback,
) => { unref?: () => void };

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    options: MockExecFileOptions,
    callback: ExecFileCallback,
  ) => mockExecFileImpl(file, args, options, callback),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setMockResult(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  killed?: boolean;
  errorMessage?: string;
}) {
  mockExecFileImpl = (_file, _args, _options, callback) => {
    if (opts.exitCode === 0 && !opts.killed && !opts.errorMessage) {
      // Success
      callback(null, opts.stdout ?? '', opts.stderr ?? '');
    } else {
      // Failure — real execFile passes stdout/stderr as 2nd/3rd args even on error
      const err = new Error(
        opts.errorMessage ?? `Command failed with exit code ${opts.exitCode}`,
      ) as Error & {
        code: number;
        killed: boolean;
        stdout: string;
        stderr: string;
      };
      err.code = opts.exitCode ?? 1;
      err.killed = opts.killed ?? false;
      err.stdout = opts.stdout ?? '';
      err.stderr = opts.stderr ?? '';
      callback(err, opts.stdout ?? '', opts.stderr ?? '');
    }
    return { unref: () => {} };
  };
}

function makeInput(overrides: Partial<ExecuteCheckInput> = {}): ExecuteCheckInput {
  return {
    kind: 'lint',
    command: 'npm run lint',
    cwd: '/fake/cwd',
    ...overrides,
  };
}

beforeEach(() => {
  // Default: successful execution
  setMockResult({ exitCode: 0, stdout: 'OK', stderr: '' });
});

// ─── HAPPY ───────────────────────────────────────────────────────────────────

describe('HAPPY', () => {
  it('returns passed=true on exit code 0', async () => {
    setMockResult({ exitCode: 0, stdout: 'All clear', stderr: '' });
    const result = await executeCheck(makeInput());

    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('All clear');
    expect(result.stderr).toBe('');
    expect(result.timedOut).toBe(false);
    expect(result.kind).toBe('lint');
    expect(result.command).toBe('npm run lint');
  });

  it('produces valid sha256 outputDigest', async () => {
    setMockResult({ exitCode: 0, stdout: 'hello', stderr: 'world' });
    const result = await executeCheck(makeInput());

    const expected = createHash('sha256').update('helloworld', 'utf-8').digest('hex');
    expect(result.outputDigest).toBe(expected);
    expect(result.outputDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('includes startedAt as ISO timestamp', async () => {
    const result = await executeCheck(makeInput());
    expect(new Date(result.startedAt).toISOString()).toBe(result.startedAt);
  });

  it('executionMs is a non-negative integer', async () => {
    const result = await executeCheck(makeInput());
    expect(result.executionMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.executionMs)).toBe(true);
  });
});

// ─── BAD ─────────────────────────────────────────────────────────────────────

describe('BAD', () => {
  it('returns passed=false on non-zero exit code', async () => {
    setMockResult({ exitCode: 1, stdout: '', stderr: 'Error: lint failed' });
    const result = await executeCheck(makeInput());

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('Error: lint failed');
    expect(result.timedOut).toBe(false);
  });

  it('returns exitCode=127 for command not found (non-exec error)', async () => {
    // Simulate a non-exec error (e.g., execFile throws something unexpected).
    // The executor's isExecError check fails if the error has no stdout/stderr/code.
    mockExecFileImpl = () => {
      throw 'unexpected failure'; // not an Error instance → falls through isExecError
    };
    const result = await executeCheck(makeInput());

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('EXECUTOR_ERROR');
  });

  it('preserves exit code from subprocess', async () => {
    setMockResult({ exitCode: 2, stdout: '', stderr: 'fatal' });
    const result = await executeCheck(makeInput());
    expect(result.exitCode).toBe(2);
  });
});

// ─── CORNER ──────────────────────────────────────────────────────────────────

describe('CORNER', () => {
  it('sets timedOut=true and exitCode=124 when process is killed by timeout', async () => {
    setMockResult({ exitCode: 0, killed: true, stdout: 'partial', stderr: '' });
    const result = await executeCheck(makeInput());

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(result.passed).toBe(false);
    expect(result.stdout).toBe('partial');
  });

  it('truncates stdout exceeding MAX_OUTPUT_BYTES (4096)', async () => {
    const bigOutput = 'x'.repeat(5000);
    setMockResult({ exitCode: 0, stdout: bigOutput, stderr: '' });
    const result = await executeCheck(makeInput());

    expect(result.stdout.length).toBeLessThan(bigOutput.length);
    expect(result.stdout).toContain('…[truncated]');
    expect(result.stdout.length).toBe(4096 + '\n…[truncated]'.length);
  });

  it('truncates stderr exceeding MAX_OUTPUT_BYTES (4096)', async () => {
    const bigError = 'e'.repeat(5000);
    setMockResult({ exitCode: 1, stdout: '', stderr: bigError });
    const result = await executeCheck(makeInput());

    expect(result.stderr).toContain('…[truncated]');
  });

  it('outputDigest is computed from FULL output before truncation', async () => {
    const bigOutput = 'x'.repeat(5000);
    setMockResult({ exitCode: 0, stdout: bigOutput, stderr: '' });
    const result = await executeCheck(makeInput());

    // Digest should be of the FULL output, not truncated
    const expected = createHash('sha256').update(bigOutput, 'utf-8').digest('hex');
    expect(result.outputDigest).toBe(expected);
  });
});

// ─── EDGE ────────────────────────────────────────────────────────────────────

describe('EDGE', () => {
  it('applies per-kind timeout defaults', async () => {
    let capturedTimeout: number | undefined;
    mockExecFileImpl = (_file, _args, options, callback) => {
      capturedTimeout = options.timeout;
      callback(null, '', '');
      return { unref: () => {} };
    };

    await executeCheck(makeInput({ kind: 'test' }));
    expect(capturedTimeout).toBe(KIND_TIMEOUTS.test); // 300_000

    await executeCheck(makeInput({ kind: 'lint' }));
    expect(capturedTimeout).toBe(KIND_TIMEOUTS.lint); // 60_000

    await executeCheck(makeInput({ kind: 'coverage' }));
    expect(capturedTimeout).toBe(KIND_TIMEOUTS.coverage); // 600_000
  });

  it('honors timeoutMs override over kind default', async () => {
    let capturedTimeout: number | undefined;
    mockExecFileImpl = (_file, _args, options, callback) => {
      capturedTimeout = options.timeout;
      callback(null, '', '');
      return { unref: () => {} };
    };

    await executeCheck(makeInput({ kind: 'test', timeoutMs: 5000 }));
    expect(capturedTimeout).toBe(5000);
  });

  it('uses correct shell for platform', async () => {
    let capturedFile: string | undefined;
    let capturedArgs: string[] | undefined;
    mockExecFileImpl = (file, args, _options, callback) => {
      capturedFile = file;
      capturedArgs = args;
      callback(null, '', '');
      return { unref: () => {} };
    };

    await executeCheck(makeInput({ command: 'npm test' }));

    if (process.platform === 'win32') {
      expect(capturedFile).toBe('cmd.exe');
      expect(capturedArgs).toEqual(['/c', 'npm test']);
    } else {
      expect(capturedFile).toBe('/bin/sh');
      expect(capturedArgs).toEqual(['-c', 'npm test']);
    }
  });

  it('passes cwd to subprocess', async () => {
    let capturedCwd: string | undefined;
    mockExecFileImpl = (_file, _args, options, callback) => {
      capturedCwd = options.cwd;
      callback(null, '', '');
      return { unref: () => {} };
    };

    await executeCheck(makeInput({ cwd: '/my/project' }));
    expect(capturedCwd).toBe('/my/project');
  });

  it('sets windowsHide and color env vars', async () => {
    let capturedOptions: MockExecFileOptions | undefined;
    mockExecFileImpl = (_file, _args, options, callback) => {
      capturedOptions = options;
      callback(null, '', '');
      return { unref: () => {} };
    };

    await executeCheck(makeInput());
    expect(capturedOptions?.windowsHide).toBe(true);
    expect(capturedOptions?.env?.FORCE_COLOR).toBe('0');
    expect(capturedOptions?.env?.NO_COLOR).toBe('1');
  });
});
