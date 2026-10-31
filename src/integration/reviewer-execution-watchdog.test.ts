/**
 * @module integration/reviewer-execution-watchdog.test
 * @description Bounded reviewer deadlines are enforced against the exact child
 * and never downgrade an unconfirmed host outcome to success.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewerExecutionWatchdog } from './reviewer-execution-watchdog.js';
import type { OrchestratorClient, ReviewerExecutionFailure } from './review/types.js';
import { createReviewClient } from './opencode-v2-test-helpers.js';

const config = {
  toolTimeoutMs: 20,
  reviewTimeoutMs: 80,
  serializationTimeoutMs: 25,
  executionTimeoutMs: 120,
};

function client(
  terminal = true,
  taskCallIds: string[] = ['call-1'],
  runningTool = false,
): OrchestratorClient {
  return createReviewClient({
    interrupt: vi.fn(async () => true),
    getSession: vi.fn(async (sessionId) => ({
      sessionId,
      parentSessionId: 'parent',
      directory: '/worktree',
    })),
    quiescence: vi.fn(async () => 'idle' as const),
    reviewerCall: vi.fn(async () => (taskCallIds.length === 1 ? taskCallIds[0]! : null)),
    readHistory: vi.fn(async () =>
      terminal
        ? [
            {
              info: { role: 'assistant', finish: 'stop' },
              parts: runningTool
                ? [{ type: 'tool', state: { status: 'running' } }]
                : [{ type: 'text', text: 'done' }],
            },
          ]
        : [],
    ),
  });
}

function harness(
  overrides: {
    terminal?: boolean;
    persist?: boolean;
    runningTool?: boolean;
    taskCallIds?: string[];
  } = {},
) {
  const failures = new Map<string, ReviewerExecutionFailure>();
  const c = client(overrides.terminal ?? true, overrides.taskCallIds, overrides.runningTool);
  const persistFailure = vi.fn(async () => overrides.persist ?? true);
  const watchdog = new ReviewerExecutionWatchdog({
    config,
    client: c,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    persistFailure,
    failures,
  });
  watchdog.onTaskAuthorized('parent', 'call-1');
  return { c, watchdog, persistFailure, failures };
}

afterEach(() => vi.useRealTimers());

describe('reviewer execution watchdog', () => {
  it('bounds a hanging abort and persists unknown instead of losing monitoring', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.c.interrupt = vi.fn(async () => new Promise<never>(() => {}));
    await h.watchdog.onReviewerRequest('child');
    await vi.advanceTimersByTimeAsync(80);
    expect(h.failures.get('child')?.code).toBe('REVIEWER_EXECUTION_OUTCOME_UNKNOWN');
    expect(h.persistFailure).not.toHaveBeenCalled();
    expect(h.watchdog.finishTask({ callId: 'call-1', parentSessionId: 'parent' })).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.persistFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
        abortConfirmed: false,
      }),
      { parentSessionId: 'parent', callId: 'call-1', childSessionId: 'child' },
    );
    expect(h.c.interrupt).toHaveBeenCalledTimes(1);
  });

  it('retries failed durable closure and retains the synchronous binding fence', async () => {
    vi.useFakeTimers();
    const h = harness({ persist: false });
    await h.watchdog.onReviewerRequest('child');
    await vi.advanceTimersByTimeAsync(80);
    expect(h.persistFailure).toHaveBeenCalledTimes(1);
    expect(h.failures.has('child')).toBe(true);
    h.persistFailure.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.persistFailure).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.persistFailure).toHaveBeenCalledTimes(2);
  });

  it('never cleans up an unrelated task when both call and child identities are absent', async () => {
    vi.useFakeTimers();
    const h = harness();
    expect(h.watchdog.finishTask({ parentSessionId: 'parent' })).toBe(false);
    await vi.advanceTimersByTimeAsync(120);
    expect(h.persistFailure).toHaveBeenCalledTimes(1);
  });
  it('aborts and persists a confirmed review timeout', async () => {
    vi.useFakeTimers();
    const { c, watchdog, persistFailure } = harness();
    await watchdog.onReviewerRequest('child');
    await vi.advanceTimersByTimeAsync(80);
    expect(c.interrupt).toHaveBeenCalledWith('child');
    expect(persistFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'REVIEWER_EXECUTION_TIMEOUT',
        phase: 'review',
        abortConfirmed: true,
      }),
      { parentSessionId: 'parent', callId: 'call-1', childSessionId: 'child' },
    );
  });

  it('does not turn an unconfirmed host outcome into a timeout success', async () => {
    vi.useFakeTimers();
    const { watchdog, persistFailure, failures } = harness({ terminal: false, persist: false });
    await watchdog.onReviewerRequest('child');
    await vi.advanceTimersByTimeAsync(80);
    expect(persistFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
        abortConfirmed: false,
      }),
      { parentSessionId: 'parent', callId: 'call-1', childSessionId: 'child' },
    );
    expect(failures.get('child')).toMatchObject({ code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN' });
  });

  it('uses the tool deadline and clears it on tool completion', async () => {
    vi.useFakeTimers();
    const { c, watchdog } = harness();
    await watchdog.onReviewerRequest('child');
    watchdog.onToolStart('child', 'call-1');
    await vi.advanceTimersByTimeAsync(20);
    expect(c.interrupt).toHaveBeenCalledTimes(1);
    const fresh = harness();
    await fresh.watchdog.onReviewerRequest('child');
    fresh.watchdog.onToolStart('child', 'call-2');
    fresh.watchdog.onToolEnd('child', 'call-2');
    await vi.advanceTimersByTimeAsync(20);
    expect(fresh.c.interrupt).not.toHaveBeenCalled();
  });

  it('enforces the serialization budget inside the absolute deadline', async () => {
    vi.useFakeTimers();
    const { c, watchdog } = harness();
    await watchdog.onReviewerRequest('child');
    watchdog.onSerializationStart('child');
    await vi.advanceTimersByTimeAsync(25);
    expect(c.interrupt).toHaveBeenCalledWith('child');
  });

  it('normal completion clears all timers and does not abort', async () => {
    vi.useFakeTimers();
    const { c, watchdog } = harness();
    await watchdog.onReviewerRequest('child');
    watchdog.onSerializationStart('child');
    watchdog.complete('child');
    await vi.advanceTimersByTimeAsync(500);
    expect(c.interrupt).not.toHaveBeenCalled();
  });

  it('starts the absolute deadline at dispatch and persists unknown before a child is observed', async () => {
    vi.useFakeTimers();
    const failures = new Map<string, ReviewerExecutionFailure>();
    const persistTaskFailure = vi.fn(async () => true);
    const watchdog = new ReviewerExecutionWatchdog({
      config,
      client: client(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      persistFailure: persistTaskFailure,
      failures,
    });
    watchdog.onTaskAuthorized('parent', 'call-1');
    await vi.advanceTimersByTimeAsync(120);
    expect(persistTaskFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN', phase: 'total' }),
      { parentSessionId: 'parent', callId: 'call-1' },
    );
  });

  it('attaches the child to the dispatch deadline without resetting it', async () => {
    vi.useFakeTimers();
    const failures = new Map<string, ReviewerExecutionFailure>();
    const c = client();
    const watchdog = new ReviewerExecutionWatchdog({
      config,
      client: c,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      persistFailure: vi.fn(async () => true),
      failures,
    });
    watchdog.onTaskAuthorized('parent', 'call-1');
    await vi.advanceTimersByTimeAsync(100);
    await watchdog.onReviewerRequest('child');
    await vi.advanceTimersByTimeAsync(20);
    expect(c.interrupt).toHaveBeenCalledWith('child');
  });

  it('a second reviewer request does not reset the absolute deadline', async () => {
    vi.useFakeTimers();
    const { c, watchdog } = harness();
    await watchdog.onReviewerRequest('child');
    await vi.advanceTimersByTimeAsync(70);
    await watchdog.onReviewerRequest('child');
    await vi.advanceTimersByTimeAsync(50);
    expect(c.interrupt).toHaveBeenCalledTimes(1);
  });

  it('does not assign a child arbitrarily when two task calls match the parent', async () => {
    vi.useFakeTimers();
    const { c, watchdog, persistFailure } = harness({
      taskCallIds: ['call-1', 'call-2'],
    });
    watchdog.onTaskAuthorized('parent', 'call-2');
    await watchdog.onReviewerRequest('child');
    expect(c.interrupt).not.toHaveBeenCalled();
    expect(persistFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120);
    expect(persistFailure).toHaveBeenCalledTimes(2);
  });

  it('never confirms quiescence while any observed tool is still running', async () => {
    vi.useFakeTimers();
    const { watchdog, persistFailure } = harness({ runningTool: true });
    await watchdog.onReviewerRequest('child');
    await vi.advanceTimersByTimeAsync(80);
    expect(persistFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
        abortConfirmed: false,
      }),
      { parentSessionId: 'parent', callId: 'call-1', childSessionId: 'child' },
    );
  });

  it.each(['busy', 'unknown'] as const)(
    'never treats %s quiescence as confirmed termination despite terminal-looking history',
    async (state) => {
      vi.useFakeTimers();
      const { c, watchdog, persistFailure } = harness();
      c.quiescence = vi.fn(async () => state);
      await watchdog.onReviewerRequest('child');
      await vi.advanceTimersByTimeAsync(80);
      expect(persistFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
          abortConfirmed: false,
        }),
        { parentSessionId: 'parent', callId: 'call-1', childSessionId: 'child' },
      );
    },
  );

  it('does not accept a single pending task as a substitute for an unproved release mapping', async () => {
    vi.useFakeTimers();
    const { c, watchdog, persistFailure } = harness();
    c.reviewerCall = vi.fn().mockRejectedValue(new Error('V2 proof unavailable'));
    await watchdog.onReviewerRequest('child');
    expect(c.interrupt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120);
    expect(persistFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
        abortConfirmed: false,
      }),
      { parentSessionId: 'parent', callId: 'call-1' },
    );
  });

  it('does not attach a foreign session returned by an exact lookup', async () => {
    vi.useFakeTimers();
    const { c, watchdog } = harness();
    c.getSession = vi.fn(async () => ({
      sessionId: 'foreign',
      parentSessionId: 'parent',
      directory: '/worktree',
    }));
    await watchdog.onReviewerRequest('child');
    expect(c.reviewerCall).not.toHaveBeenCalled();
    expect(c.interrupt).not.toHaveBeenCalled();
  });

  it('clears the dispatch timer when the native Task completes without child attachment', async () => {
    vi.useFakeTimers();
    const failures = new Map<string, ReviewerExecutionFailure>();
    const persistTaskFailure = vi.fn(async () => true);
    const watchdog = new ReviewerExecutionWatchdog({
      config,
      client: client(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      persistFailure: persistTaskFailure,
      failures,
    });
    watchdog.onTaskAuthorized('parent', 'call-1');
    watchdog.completeTask('call-1');
    await vi.advanceTimersByTimeAsync(600);
    expect(persistTaskFailure).not.toHaveBeenCalled();
  });

  it('does not attach or interrupt a child when exact metadata has no parent', async () => {
    vi.useFakeTimers();
    const c = client();
    c.getSession = vi.fn(async () => ({ sessionId: 'child', directory: '/worktree' }));
    const persistFailure = vi.fn(async () => true);
    const watchdog = new ReviewerExecutionWatchdog({
      config,
      client: c,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      persistFailure,
    });
    watchdog.onTaskAuthorized('parent', 'call-1');
    await watchdog.onReviewerRequest('child');
    await vi.advanceTimersByTimeAsync(80);
    expect(c.interrupt).not.toHaveBeenCalled();
    expect(c.reviewerCall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40);
    expect(persistFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
        abortConfirmed: false,
      }),
      { parentSessionId: 'parent', callId: 'call-1' },
    );
  });

  it('retains a foreign unbound task when no exact completion identity matches', async () => {
    vi.useFakeTimers();
    const failures = new Map<string, ReviewerExecutionFailure>();
    const persistTaskFailure = vi.fn(async () => true);
    const watchdog = new ReviewerExecutionWatchdog({
      config,
      client: client(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      persistFailure: persistTaskFailure,
      failures,
    });
    watchdog.onTaskAuthorized('parent', 'before-hook-id');
    expect(
      watchdog.finishTask({
        callId: 'foreign-call',
        parentSessionId: 'parent',
        childSessionId: 'foreign-child',
      }),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(persistTaskFailure).toHaveBeenCalledTimes(1);
  });

  it('does not clear another pending parent task after an exact Task completion', async () => {
    vi.useFakeTimers();
    const failures = new Map<string, ReviewerExecutionFailure>();
    const persistTaskFailure = vi.fn(async () => true);
    const watchdog = new ReviewerExecutionWatchdog({
      config,
      client: client(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      persistFailure: persistTaskFailure,
      failures,
    });
    watchdog.onTaskAuthorized('parent', 'task-a');
    watchdog.onTaskAuthorized('parent', 'task-b');
    watchdog.finishTask({ callId: 'task-a', parentSessionId: 'parent' });
    await vi.advanceTimersByTimeAsync(600);
    expect(persistTaskFailure).toHaveBeenCalledTimes(1);
    expect(persistTaskFailure).toHaveBeenCalledWith(expect.anything(), {
      parentSessionId: 'parent',
      callId: 'task-b',
    });
  });

  it('preserves semantic host method receiver context', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const c = {
      ...client(),
      transport: 'host',
      async getSession(this: { transport: string }, sessionId: string) {
        if (this.transport !== 'host') throw new Error('lost host receiver');
        return { sessionId, parentSessionId: 'parent', directory: '/worktree' };
      },
      async interrupt(this: { transport: string }, sessionId: string) {
        if (this.transport !== 'host') throw new Error('lost host receiver');
        expect(sessionId).toBe('child');
        aborted = true;
        return true;
      },
    };
    const watchdog = new ReviewerExecutionWatchdog({
      config,
      client: c,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      persistFailure: vi.fn(async () => true),
    });
    watchdog.onTaskAuthorized('parent', 'call-1');
    await watchdog.onReviewerRequest('child');
    await vi.advanceTimersByTimeAsync(80);
    expect(aborted).toBe(true);
  });
});
