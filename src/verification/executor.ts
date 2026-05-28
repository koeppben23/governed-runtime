/**
 * @module verification/executor
 * @description Subprocess-based verification command executor.
 *
 * Executes verification commands (lint, test, typecheck, build, etc.) as child
 * processes and produces cryptographic execution evidence.
 *
 * Design:
 * - Uses child_process.execFile with shell:true for script-based commands
 * - Per-kind timeout defaults (configurable)
 * - sha256 digest of combined stdout+stderr (tamper-evident evidence binding)
 * - Output truncation to bounded size (avoids token overflow)
 * - Fail-closed: any internal error is surfaced, never silently swallowed
 *
 * Security:
 * - Commands come ONLY from verificationCandidates (discovery-derived, not user input)
 * - Timeout protection per kind
 * - windowsHide: true (suppress console window on Windows)
 *
 * @version v1
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { VerificationCandidateKind } from '../state/discovery-schemas.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Execution evidence produced by running a verification command. */
export interface ExecutionEvidence {
  /** The kind of verification that was run. */
  readonly kind: VerificationCandidateKind;
  /** The exact command that was executed. */
  readonly command: string;
  /** Process exit code (0 = success). */
  readonly exitCode: number;
  /** Whether the check passed (exitCode === 0). */
  readonly passed: boolean;
  /** Execution wall-clock duration in milliseconds. */
  readonly executionMs: number;
  /** sha256 hex digest of (stdout + stderr) — tamper-evident binding. */
  readonly outputDigest: string;
  /** Truncated stdout (bounded to MAX_OUTPUT_BYTES). */
  readonly stdout: string;
  /** Truncated stderr (bounded to MAX_OUTPUT_BYTES). */
  readonly stderr: string;
  /** Whether the process was killed due to timeout. */
  readonly timedOut: boolean;
  /** ISO timestamp when execution started. */
  readonly startedAt: string;
}

/** Input for executing a verification command. */
export interface ExecuteCheckInput {
  /** The verification kind (used for timeout lookup). */
  readonly kind: VerificationCandidateKind;
  /** The shell command to execute. */
  readonly command: string;
  /** Working directory (repo root). */
  readonly cwd: string;
  /** Optional timeout override in ms. */
  readonly timeoutMs?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Per-kind default timeouts in milliseconds. */
export const KIND_TIMEOUTS: Readonly<Record<VerificationCandidateKind, number>> = {
  lint: 60_000,
  typecheck: 60_000,
  test: 300_000,
  build: 300_000,
  format: 30_000,
  security: 120_000,
  coverage: 600_000,
};

/** Maximum bytes of stdout/stderr to include in evidence. */
const MAX_OUTPUT_BYTES = 4096;

// ─── Executor ─────────────────────────────────────────────────────────────────

/**
 * Execute a verification command and produce cryptographic execution evidence.
 *
 * Fail-closed: internal errors throw (never return fake evidence).
 * Subprocess failures (non-zero exit) are captured as evidence (passed=false).
 */
export async function executeCheck(input: ExecuteCheckInput): Promise<ExecutionEvidence> {
  const { kind, command, cwd } = input;
  const timeoutMs = input.timeoutMs ?? KIND_TIMEOUTS[kind];
  const startedAt = new Date().toISOString();
  const startTime = performance.now();

  let stdout = '';
  let stderr = '';
  let exitCode = 1;
  let timedOut = false;

  try {
    const result = await execInShell(command, cwd, timeoutMs);
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = 0;
  } catch (err: unknown) {
    if (isExecError(err)) {
      stdout = typeof err.stdout === 'string' ? err.stdout : '';
      stderr = typeof err.stderr === 'string' ? err.stderr : '';
      exitCode = typeof err.code === 'number' ? err.code : 1;
      timedOut = err.killed === true;
      // If killed by timeout, set special exit code
      if (timedOut) exitCode = 124; // Convention: 124 = timeout
    } else {
      // Unexpected error (e.g., command not found)
      const msg = err instanceof Error ? err.message : String(err);
      stderr = `EXECUTOR_ERROR: ${msg}`;
      exitCode = 127; // Convention: 127 = command not found
    }
  }

  const executionMs = Math.round(performance.now() - startTime);

  // Compute tamper-evident digest BEFORE truncation (full output)
  const outputDigest = createHash('sha256')
    .update(stdout + stderr, 'utf-8')
    .digest('hex');

  // Truncate for evidence embedding
  const truncatedStdout = truncateOutput(stdout);
  const truncatedStderr = truncateOutput(stderr);

  return {
    kind,
    command,
    exitCode,
    passed: exitCode === 0,
    executionMs,
    outputDigest,
    stdout: truncatedStdout,
    stderr: truncatedStderr,
    timedOut,
    startedAt,
  };
}

// ─── Internals ────────────────────────────────────────────────────────────────

interface ExecError {
  stdout?: string;
  stderr?: string;
  code?: number;
  killed?: boolean;
}

function isExecError(err: unknown): err is ExecError & Error {
  return err instanceof Error && ('stdout' in err || 'stderr' in err || 'code' in err);
}

/**
 * Execute a command in a shell subprocess.
 *
 * Uses execFile with shell:true to support piped/compound commands
 * from package.json scripts (e.g., "tsc && eslint .").
 */
function execInShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // On Windows: use cmd.exe /c; on POSIX: use /bin/sh -c
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWindows ? ['/c', command] : ['-c', command];

    const child = execFile(
      shell,
      shellArgs,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB max buffer
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      },
      (error, stdout, stderr) => {
        if (error) {
          // Attach stdout/stderr to the error for caller to extract
          (error as ExecError).stdout = stdout;
          (error as ExecError).stderr = stderr;
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );

    // Safety: ensure child is cleaned up on abort
    child.unref?.();
  });
}

/** Truncate output to MAX_OUTPUT_BYTES, appending truncation marker if needed. */
function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_BYTES) return output;
  return output.slice(0, MAX_OUTPUT_BYTES) + '\n…[truncated]';
}
