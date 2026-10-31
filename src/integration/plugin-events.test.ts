/** Native V2 notifications: diagnostics, redaction, ordering and lifecycle wakeups, not completion proof. */
import { describe, it, expect, vi } from 'vitest';
import { handleEvent, type EventHandlerDeps, type PluginEvent } from './plugin-events.js';

function deps(): EventHandlerDeps {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    cleanupSession: vi.fn(),
    observeMutationEvent: vi.fn(async () => {}),
    resumePendingSystemWork: vi.fn(async () => {}),
    emitSessionErrorAudit: vi.fn(async () => {}),
  };
}

function failure(data: Record<string, unknown> = {}): PluginEvent {
  return {
    type: 'session.execution.failed',
    data: {
      sessionID: 'session',
      error: { type: 'provider', message: 'failed' },
      ...data,
    },
  };
}

describe('native V2 event dispatch', () => {
  it('logs native structured failure before emitting the same sanitized audit detail', async () => {
    const d = deps();
    await handleEvent(d, failure());
    expect(d.log.error).toHaveBeenCalledWith('event', 'session error received', {
      sessionId: 'session',
      error: 'failed',
      eventType: 'session.execution.failed',
      errorType: 'provider',
    });
    expect(d.emitSessionErrorAudit).toHaveBeenCalledWith('session', 'failed', {
      eventType: 'session.execution.failed',
      errorType: 'provider',
    });
    expect(vi.mocked(d.log.error).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(d.emitSessionErrorAudit).mock.invocationCallOrder[0]!,
    );
  });

  it('cleans exactly the native deleted session, without error-audit emission', async () => {
    const d = deps();
    await handleEvent(d, { type: 'session.deleted', data: { sessionID: 'deleted' } });
    expect(d.cleanupSession).toHaveBeenCalledWith('deleted');
    expect(d.log.info).toHaveBeenCalledWith('event', 'session cleanup completed', {
      sessionId: 'deleted',
    });
    expect(d.emitSessionErrorAudit).not.toHaveBeenCalled();
  });

  it('uses idle only as a canonical system-work wakeup, not a review result', async () => {
    const d = deps();
    await handleEvent(d, { type: 'session.idle', data: { sessionID: 'idle' } });
    expect(d.resumePendingSystemWork).toHaveBeenCalledWith('idle');
    expect(d.cleanupSession).not.toHaveBeenCalled();
    expect(d.emitSessionErrorAudit).not.toHaveBeenCalled();
  });

  it('forwards the exact failed-tool notification to the fresh-history reconciliation boundary', async () => {
    const d = deps();
    const event = {
      type: 'session.tool.failed',
      data: { sessionID: 'session', id: 'call', executed: true },
    };
    await handleEvent(d, event);
    expect(d.observeMutationEvent).toHaveBeenCalledExactlyOnceWith(event);
    expect(d.emitSessionErrorAudit).not.toHaveBeenCalled();
    expect(d.resumePendingSystemWork).not.toHaveBeenCalled();
  });

  it.each(['session.deleted', 'session.idle'])(
    'ignores missing/malformed %s identities',
    async (type) => {
      for (const data of [
        undefined,
        {},
        { sessionID: 42 },
        { sessionID: '' },
        { info: { id: 'old-shape' } },
      ]) {
        const d = deps();
        await handleEvent(d, { type, ...(data === undefined ? {} : { data }) });
        expect(d.cleanupSession).not.toHaveBeenCalled();
        expect(d.resumePendingSystemWork).not.toHaveBeenCalled();
      }
    },
  );

  it.each([null, undefined, { type: '' }])('ignores a malformed event: %j', async (event) => {
    const d = deps();
    await handleEvent(d, event as PluginEvent);
    expect(d.log.error).not.toHaveBeenCalled();
    expect(d.cleanupSession).not.toHaveBeenCalled();
  });

  it.each([
    'session.error',
    'session.status',
    'message.part.updated',
    'session.execution.succeeded',
    'session.step.ended',
    'unknown',
  ])('does not accept a V1 alias or promote %s to completion', async (type) => {
    const d = deps();
    await handleEvent(d, { type, data: { sessionID: 'session', status: { type: 'idle' } } });
    for (const method of [
      d.cleanupSession,
      d.resumePendingSystemWork,
      d.emitSessionErrorAudit,
      d.observeMutationEvent,
    ])
      expect(method).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    42,
    'old error string',
    {},
    { name: 'APIError', data: { message: 'old SDK envelope' } },
    { message: '' },
  ])('uses explicit diagnostic uncertainty for malformed native errors: %j', async (error) => {
    const d = deps();
    await handleEvent(d, failure({ error }));
    expect(d.emitSessionErrorAudit).toHaveBeenCalledWith('session', 'unspecified session error', {
      eventType: 'session.execution.failed',
    });
  });

  it('reports missing failure identity as unknown rather than inventing a session', async () => {
    const d = deps();
    await handleEvent(d, { type: 'session.execution.failed' });
    expect(d.emitSessionErrorAudit).toHaveBeenCalledWith('unknown', 'unspecified session error', {
      eventType: 'session.execution.failed',
    });
  });

  it('accepts frozen native notifications without mutation', async () => {
    const d = deps();
    const event = Object.freeze(failure(Object.freeze({ sessionID: 'frozen' })));
    await handleEvent(d, event);
    expect(d.emitSessionErrorAudit).toHaveBeenCalledWith('frozen', 'failed', expect.anything());
  });

  it.each(['cleanup', 'idle', 'mutation', 'audit-sync', 'audit-async', 'logging'])(
    'surfaces %s callback failure diagnostically without crashing the host',
    async (kind) => {
      const d = deps();
      const error = new Error('callback failed');
      const sync = () => {
        throw error;
      };
      let event = failure();
      if (kind === 'cleanup') {
        d.cleanupSession = sync;
        event = { type: 'session.deleted', data: { sessionID: 'session' } };
      }
      if (kind === 'idle') {
        d.resumePendingSystemWork = vi.fn().mockRejectedValue(error);
        event = { type: 'session.idle', data: { sessionID: 'session' } };
      }
      if (kind === 'mutation') {
        d.observeMutationEvent = vi.fn().mockRejectedValue(error);
        event = { type: 'session.tool.failed', data: { sessionID: 'session', id: 'call' } };
      }
      if (kind === 'audit-sync') d.emitSessionErrorAudit = sync;
      if (kind === 'audit-async') d.emitSessionErrorAudit = vi.fn().mockRejectedValue(error);
      if (kind === 'logging') d.log.error = sync;
      await expect(handleEvent(d, event)).resolves.toBeUndefined();
      expect(d.log.warn).toHaveBeenCalledWith('event', 'event handler failed (non-blocking)', {
        eventType: event.type,
        error: expect.objectContaining({ message: 'callback failed' }),
      });
    },
  );

  it('retains rapid-notification handling without throwing', async () => {
    const d = deps();
    const start = performance.now();
    await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        handleEvent(
          d,
          i % 2 === 0 ? failure() : { type: 'session.deleted', data: { sessionID: String(i) } },
        ),
      ),
    );
    expect(performance.now() - start).toBeLessThan(100);
    expect(d.emitSessionErrorAudit).toHaveBeenCalledTimes(500);
    expect(d.cleanupSession).toHaveBeenCalledTimes(500);
  });
});

describe('native failure audit confidentiality', () => {
  it('redacts the native error type/message at source, before both log and raw audit consumers', async () => {
    const d = deps();
    await handleEvent(
      d,
      failure({
        error: {
          type: 'password=hunter2',
          message:
            'Bearer abcdef0123456789 sk-proj-0123456789abcdef /Users/alice/private-project/secrets.env',
        },
      }),
    );
    const text = JSON.stringify([
      vi.mocked(d.log.error).mock.calls,
      vi.mocked(d.emitSessionErrorAudit).mock.calls,
    ]);
    for (const secret of [
      'hunter2',
      'abcdef0123456789',
      'sk-proj-0123456789abcdef',
      '/Users/alice/private-project',
    ])
      expect(text).not.toContain(secret);
  });

  it('deeply redacts supplementary context and preserves arrays, numbers and booleans', async () => {
    const d = deps();
    await handleEvent(
      d,
      failure({
        request: { headers: { authorization: 'Bearer abcdef0123456789' }, retries: 2 },
        attempts: [{ ok: false, note: 'password=hunter2' }],
        stack: 'at /Users/alice/private-project/secrets.env:1:1',
        url: 'https://user:pass@internal.example.com/v2/api',
      }),
    );
    const detail = vi.mocked(d.emitSessionErrorAudit).mock.calls[0]![2];
    expect(detail.supplementary).toMatchObject({
      request: { headers: { authorization: 'Bearer [redacted]' }, retries: 2 },
      attempts: [{ ok: false }],
    });
    const text = JSON.stringify(detail);
    for (const secret of [
      'abcdef0123456789',
      'hunter2',
      '/Users/alice/private-project',
      'user:pass',
    ])
      expect(text).not.toContain(secret);
  });

  it('preserves all supplementary keys, not only a diagnostic allowlist', async () => {
    const d = deps();
    const extra = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`key_${i}`, i]));
    await handleEvent(d, failure(extra));
    expect(vi.mocked(d.emitSessionErrorAudit).mock.calls[0]![2].supplementary).toEqual(extra);
  });

  it('handles cyclic supplementary context without dropping the failure audit', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const d = deps();
    await expect(handleEvent(d, failure({ cyclic }))).resolves.toBeUndefined();
    expect(d.emitSessionErrorAudit).toHaveBeenCalledOnce();
  });
});
