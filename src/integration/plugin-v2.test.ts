/** Native V2 setup/registration contracts. Mocks do not certify installed governance or provenance. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { FlowGuardAuditPlugin } from './plugin.js';
import { OpenCodeHostAdapter } from './opencode-host-adapter.js';
import { createV2Host, v2ToolEvent } from './opencode-v2-test-helpers.js';
import { FLOWGUARD_TOOL_NAMES } from './tool-names.js';

const h = vi.hoisted(() => ({
  before: vi.fn(async (..._args: unknown[]) => {}),
  after: vi.fn(async (..._args: unknown[]) => {}),
  event: vi.fn(async (..._args: unknown[]) => {}),
  compact: vi.fn(async (..._args: unknown[]) => {}),
  dispose: vi.fn(async () => {}),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  resolve: vi.fn(),
  createLogger: vi.fn(),
}));

vi.mock('../adapters/session-authority.js', () => ({ resolveSessionAuthority: h.resolve }));
vi.mock('./plugin-beforehooks.js', () => ({ toolBefore: h.before }));
vi.mock('./plugin-afterhooks.js', () => ({
  toolAfter: h.after,
  handlePluginEvent: h.event,
  handleCompaction: h.compact,
}));
vi.mock('./plugin-logging.js', async () => {
  const { DEFAULT_CONFIG } = await import('../config/flowguard-config.js');
  h.createLogger.mockResolvedValue({
    log: h.log,
    config: DEFAULT_CONFIG,
    disposeLogging: h.dispose,
  });
  return { createPluginLogger: h.createLogger };
});
vi.mock('./plugin-workspace.js', () => ({
  createWorkspace: () => ({
    resolveFingerprint: async () => 'fingerprint',
    cachedWsDir: null,
    cachedFingerprint: 'fingerprint',
    resolveSessionAuthority: (sessionId: string) => h.resolve({ root: process.cwd(), sessionId }),
  }),
}));

let cleanup: (() => void | Promise<void>) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  h.resolve.mockImplementation(({ sessionId }: { sessionId: string }) =>
    Promise.resolve({
      status: 'absent',
      worktreeRoot: process.cwd(),
      fingerprint: 'fingerprint',
      sessDir: `/session/${sessionId}`,
    }),
  );
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
});

async function setup() {
  const host = createV2Host(process.cwd());
  cleanup = (await FlowGuardAuditPlugin.setup(host.ctx)) || undefined;
  return host;
}

describe('native V2 entrypoint', () => {
  it('is a definition with setup, not a callable factory or dual V1 server entrypoint', () => {
    expect(FlowGuardAuditPlugin.id).toBe('flowguard');
    expect(typeof FlowGuardAuditPlugin).toBe('object');
    expect(typeof FlowGuardAuditPlugin.setup).toBe('function');
    expect(FlowGuardAuditPlugin).not.toHaveProperty('server');
  });

  it('registers native hooks once and derives all tools from the canonical surface', async () => {
    const host = await setup();
    expect([...host.toolHooks.keys()]).toEqual(['execute.before', 'execute.after']);
    expect([...host.sessionHooks.keys()]).toEqual(['context', 'compaction']);
    expect(host.context.tool.hook).toHaveBeenCalledTimes(2);
    expect(host.context.session.hook).toHaveBeenCalledTimes(2);
    expect(host.context.tool.transform).toHaveBeenCalledOnce();
    expect([...host.definitions.keys()].sort()).toEqual([...FLOWGUARD_TOOL_NAMES].sort());
    expect(host.subscribe).toHaveBeenCalledOnce();
    expect(host.context.command.transform).not.toHaveBeenCalled();
    expect(h.createLogger).not.toHaveBeenCalled();
  });

  it('resolves actual session location before invoking canonical tool governance', async () => {
    const host = await setup();
    const event = v2ToolEvent();
    await host.before(event);
    expect(host.sessionGet).toHaveBeenCalledWith({ sessionID: 'session' }, expect.anything());
    expect(h.resolve).toHaveBeenCalledWith({ root: process.cwd(), sessionId: 'session' });
    expect(h.before).toHaveBeenCalledWith(
      expect.anything(),
      { tool: 'read', sessionID: 'session', callID: 'call' },
      { args: event.input },
    );
    expect(h.createLogger).toHaveBeenCalledOnce();
  });

  it('preserves exact native call identity and applied argument mutations', async () => {
    const host = await setup();
    const args = { command: 'git status' };
    h.before.mockImplementationOnce(async (_runtime, _input, output) => {
      (output as { args: Record<string, unknown> }).args = args;
    });
    const event = v2ToolEvent({ tool: 'shell', id: 'native-call' });
    await host.before(event);
    expect(event.input).toBe(args);
    expect(h.before.mock.calls[0]?.[1]).toEqual({
      tool: 'bash',
      sessionID: 'session',
      callID: 'native-call',
    });
  });

  it('propagates canonical denial without publishing a successful completion', async () => {
    const host = await setup();
    const error = Object.assign(new Error('denied'), { code: 'DENIED' });
    h.before.mockRejectedValueOnce(error);
    await expect(host.before(v2ToolEvent())).rejects.toBe(error);
    expect(h.after).not.toHaveBeenCalled();
  });

  it('does not fall back to plugin-load cwd when exact session lookup fails', async () => {
    const host = await setup();
    const error = new Error('missing session');
    host.sessionGet.mockRejectedValueOnce(error);
    await expect(host.before(v2ToolEvent())).rejects.toBe(error);
    expect(h.before).not.toHaveBeenCalled();
    expect(h.createLogger).not.toHaveBeenCalled();
  });

  it('fails closed on unavailable canonical authority', async () => {
    const host = await setup();
    h.resolve.mockResolvedValueOnce({
      status: 'unavailable',
      code: 'BINDING_INVALID',
      reason: 'foreign',
    });
    await expect(host.before(v2ToolEvent())).rejects.toThrow(/BINDING_INVALID/);
    expect(h.before).not.toHaveBeenCalled();
  });

  it('does not treat caller metadata or a command-like tool argument as operator source', async () => {
    const host = await setup();
    await expect(
      host.before(
        v2ToolEvent({ tool: 'flowguard_hydrate', input: { origin: 'human', command: '/start' } }),
      ),
    ).rejects.toThrow(/operator UI provenance/);
    expect(h.before).not.toHaveBeenCalled();
  });

  it('also blocks hydrate bootstrap at the native executor boundary without relying on hook delivery', async () => {
    const host = await setup();
    const hydrate = host.definitions.get('flowguard_hydrate')!;
    await expect(
      hydrate.execute(
        {},
        {
          sessionID: 'session',
          messageID: 'message',
          agent: 'build',
          id: 'call',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow(/operator UI provenance/);
  });

  it('rejects malformed governed tool inputs rather than inventing an empty argument object', async () => {
    const host = await setup();
    await expect(host.before(v2ToolEvent({ input: 'unstructured' }))).rejects.toThrow(
      /not an object/,
    );
    expect(h.before).not.toHaveBeenCalled();
  });

  it('blocks unverified native reviewer release before generic governance or provider execution', async () => {
    const host = await setup();
    await expect(
      host.before(
        v2ToolEvent({ tool: 'subagent', input: { agent: 'flowguard-reviewer', prompt: 'review' } }),
      ),
    ).rejects.toThrow(/NOT_VERIFIED/);
    expect(h.before).not.toHaveBeenCalled();
    expect(host.prompt).not.toHaveBeenCalled();
  });

  it('blocks caller-created reviewer sessions at the native context boundary too', async () => {
    const host = await setup();
    await expect(
      host.request({
        sessionID: 'child',
        agent: 'flowguard-reviewer',
        model: {},
        system: [],
        messages: [],
        tools: {},
        options: {},
      }),
    ).rejects.toThrow(/cannot attest/);
    expect(host.prompt).not.toHaveBeenCalled();
  });

  it('does not change parent model/variant, options, tools or context', async () => {
    const host = await setup();
    const request = {
      sessionID: 'parent',
      agent: 'build',
      model: { providerID: 'any-provider', id: 'any-model', variant: 'custom-native-effort' },
      system: [],
      messages: [],
      tools: { shell: {} },
      options: { reasoningEffort: 'native' },
    };
    const before = structuredClone(request);
    await host.request(request);
    expect(request).toEqual(before);
  });

  it('projects native successful tool output through canonical processing once', async () => {
    const host = await setup();
    h.after.mockImplementationOnce(async (_runtime, _input, output) => {
      (output as { output: string; metadata: Record<string, unknown> }).output = 'changed';
    });
    const event = {
      ...v2ToolEvent(),
      status: 'completed',
      result: { content: 'native', metadata: { retained: true } },
    };
    await host.after(event);
    expect(h.after).toHaveBeenCalledOnce();
    expect(event.result).toEqual({ content: 'changed', metadata: { retained: true } });
    expect(h.after.mock.calls[0]?.[1]).toEqual({
      tool: 'read',
      sessionID: 'session',
      callID: 'call',
      args: event.input,
    });
  });

  it('never converts a native tool error into a successful after-hook result', async () => {
    const host = await setup();
    await host.after({
      ...v2ToolEvent(),
      status: 'error',
      error: { code: 'failed', message: 'failed' },
    });
    expect(h.after).not.toHaveBeenCalled();
  });

  it('fails explicitly instead of dropping native rich content', async () => {
    const host = await setup();
    await expect(
      host.after({
        ...v2ToolEvent(),
        status: 'completed',
        result: { content: [{ type: 'file', uri: 'file:///artifact', mime: 'text/plain' }] },
      }),
    ).rejects.toThrow(/losing native content/);
    expect(h.after).not.toHaveBeenCalled();
  });

  it('keeps compaction on the existing authority and scopes context to that session', async () => {
    const host = await setup();
    h.compact.mockImplementationOnce(async (_runtime, _input, output) => {
      (output as { context: string[] }).context.push('governed context');
    });
    const request = {
      sessionID: 'session',
      agent: 'build',
      system: [] as unknown[],
      messages: [],
      model: {},
      options: {},
      tools: {},
    };
    await host.compact(request);
    expect(h.compact).toHaveBeenCalledWith(
      expect.anything(),
      { sessionID: 'session' },
      { context: ['governed context'] },
    );
    expect(request.system).toEqual([{ type: 'text', text: 'governed context' }]);
  });

  it('delivers native notifications with unchanged IDs and no V1 event aliases', async () => {
    const host = await setup();
    host.emit({ type: 'session.idle', id: 'event-1', data: { sessionID: 'session' } });
    await vi.waitFor(() => expect(h.event).toHaveBeenCalledOnce());
    expect(h.event.mock.calls[0]?.[1]).toEqual({
      type: 'session.idle',
      data: { sessionID: 'session', hostEventId: 'event-1' },
    });
  });

  it('cleans a known deleted session without querying a host record that no longer exists', async () => {
    const host = await setup();
    await host.before(v2ToolEvent());
    const count = host.sessionGet.mock.calls.length;
    host.emit({ type: 'session.deleted', id: 'deleted', data: { sessionID: 'session' } });
    await vi.waitFor(() => expect(h.event).toHaveBeenCalledOnce());
    expect(host.sessionGet).toHaveBeenCalledTimes(count);
  });

  it.each([new Error('lost stream'), undefined])(
    'lost event stream %j fences later governance without pretending recovery',
    async (error) => {
      const host = await setup();
      const log = vi.spyOn(OpenCodeHostAdapter.prototype, 'log').mockImplementation(() => {});
      host.failEvents(error);
      await vi.waitFor(() => expect(log).toHaveBeenCalled());
      await expect(host.before(v2ToolEvent())).rejects.toThrow(/lost its event stream/);
      expect(h.before).not.toHaveBeenCalled();
    },
  );

  it('unexpected clean event-stream termination is also a failure, not an implicit deactivate', async () => {
    const host = await setup();
    const log = vi.spyOn(OpenCodeHostAdapter.prototype, 'log').mockImplementation(() => {});
    host.endEvents();
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    await expect(host.before(v2ToolEvent())).rejects.toThrow(/lost its event stream/);
  });

  it('setup failure disposes every acquired registration and preserves the original cause', async () => {
    const host = createV2Host(process.cwd());
    host.failAt(3);
    const shutdown = vi.spyOn(OpenCodeHostAdapter.prototype, 'shutdown');
    await expect(FlowGuardAuditPlugin.setup(host.ctx)).rejects.toThrow('registration failed');
    expect(host.registrations).toHaveLength(2);
    for (const registration of host.registrations)
      expect(registration.dispose).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(host.subscribe).not.toHaveBeenCalled();
  });

  it('normal cleanup aborts the stream, removes hooks and disposes owned logging exactly once', async () => {
    const host = await setup();
    await host.before(v2ToolEvent());
    const dispose = cleanup!;
    await dispose();
    await dispose();
    expect(host.subscribe.mock.calls[0]?.[0].signal.aborted).toBe(true);
    for (const registration of host.registrations)
      expect(registration.dispose).toHaveBeenCalledOnce();
    expect(h.dispose).toHaveBeenCalledOnce();
    await expect(host.before(v2ToolEvent())).rejects.toThrow(/not ready/);
    expect(host.interrupt).not.toHaveBeenCalled();
  });

  it('cleanup attempts remaining resources even when one registration fails', async () => {
    const host = await setup();
    await host.before(v2ToolEvent());
    host.registrations[0]!.dispose.mockRejectedValueOnce(new Error('dispose failed'));
    const dispose = cleanup!;
    cleanup = undefined;
    await expect(dispose()).rejects.toMatchObject({ code: 'PLUGIN_CLEANUP_FAILED' });
    for (const registration of host.registrations)
      expect(registration.dispose).toHaveBeenCalledOnce();
    expect(h.dispose).toHaveBeenCalledOnce();
  });

  it('reload creates fresh registrations and never revives callbacks from the disposed instance', async () => {
    const first = await setup();
    await cleanup!();
    cleanup = undefined;
    const second = await setup();
    await expect(first.before(v2ToolEvent())).rejects.toThrow(/not ready/);
    await second.before(v2ToolEvent());
    expect(h.before).toHaveBeenCalledOnce();
    expect(second.registrations.every((item) => item.dispose.mock.calls.length === 0)).toBe(true);
  });

  it('re-resolves a moved session and does not reuse the previous worktree runtime', async () => {
    const host = await setup();
    h.resolve.mockImplementation(({ root, sessionId }: { root: string; sessionId: string }) =>
      Promise.resolve({
        status: 'absent',
        worktreeRoot: root,
        fingerprint: 'fingerprint',
        sessDir: `/session/${sessionId}`,
      }),
    );
    await host.before(v2ToolEvent());
    const previous = h.before.mock.calls[0]![0];
    const moved = path.dirname(process.cwd());
    host.sessionGet.mockResolvedValueOnce({
      id: 'session',
      parentID: 'parent',
      location: { directory: moved },
    });
    await host.before(v2ToolEvent());
    expect(h.resolve).toHaveBeenCalledWith({ root: moved, sessionId: 'session' });
    expect(h.before.mock.calls[1]![0]).not.toBe(previous);
    expect(h.createLogger).toHaveBeenCalledTimes(2);
    await cleanup!();
    expect(h.dispose).toHaveBeenCalledTimes(2);
  });

  it('cleanup waits for an already-entered hook before disposing its runtime', async () => {
    const host = await setup();
    let finish: () => void = () => {};
    h.before.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = host.before(v2ToolEvent());
    await vi.waitFor(() => expect(h.before).toHaveBeenCalledOnce());
    const disposing = cleanup!();
    expect(h.dispose).not.toHaveBeenCalled();
    await expect(host.before(v2ToolEvent())).rejects.toThrow(/not ready/);
    finish();
    await pending;
    await disposing;
    expect(h.dispose).toHaveBeenCalledOnce();
  });

  it.each(['cleanup', 'lost-stream'] as const)(
    'rechecks the lifecycle fence after asynchronous session resolution: %s',
    async (boundary) => {
      const host = await setup();
      let finish: (session: Awaited<ReturnType<typeof host.sessionGet>>) => void = () => {};
      host.sessionGet.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = host.before(v2ToolEvent());
      const rejected = expect(pending).rejects.toThrow(/not ready|lost its event stream/);
      await vi.waitFor(() => expect(host.sessionGet).toHaveBeenCalledOnce());
      let disposing: void | Promise<void> = undefined;
      if (boundary === 'cleanup') disposing = cleanup!();
      else {
        const log = vi.spyOn(OpenCodeHostAdapter.prototype, 'log').mockImplementation(() => {});
        host.failEvents(new Error('stream lost during lookup'));
        await vi.waitFor(() => expect(log).toHaveBeenCalled());
      }
      finish({ id: 'session', parentID: 'parent', location: { directory: process.cwd() } });
      await rejected;
      await disposing;
      expect(h.before).not.toHaveBeenCalled();
    },
  );

  it('cleanup drains an in-flight notification before disposing its runtime', async () => {
    const host = await setup();
    let finish: () => void = () => {};
    h.event.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    host.emit({ type: 'session.idle', id: 'idle', data: { sessionID: 'session' } });
    await vi.waitFor(() => expect(h.event).toHaveBeenCalledOnce());
    const disposing = cleanup!();
    expect(h.dispose).not.toHaveBeenCalled();
    finish();
    await disposing;
    expect(h.dispose).toHaveBeenCalledOnce();
  });
});
