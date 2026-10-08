/**
 * @module hooks/pre-tool-use.deadline.test
 * @description D3 (#1031): the command PreToolUse hook must deliver a
 * host-observable protocol DENY when the session-authority git probes fail
 * with the typed deadline error, and it must do so well inside the advertised
 * 10s host window.
 *
 * The monotone 4s budget itself is pinned deterministically in
 * `adapters/session-authority.deadline.test.ts`; this test proves the real hook
 * and resolver wire the typed failure into a delivered DENY on stdout.
 *
 * @test-policy BAD, EDGE
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gitMock = vi.hoisted(() => vi.fn());

vi.mock('../adapters/git-command.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/git-command.js')>();
  return { ...actual, git: (...args: unknown[]) => gitMock(...args) };
});

vi.mock('./shared/stdin-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shared/stdin-reader.js')>();
  return {
    ...actual,
    readStdin: vi.fn().mockResolvedValue({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      session_id: 'sess_deadline',
      cwd: '/canonical/worktree',
    }),
  };
});

import { GitError } from '../adapters/git-command.js';

const REPO = '/canonical/worktree';
const HOST_WINDOW_MS = 10_000;

const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

describe('pre-tool-use git deadline delivery', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('BAD: delivers a protocol DENY when the authority probes fail with the deadline error', async () => {
    // The worktree probe succeeds; the remote-origin probe hangs until the
    // authority's budget rejects it with the typed deadline error.
    let failRemoteProbe: ((err: unknown) => void) | undefined;
    gitMock.mockImplementation((_cwd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return Promise.resolve(`${REPO}\n`);
      return new Promise<string>((_resolve, reject) => {
        failRemoteProbe = reject;
      });
    });

    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, encodingOrCallback, callback) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      if (done) done(null);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const startedAt = Date.now();
    const importPromise = import('./pre-tool-use.js');
    await vi.waitFor(() => expect(failRemoteProbe).toBeDefined());
    failRemoteProbe!(new GitError('GIT_TIMEOUT', 'Session authority deadline exceeded'));
    await importPromise;

    expect(stdout.trim()).not.toBe('');
    const output = JSON.parse(stdout) as {
      decision?: string;
      code?: string;
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('GIT_TIMEOUT');
    expect(Date.now() - startedAt).toBeLessThan(HOST_WINDOW_MS);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('BAD: delivers the complete DENY under a nearly exhausted git budget', async () => {
    let remoteTimeoutMs: number | undefined;
    gitMock.mockImplementation((_cwd: string, args: string[], timeoutMs = 5_000) => {
      if (args[0] === 'rev-parse') {
        // Real 3.8s delay consumes almost the whole 4s git budget.
        return new Promise<string>((resolve) => setTimeout(() => resolve(`${REPO}\n`), 3_800));
      }
      // The second probe hangs until exactly the small remaining timeout the
      // authority passed after the first probe consumed its share.
      remoteTimeoutMs = timeoutMs;
      return new Promise<string>((_resolve, reject) =>
        setTimeout(
          () =>
            reject(new GitError('GIT_TIMEOUT', `git ${args[0]} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      );
    });

    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, encodingOrCallback, callback) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      if (done) done(null);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const startedAt = performance.now();
    await import('./pre-tool-use.js');
    const hookElapsedMs = performance.now() - startedAt;

    // A complete protocol DENY was delivered on stdout.
    const output = JSON.parse(stdout) as {
      decision?: string;
      code?: string;
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('GIT_TIMEOUT');

    // The second probe only received the remainder of the 4s git budget.
    expect(remoteTimeoutMs).toBeDefined();
    expect(remoteTimeoutMs!).toBeGreaterThan(0);
    expect(remoteTimeoutMs!).toBeLessThanOrEqual(500);

    // Budget separation: git budget 4s, measured hook total, host window 10s.
    expect(hookElapsedMs).toBeGreaterThanOrEqual(3_800);
    expect(hookElapsedMs).toBeLessThan(HOST_WINDOW_MS);
    console.error(
      `[PERF] pre-tool-use start→complete DENY=${hookElapsedMs.toFixed(0)}ms ` +
        `(git budget 4000ms, host window ${HOST_WINDOW_MS}ms)`,
    );
    expect(process.exitCode ?? 0).toBe(0);
  }, 15_000);
});
