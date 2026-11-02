/** HAI and native OpenCode V2 client boundary; no live-host assurance is inferred. */
import { describe, expect, it, vi } from 'vitest';
import {
  OpenCodeHostAdapter,
  nativeHostCallId,
  readNativeHostCallIdentity,
  projectOpenCodeEvent,
} from '../integration/opencode-host-adapter.js';
import { createV2Host } from '../integration/opencode-v2-test-helpers.js';
import { REQUIRED_INDEPENDENT_REVIEW_TRANSPORT, reviewTransportSatisfies } from './host-adapter.js';
import type { OpenCodeEvent } from '@opencode/client';

function fixture() {
  const host = createV2Host('/worktree');
  const controller = new AbortController();
  return { host, controller, adapter: new OpenCodeHostAdapter(host.ctx, controller.signal) };
}

describe('native V2 host adapter', () => {
  it('accepts the V2 context and advertises interception, not reviewer proof', async () => {
    const { adapter } = fixture();
    await adapter.initialize();
    expect(adapter.platform).toBe('opencode');
    expect(adapter.enforcementLevel).toBe('synchronous');
    expect(adapter.getWorkingDirectory()).toBe('/worktree');
    expect(adapter.getWorktree()).toBe('/worktree');
    expect(adapter.isReviewerSupported()).toBe(true);
    expect(adapter.capabilities.reviewTransports).toEqual([
      expect.objectContaining({ kind: 'native_subagent_message_json' }),
    ]);
    expect(await adapter.validateCapabilities()).toMatchObject({
      valid: true,
      runtimeVerified: [],
    });
  });

  it.each([
    ['session', 'get'],
    ['session', 'context'],
    ['session', 'prompt'],
    ['session', 'wait'],
    ['tool', 'hook'],
    ['tool', 'transform'],
    ['session', 'hook'],
    ['event', 'subscribe'],
    ['storage', 'get'],
    ['storage', 'set'],
    ['storage', 'scan'],
  ])('fails closed without native %s.%s', async (domain, method) => {
    const { host, adapter } = fixture();
    const ctx = host.ctx as unknown as Record<string, Record<string, unknown>>;
    delete ctx[domain]![method];
    await expect(adapter.initialize()).rejects.toMatchObject({ code: 'HOST_ADAPTER_INIT_FAILED' });
  });

  it('does not expose removed no-op delivery methods', () => {
    const { adapter } = fixture();
    for (const field of ['deliverArgMutation', 'mutateToolResult', 'injectCompactionContext'])
      expect(adapter).not.toHaveProperty(field);
  });

  it('uses exact native session lookup and actual per-session location', async () => {
    const { host, adapter, controller } = fixture();
    host.sessionGet.mockResolvedValueOnce({
      id: 'child',
      parentID: 'parent',
      location: { directory: '/worktree' },
    });
    expect(await adapter.getSession('child')).toEqual({
      sessionId: 'child',
      parentSessionId: 'parent',
      directory: '/worktree',
    });
    expect(host.sessionGet).toHaveBeenCalledWith(
      { sessionID: 'child' },
      { signal: controller.signal },
    );
    host.sessionGet.mockResolvedValueOnce({
      id: 'foreign',
      parentID: 'parent',
      location: { directory: '/other' },
    });
    await expect(adapter.getSession('child')).rejects.toMatchObject({
      code: 'HOST_ADAPTER_INIT_FAILED',
    });
  });

  it('passes native history through unchanged, including absence of V1 parentID', async () => {
    const { host, adapter } = fixture();
    const history = [{ type: 'assistant', id: 'response', requestID: 'request', finish: 'stop' }];
    host.sessionContext.mockResolvedValueOnce(history);
    expect(await adapter.readHistory('child')).toBe(history);
    expect(history[0]).not.toHaveProperty('parentID');
  });

  it.each(['getSession', 'readHistory'] as const)('propagates %s host failures', async (method) => {
    const { host, adapter } = fixture();
    const error = new Error('native failure');
    const spies = { getSession: host.sessionGet, readHistory: host.sessionContext };
    spies[method].mockRejectedValueOnce(error);
    await expect(adapter[method]('child')).rejects.toBe(error);
  });

  it('exposes no V1 reviewer prompt, call-lookup, interrupt or quiescence operation', () => {
    const { adapter } = fixture();
    for (const removed of [
      'listAgents',
      'interrupt',
      'quiescence',
      'reviewerCall',
      'executeReviewerPrompt',
    ])
      expect(adapter).not.toHaveProperty(removed);
  });
  it('delivers synchronous block decisions with the canonical enforcement code', () => {
    const { adapter } = fixture();
    expect(() =>
      adapter.deliverBlockDecision(
        { tool: 'shell', sessionID: 'session', callID: 'call', args: {} },
        {
          blocked: true,
          code: 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
          reason: 'unavailable',
        },
      ),
    ).toThrow(/PLUGIN_ENFORCEMENT_UNAVAILABLE/);
  });

  it('shutdown is idempotent and performs no authority or lease recovery', async () => {
    const { host, adapter } = fixture();
    await adapter.shutdown();
    await adapter.shutdown();
    expect(host.wait).not.toHaveBeenCalled();
    expect(host.prompt).not.toHaveBeenCalled();
  });
});

describe('native V2 notification projection', () => {
  it('reads only the exact canonical native tuple, without normalizing stored IDs', () => {
    const id = nativeHostCallId('session', 'message', 'call');
    expect(readNativeHostCallIdentity(id)).toEqual({
      sessionId: 'session',
      messageId: 'message',
      callId: 'call',
    });
    for (const unsupported of [
      'call',
      '',
      'null',
      '[]',
      '{}',
      '{"sessionId":"session","messageId":"message","callId":"call"}',
      ` ${id}`,
      id.replace('"callId"', '"callID"'),
      JSON.stringify({ callId: '', messageId: 'message', sessionId: 'session' }),
      JSON.stringify({ callId: 'call', messageId: 'message', sessionId: 'session', origin: 'ui' }),
    ])
      expect(readNativeHostCallIdentity(unsupported)).toBeNull();
  });

  it('binds native call identity to session and host assistant message, not the provider ID alone', () => {
    const base = nativeHostCallId('session', 'message', 'call_0');
    expect(nativeHostCallId('session', 'message', 'call_0')).toBe(base);
    expect(
      new Set([
        base,
        nativeHostCallId('other-session', 'message', 'call_0'),
        nativeHostCallId('session', 'other-message', 'call_0'),
        nativeHostCallId('session', 'message', 'call_1'),
        // Delimiter-shaped values cannot alias a different tuple.
        nativeHostCallId('session","messageId":"x', 'message', 'call_0'),
      ]).size,
    ).toBe(5);
  });

  it.each([
    ['', 'message', 'call'],
    ['session', '', 'call'],
    ['session', 'message', ''],
  ])('refuses an incomplete native call identity (%j, %j, %j)', (session, message, call) => {
    expect(() => nativeHostCallId(session, message, call)).toThrow(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
    );
  });

  it('refuses a failed-tool notification without its host assistant-message identity', () => {
    expect(() =>
      projectOpenCodeEvent({
        id: 'event',
        type: 'session.tool.failed',
        data: { sessionID: 'child', id: 'call' },
      } as unknown as OpenCodeEvent),
    ).toThrow('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });
  it.each(['session.deleted', 'session.idle', 'session.execution.failed', 'session.tool.failed'])(
    'preserves %s identity and data without creating completion proof',
    (type) => {
      const data = {
        sessionID: 'child',
        assistantMessageID: 'message',
        id: 'call',
        executed: false,
        error: { code: 'failed', message: 'error' },
      };
      const projected = projectOpenCodeEvent({
        id: 'event',
        type,
        data,
      } as unknown as OpenCodeEvent);
      expect(projected).toEqual({
        sessionId: 'child',
        event: {
          type,
          data: {
            ...data,
            hostEventId: 'event',
            ...(type === 'session.tool.failed'
              ? { hostCallId: nativeHostCallId('child', 'message', 'call') }
              : {}),
          },
        },
      });
      expect(projected?.event).not.toHaveProperty('properties');
    },
  );

  it.each([
    'session.execution.succeeded',
    'session.step.ended',
    'message.updated',
    'server.connected',
  ])('does not promote %s into review approval or another event shape', (type) => {
    expect(
      projectOpenCodeEvent({
        type,
        id: 'event',
        data: { sessionID: 'child' },
      } as unknown as OpenCodeEvent),
    ).toBeNull();
  });

  it('retains transport-bound capability checks rather than joining incomplete transports', () => {
    expect(
      reviewTransportSatisfies(
        {
          ...REQUIRED_INDEPENDENT_REVIEW_TRANSPORT,
          kind: 'native_task_message_json',
          assurance: 'unstructured',
          validatedResult: false,
        },
        REQUIRED_INDEPENDENT_REVIEW_TRANSPORT,
      ),
    ).toBe(false);
  });
});
