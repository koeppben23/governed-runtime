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

function client(terminal = true): OrchestratorClient {
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
                  parts: [
                    {
                      type: 'tool',
                      tool: 'task',
                      callID: 'call-1',
                      state: { status: 'completed', metadata: { sessionId: 'child' } },
                    },
                  ],
                },
              ]
            : terminal
              ? [
                  {
                    info: { role: 'assistant', finish: 'stop' },
                    parts: [{ type: 'text', text: 'done' }],
                  },
                ]
              : [],
      })),
    },
  };
  return value;
}

function harness(overrides: { terminal?: boolean; persist?: boolean } = {}) {
  const failures = new Map<string, ReviewerExecutionFailure>();
  const c = client(overrides.terminal ?? true);
  const persistFailure = vi.fn(async () => overrides.persist ?? true);
  const watchdog = new ReviewerExecutionWatchdog({
    config,
    client: c,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    persistFailure,
    failures,
  });
  return { c, watchdog, persistFailure, failures };
}

afterEach(() => vi.useRealTimers());

describe('reviewer execution watchdog', () => {
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
      'child',
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
      'child',
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
      persistFailure: vi.fn(async () => true),
      persistTaskFailure,
      failures,
    });
    watchdog.onTaskAuthorized('parent', 'call-1');
    await vi.advanceTimersByTimeAsync(120);
    expect(persistTaskFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN', phase: 'total' }),
      'parent',
      'call-1',
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
      persistTaskFailure: vi.fn(async () => true),
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
});
