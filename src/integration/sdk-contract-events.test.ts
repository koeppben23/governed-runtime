/** Pinned native V2 event union -> notification projection -> application handler.
 * Notifications are not operator, completion or reviewer-capture evidence. */
import { describe, expect, it, vi } from 'vitest';
import type { OpenCodeEvent } from '@opencode/client';
import { handleEvent, type EventHandlerDeps } from './plugin-events.js';
import { projectOpenCodeEvent } from './opencode-host-adapter.js';

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
