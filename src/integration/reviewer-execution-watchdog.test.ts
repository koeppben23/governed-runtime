/**
 * @module integration/reviewer-execution-watchdog.test
 * @description Bounded reviewer deadlines are enforced against the exact child
 * and never downgrade an unconfirmed host outcome to success.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewerExecutionWatchdog } from './reviewer-execution-watchdog.js';
import type { OrchestratorClient, ReviewerExecutionFailure } from './review/types.js';

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
  const value: OrchestratorClient = {
    app: { agents: async () => ({ data: [] }) },
    session: {
      abort: vi.fn(async () => ({ data: true })),
      get: vi.fn(async () => ({ data: { id: 'child', parentID: 'parent' } })),
      prompt: vi.fn(async () => ({ data: {} })),
      status: vi.fn(async () => ({ data: { child: { type: 'idle' } } })),
      messages: vi.fn(async (opts: { path: { id: string } }) => ({
        data:
          opts.path.id === 'parent'
            ? [
                {
                  info: { role: 'assistant' },
                  parts: taskCallIds.map((callID) => ({
                    id: `part-${callID}`,
                    type: 'tool',
                    tool: 'task',
                    callID,
                    state: { status: 'completed', metadata: { sessionId: 'child' } },
                  })),
                },
              ]
            : terminal
              ? [
                  {
                    info: { role: 'assistant', finish: 'stop' },
                    parts: runningTool
                      ? [{ type: 'tool', state: { status: 'running' } }]
                      : [{ type: 'text', text: 'done' }],
                  },
                ]
              : [],
      })),
    },
  };
  return value;
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
    h.c.session.abort = vi.fn(async () => new Promise<never>(() => {}));
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
    expect(h.c.session.abort).toHaveBeenCalledTimes(1);
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
    expect(c.session.abort).toHaveBeenCalledWith({ path: { id: 'child' } });
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
    expect(c.session.abort).toHaveBeenCalledTimes(1);
    const fresh = harness();
    await fresh.watchdog.onReviewerRequest('child');
    fresh.watchdog.onToolStart('child', 'call-2');
    fresh.watchdog.onToolEnd('child', 'call-2');
    await vi.advanceTimersByTimeAsync(20);
    expect(fresh.c.session.abort).not.toHaveBeenCalled();
  });

  it('enforces the serialization budget inside the absolute deadline', async () => {
    vi.useFakeTimers();
    const { c, watchdog } = harness();
    await watchdog.onReviewerRequest('child');
    watchdog.onSerializationStart('child');
    await vi.advanceTimersByTimeAsync(25);
    expect(c.session.abort).toHaveBeenCalledWith({ path: { id: 'child' } });
  });

  it('normal completion clears all timers and does not abort', async () => {
    vi.useFakeTimers();
    const { c, watchdog } = harness();
    await watchdog.onReviewerRequest('child');
    watchdog.onSerializationStart('child');
    watchdog.complete('child');
    await vi.advanceTimersByTimeAsync(500);
    expect(c.session.abort).not.toHaveBeenCalled();
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
    expect(c.session.abort).toHaveBeenCalledWith({ path: { id: 'child' } });
  });

  it('a second reviewer request does not reset the absolute deadline', async () => {
    vi.useFakeTimers();
    const { c, watchdog } = harness();
    await watchdog.onReviewerRequest('child');
    await vi.advanceTimersByTimeAsync(70);
    await watchdog.onReviewerRequest('child');
    await vi.advanceTimersByTimeAsync(50);
    expect(c.session.abort).toHaveBeenCalledTimes(1);
  });

  it('does not assign a child arbitrarily when two task calls match the parent', async () => {
    vi.useFakeTimers();
    const { c, watchdog, persistFailure } = harness({
      taskCallIds: ['call-1', 'call-2'],
    });
    watchdog.onTaskAuthorized('parent', 'call-2');
    await watchdog.onReviewerRequest('child');
    expect(c.session.abort).not.toHaveBeenCalled();
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

  it('falls back to session.list when session.get has no parent yet', async () => {
    vi.useFakeTimers();
    const c = client();
    c.session.get = vi.fn(async () => ({ data: { id: 'child' } }));
    c.session.list = vi.fn(async () => ({ data: [{ id: 'child', parentID: 'parent' }] }));
    const watchdog = new ReviewerExecutionWatchdog({
      config,
      client: c,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      persistFailure: vi.fn(async () => true),
    });
    watchdog.onTaskAuthorized('parent', 'call-1');
    await watchdog.onReviewerRequest('child');
    await vi.advanceTimersByTimeAsync(80);
    expect(c.session.abort).toHaveBeenCalledWith({ path: { id: 'child' } });
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

  it('preserves SDK session method receiver context', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const session = {
      _client: {},
      async get(this: { _client: unknown }, opts: { path: { id: string } }) {
        if (!this._client) throw new Error('lost session receiver');
        return { data: { id: opts.path.id, parentID: 'parent' } };
      },
      async list(this: { _client: unknown }) {
        if (!this._client) throw new Error('lost session receiver');
        return { data: [] };
      },
      async messages(this: { _client: unknown }, opts: { path: { id: string } }) {
        if (!this._client) throw new Error('lost session receiver');
        return {
          data:
            opts.path.id === 'parent'
              ? [
                  {
                    info: { role: 'assistant' },
                    parts: [
                      {
                        id: 'part-1',
                        callID: 'call-1',
                        type: 'tool',
                        tool: 'task',
                        state: { status: 'completed', metadata: { sessionId: 'child' } },
                      },
                    ],
                  },
                ]
              : [
                  {
                    info: { role: 'assistant', finish: 'stop' },
                    parts: [{ type: 'text', text: 'done' }],
                  },
                ],
        };
      },
      async status(this: { _client: unknown }) {
        if (!this._client) throw new Error('lost session receiver');
        return { data: { child: { type: 'idle' } } };
      },
      async abort(this: { _client: unknown }) {
        if (!this._client) throw new Error('lost session receiver');
        aborted = true;
        return { data: true };
      },
    };
    const c = {
      app: { agents: async () => ({ data: [] }) },
      session,
    } as unknown as OrchestratorClient;
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
