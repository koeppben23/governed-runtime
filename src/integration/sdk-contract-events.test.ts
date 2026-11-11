/** Pinned native V2 event union -> notification projection -> application handler.
 * Notifications are not operator, completion or reviewer-capture evidence. */
import { describe, expect, it, vi } from 'vitest';
import type { OpenCodeEvent } from '@opencode/client';
import { handleEvent, type EventHandlerDeps } from './plugin-events.js';
import { OpenCodeHostAdapter, projectOpenCodeEvent } from './opencode-host-adapter.js';
import { createV2Host } from './opencode-v2-test-helpers.js';

type Deleted = Extract<OpenCodeEvent, { type: 'session.deleted' }>;
type Failed = Extract<OpenCodeEvent, { type: 'session.execution.failed' }>;
type StructuredError = Failed['data']['error'];
type AssertExtends<T extends U, U> = T;
type _deleted = AssertExtends<Deleted['data']['sessionID'], string>;
type _error = AssertExtends<StructuredError, { type: string; message: string }>;
const envelope = { created: 1, durable: { aggregateID: 'session', seq: 1, version: 1 as const } };

function deps(): EventHandlerDeps {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    cleanupSession: vi.fn(),
    resumePendingSystemWork: vi.fn(async () => {}),
    observeMutationEvent: vi.fn(async () => {}),
    emitSessionErrorAudit: vi.fn(async () => {}),
  };
}

describe('native V2 event contract', () => {
  it.each([undefined, null, '100', NaN, Infinity])(
    'ignores a success without a finite projected creation time: %j',
    async (created) => {
      const d = deps();
      await handleEvent(d, {
        type: 'session.execution.succeeded',
        data: { sessionID: 'session', hostCreatedAt: created },
      });
      expect(d.resumePendingSystemWork).not.toHaveBeenCalled();
    },
  );
  it('preserves native success as a distinct timestamped wakeup, not idle or evidence', async () => {
    const event = {
      ...envelope,
      type: 'session.execution.succeeded',
      id: 'success',
      data: { sessionID: 'session' },
    } satisfies Extract<OpenCodeEvent, { type: 'session.execution.succeeded' }>;
    const d = deps();
    const projected = projectOpenCodeEvent(event)!;
    expect(projected.event.type).toBe(event.type);
    await handleEvent(d, projected.event);
    expect(d.resumePendingSystemWork).toHaveBeenCalledExactlyOnceWith('session', event.created);
    expect(d.observeMutationEvent).not.toHaveBeenCalled();
    expect(d.emitSessionErrorAudit).not.toHaveBeenCalled();
  });
  it('cleans the exact data.sessionID from session.deleted', async () => {
    const event = {
      ...envelope,
      durable: { ...envelope.durable, version: 2 as const },
      type: 'session.deleted',
      id: 'deleted',
      data: { sessionID: 'session' },
    } satisfies Deleted;
    const projected = projectOpenCodeEvent(event)!;
    const d = deps();
    await handleEvent(d, projected.event);
    expect(projected.sessionId).toBe('session');
    expect(d.cleanupSession).toHaveBeenCalledExactlyOnceWith('session');
    expect(d.log.info).toHaveBeenCalledWith('event', 'session cleanup completed', {
      sessionId: 'session',
    });
  });

  it.each([
    { type: 'unknown', message: 'boom' },
    { type: 'provider', message: 'auth failed', status: 401 },
    { type: 'provider', message: 'rate limited', status: 429, retryAfterMs: 1000 },
    { type: 'aborted', message: 'aborted' },
  ] satisfies StructuredError[])(
    'preserves the native structured error discriminant: %j',
    async (error) => {
      const event = {
        ...envelope,
        type: 'session.execution.failed',
        id: 'failure',
        data: { sessionID: 'session', error },
      } satisfies Failed;
      const d = deps();
      await handleEvent(d, projectOpenCodeEvent(event)!.event);
      expect(d.emitSessionErrorAudit).toHaveBeenCalledWith('session', error.message, {
        eventType: event.type,
        errorType: error.type,
        supplementary: { hostEventId: event.id },
      });
      expect(d.cleanupSession).not.toHaveBeenCalled();
    },
  );

  it('routes tool failure as a history-read wakeup, not a completion or session error', async () => {
    const d = deps();
    // Required payload is tied to the installed generated declaration.
    const event = {
      ...envelope,
      durable: { ...envelope.durable, version: 2 as const },
      type: 'session.tool.failed',
      id: 'failure',
      data: {
        sessionID: 'session',
        assistantMessageID: 'message',
        id: 'call',
        executed: false,
        error: { type: 'tool', message: 'failed' },
      },
    } satisfies Extract<OpenCodeEvent, { type: 'session.tool.failed' }>;
    const projected = projectOpenCodeEvent(event)!;
    await handleEvent(d, projected.event);
    expect(d.observeMutationEvent).toHaveBeenCalledExactlyOnceWith(projected.event);
    expect(d.emitSessionErrorAudit).not.toHaveBeenCalled();
    expect(d.resumePendingSystemWork).not.toHaveBeenCalled();
  });

  it('routes idle only to canonical pending system work', async () => {
    const event = {
      created: 1,
      type: 'session.idle',
      id: 'idle',
      data: { sessionID: 'session' },
    } satisfies Extract<OpenCodeEvent, { type: 'session.idle' }>;
    const d = deps();
    await handleEvent(d, projectOpenCodeEvent(event)!.event);
    expect(d.resumePendingSystemWork).toHaveBeenCalledExactlyOnceWith('session');
    expect(d.observeMutationEvent).not.toHaveBeenCalled();
    expect(d.emitSessionErrorAudit).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'session.delete', data: { sessionID: 'session' } },
    { type: 'session.deleted', properties: { info: { id: 'session' } } },
    { type: 'session.deleted', data: {} },
    {
      type: 'session.error',
      properties: {
        sessionID: 'session',
        error: { name: 'APIError', data: { message: 'old envelope' } },
      },
    },
  ])('never accepts removed event names or identity envelopes: %j', async (event) => {
    const d = deps();
    await handleEvent(d, event);
    expect(d.cleanupSession).not.toHaveBeenCalled();
    expect(d.emitSessionErrorAudit).not.toHaveBeenCalled();
    expect(d.resumePendingSystemWork).not.toHaveBeenCalled();
  });

  it('does not interpret an obsolete error envelope as native structured diagnostics', async () => {
    const d = deps();
    await handleEvent(d, {
      type: 'session.execution.failed',
      data: {
        sessionID: 'session',
        error: { name: 'APIError', data: { message: 'not authority' } },
      },
    });
    expect(d.emitSessionErrorAudit).toHaveBeenCalledWith('session', 'unspecified session error', {
      eventType: 'session.execution.failed',
    });
  });
});

describe('native successful-execution wakeup admission', () => {
  const success = {
    ...envelope,
    created: 100,
    type: 'session.execution.succeeded',
    id: 'success',
    data: { sessionID: 'session' },
  } satisfies Extract<OpenCodeEvent, { type: 'session.execution.succeeded' }>;
  function fixture() {
    const host = createV2Host('/worktree');
    host.sessionGet.mockResolvedValue({
      id: 'session',
      location: { directory: '/worktree' },
      outcome: 'succeeded',
      time: { busy: 90, idle: 100 },
    });
    return { host, adapter: new OpenCodeHostAdapter(host.ctx, new AbortController().signal) };
  }
  it('accepts a terminal execution whose start and end share the same clock tick', async () => {
    const { host, adapter } = fixture();
    host.sessionGet.mockResolvedValue({
      id: 'session',
      location: { directory: '/worktree' },
      outcome: 'succeeded',
      time: { busy: 100, idle: 100 },
    });
    expect(await adapter.claimSuccessfulExecutionWakeup(success)).toBe(true);
  });
  it('claims one exact terminal execution, including concurrent duplicates and later replay', async () => {
    const { host, adapter } = fixture();
    expect(
      await Promise.all([
        adapter.claimSuccessfulExecutionWakeup(success),
        adapter.claimSuccessfulExecutionWakeup(success),
      ]),
    ).toEqual([true, false]);
    expect(
      await adapter.claimSuccessfulExecutionWakeup({ ...success, id: 'different-envelope-id' }),
    ).toBe(false);
    expect(host.sessionGet).toHaveBeenCalledTimes(1);
    host.sessionGet.mockResolvedValue({
      id: 'session',
      location: { directory: '/worktree' },
      outcome: 'succeeded',
      time: { busy: 110, idle: 120 },
    });
    expect(
      await adapter.claimSuccessfulExecutionWakeup({
        ...success,
        created: 120,
        durable: { ...success.durable, seq: 2 },
      }),
    ).toBe(true);
    expect(await adapter.claimSuccessfulExecutionWakeup(success)).toBe(false);
  });
  it.each([
    { outcome: 'failed' as const, time: { busy: 90, idle: 100 } },
    { outcome: 'interrupted' as const, time: { busy: 90, idle: 100 } },
    { outcome: 'succeeded' as const, time: { busy: 101, idle: 100 } },
    { outcome: 'succeeded' as const, time: { busy: 90, idle: 99 } },
    { outcome: 'succeeded' as const, time: { busy: 90, idle: 110 } },
    { outcome: 'succeeded' as const, time: { idle: 100 } },
    { outcome: 'succeeded' as const, time: { busy: 90 } },
    { time: { busy: 90, idle: 100 } },
  ])('rejects stale, running or non-successful native state: %j', async (state) => {
    const { host, adapter } = fixture();
    host.sessionGet.mockResolvedValue({
      id: 'session',
      location: { directory: '/worktree' },
      ...state,
    });
    expect(await adapter.claimSuccessfulExecutionWakeup(success)).toBe(false);
    expect(await adapter.claimSuccessfulExecutionWakeup(success)).toBe(false);
    expect(host.sessionGet).toHaveBeenCalledTimes(1);
  });
  it('rejects foreign aggregate identity without a read', async () => {
    const { host, adapter } = fixture();
    expect(
      await adapter.claimSuccessfulExecutionWakeup({
        ...success,
        durable: { ...success.durable, aggregateID: 'foreign' },
      }),
    ).toBe(false);
    expect(host.sessionGet).not.toHaveBeenCalled();
  });
  it('propagates lookup failure and exact-session mismatch rather than waking another session', async () => {
    const { host, adapter } = fixture();
    const error = new Error('native lookup failed');
    host.sessionGet.mockRejectedValueOnce(error);
    await expect(adapter.claimSuccessfulExecutionWakeup(success)).rejects.toBe(error);
    host.sessionGet.mockResolvedValue({ id: 'foreign', location: { directory: '/worktree' } });
    await expect(
      adapter.claimSuccessfulExecutionWakeup({
        ...success,
        durable: { ...success.durable, seq: 2 },
      }),
    ).rejects.toHaveProperty('code', 'HOST_ADAPTER_INIT_FAILED');
  });
  it('forgets disposed session metadata', async () => {
    const { adapter } = fixture();
    expect(await adapter.claimSuccessfulExecutionWakeup(success)).toBe(true);
    adapter.forgetSession('session');
    expect(await adapter.claimSuccessfulExecutionWakeup(success)).toBe(true);
  });
});
