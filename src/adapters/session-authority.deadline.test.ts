/**
 * @module adapters/session-authority.deadline.test
 * @description D3 (#1031): the canonical session authority must bound its
 * sequential git probes with one monotone deadline budget instead of two
 * independent 5s timeouts, and a timed-out remote probe must not silently fall
 * back to the local-path fingerprint.
 *
 * Deterministic reproduction: `git` is mocked to delay/hang and fake timers
 * advance the budget; the real `resolveSessionAuthority` pipeline runs.
 *
 * @test-policy HAPPY, BAD, EDGE
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gitMock = vi.hoisted(() => vi.fn());

vi.mock('./git-command.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-command.js')>();
  return { ...actual, git: (...args: unknown[]) => gitMock(...args) };
});

import { GitError } from './git-command.js';
import { resolveSessionAuthority } from './session-authority.js';

const REPO = '/canonical/worktree';
const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const DEADLINE_MS = 4_000;

function delayed<T>(ms: number, settle: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(settle());
      } catch (err) {
        reject(err);
      }
    }, ms);
  });
}

/** rev-parse resolves after `revParseDelayMs`; every other probe hangs until its timeout. */
function mockSequentialProbes(revParseDelayMs: number): void {
  gitMock.mockImplementation((_cwd: string, args: string[], timeoutMs = 5_000) => {
    if (args[0] === 'rev-parse') {
      return delayed(revParseDelayMs, () => `${REPO}\n`);
    }
    return delayed(timeoutMs, () => {
      throw new GitError('GIT_TIMEOUT', `git ${args[0]} timed out after ${timeoutMs}ms`);
    });
  });
}

async function settleWithin(
  promise: Promise<unknown>,
  advanceMs: number,
): Promise<{ settled: boolean; value?: unknown }> {
  const state: { settled: boolean; value?: unknown } = { settled: false };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  await vi.advanceTimersByTimeAsync(advanceMs);
  return state;
}

describe('resolveSessionAuthority git deadline budget (D3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    gitMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('BAD: bounds the combined sequential probes within one deadline budget', async () => {
    // First probe consumes 3s; the second probe hangs.
    mockSequentialProbes(3_000);

    const result = await settleWithin(
      resolveSessionAuthority({
        root: REPO,
        sessionId: SESSION_ID,
        deadlineMs: DEADLINE_MS,
      }),
      DEADLINE_MS + 200,
    );

    expect(result.settled).toBe(true);
    expect(result.value).toMatchObject({ status: 'unavailable', code: 'GIT_TIMEOUT' });
  });

  it('EDGE: never starts a second probe after the budget is exhausted', async () => {
    // First probe consumes the entire budget.
    mockSequentialProbes(DEADLINE_MS);

    const result = await settleWithin(
      resolveSessionAuthority({
        root: REPO,
        sessionId: SESSION_ID,
        deadlineMs: DEADLINE_MS,
      }),
      DEADLINE_MS + 200,
    );

    expect(result.settled).toBe(true);
    expect(result.value).toMatchObject({ status: 'unavailable', code: 'GIT_TIMEOUT' });
    // No `remote get-url origin` probe may start once the budget is spent.
    const probeArgs = gitMock.mock.calls.map((call) => (call[1] as string[]).join(' '));
    expect(probeArgs.some((args) => args.startsWith('remote '))).toBe(false);
  });

  it('EDGE: an exactly exhausted budget (remaining === 0) fails closed before the second probe', async () => {
    // now(): [deadline init, first probe timeout, post-root check] = 0,
    // then exactly the deadline for the second probe timeout.
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(DEADLINE_MS);
    gitMock.mockImplementation((_cwd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return Promise.resolve(`${REPO}\n`);
      return Promise.resolve('https://example.com/repo.git\n');
    });

    const result = await resolveSessionAuthority({
      root: REPO,
      sessionId: SESSION_ID,
      deadlineMs: DEADLINE_MS,
    });

    expect(result).toMatchObject({ status: 'unavailable', code: 'GIT_TIMEOUT' });
    const probeArgs = gitMock.mock.calls.map((call) => (call[1] as string[]).join(' '));
    expect(probeArgs.some((args) => args.startsWith('remote '))).toBe(false);
    nowSpy.mockRestore();
  });

  it('BAD: a probe result accepted exactly at the deadline is still rejected', async () => {
    // now(): [init, first timeout, post-root check, second timeout] = 0, then
    // exactly the deadline for the post-fingerprint check.
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(DEADLINE_MS);
    gitMock.mockImplementation((_cwd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return Promise.resolve(`${REPO}\n`);
      return Promise.resolve('https://example.com/repo.git\n');
    });

    const result = await resolveSessionAuthority({
      root: REPO,
      sessionId: SESSION_ID,
      deadlineMs: DEADLINE_MS,
    });

    expect(result).toMatchObject({ status: 'unavailable', code: 'GIT_TIMEOUT' });
    nowSpy.mockRestore();
  });

  it('BAD: a timed-out remote probe propagates instead of the local-path fallback', async () => {
    // rev-parse is instant; the origin probe hangs until the budget expires.
    mockSequentialProbes(0);

    const result = await settleWithin(
      resolveSessionAuthority({
        root: REPO,
        sessionId: SESSION_ID,
        deadlineMs: DEADLINE_MS,
      }),
      DEADLINE_MS + 200,
    );

    expect(result.settled).toBe(true);
    expect(result.value).toMatchObject({ status: 'unavailable', code: 'GIT_TIMEOUT' });
  });

  it('BAD: rejects a probe result that settles successfully after the deadline', async () => {
    // rev-parse consumes 3s; the remote-origin probe resolves successfully at
    // 4.2s — after the 4s budget. The late fingerprint must not be accepted.
    gitMock.mockImplementation((_cwd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return delayed(3_000, () => `${REPO}\n`);
      return delayed(1_200, () => 'https://example.com/repo.git\n');
    });

    const result = await settleWithin(
      resolveSessionAuthority({
        root: REPO,
        sessionId: SESSION_ID,
        deadlineMs: DEADLINE_MS,
      }),
      DEADLINE_MS + 500,
    );

    expect(result.settled).toBe(true);
    expect(result.value).toMatchObject({ status: 'unavailable', code: 'GIT_TIMEOUT' });
  });

  it('EDGE: probes never receive a zero timeout', async () => {
    mockSequentialProbes(DEADLINE_MS - 1);

    await settleWithin(
      resolveSessionAuthority({
        root: REPO,
        sessionId: SESSION_ID,
        deadlineMs: DEADLINE_MS,
      }),
      DEADLINE_MS + 200,
    );

    const explicitTimeouts = gitMock.mock.calls
      .map((call) => call[2] as number | undefined)
      .filter((timeout): timeout is number => timeout !== undefined);
    for (const timeout of explicitTimeouts) {
      expect(timeout).toBeGreaterThan(0);
    }
  });
});
