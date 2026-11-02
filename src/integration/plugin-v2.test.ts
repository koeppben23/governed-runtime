/** Native V2 setup/registration contracts. Mocks do not certify installed governance or provenance. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { FlowGuardAuditPlugin, isUsableWorktree } from './plugin.js';
import { OpenCodeHostAdapter } from './opencode-host-adapter.js';
import { encodeHostCallId } from '../state/host-identity.js';
import { createV2Host, v2ToolEvent } from './opencode-v2-test-helpers.js';
import { FLOWGUARD_TOOL_NAMES } from './tool-names.js';
import * as tools from './tools/index.js';
import { DEFAULT_CONFIG } from '../config/flowguard-config.js';
import { makeState } from '../fixtures.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createSessionState } from './review/enforcement/enforcement.js';

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
    getEnforcementState: () => createSessionState(),
  }),
}));

const NATIVE_CALL = encodeHostCallId('session', 'message', 'call');
let cleanup: (() => void | Promise<void>) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  h.resolve.mockImplementation(({ sessionId }: { sessionId: string }) =>
    Promise.resolve({
      status: 'resolved',
      worktreeRoot: process.cwd(),
      fingerprint: 'fingerprint',
      sessDir: `/session/${sessionId}`,
      state: makeState('TICKET'),
    }),
  );
});
afterEach(async () => {
  try {
    await cleanup?.();
  } finally {
    cleanup = undefined;
    vi.restoreAllMocks();
  }
});

async function setup(sessions: readonly string[] = ['session']) {
  const host = createV2Host(process.cwd());
  for (const session of sessions)
    await host.seedActive(session, makeState('TICKET').policySnapshot.hash);
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

  it('registers native hooks once and initially publishes only canonical inert help', async () => {
    const host = await setup([]);
    expect([...host.toolHooks.keys()]).toEqual(['execute.before', 'execute.after']);
    expect([...host.sessionHooks.keys()]).toEqual([
      'prompt',
      'context',
      'compaction',
      'generate',
      'model.request',
    ]);
    expect(host.context.tool.hook).toHaveBeenCalledTimes(2);
    expect(host.context.session.hook).toHaveBeenCalledTimes(5);
    expect(host.context.tool.transform).toHaveBeenCalledOnce();
    expect([...host.definitions.keys()]).toEqual(['flowguard_help']);
    expect(host.subscribe).toHaveBeenCalledOnce();
    expect(host.context.command.transform).not.toHaveBeenCalled();
    expect(h.createLogger).not.toHaveBeenCalled();
    expect(host.definitions.get('flowguard_help')).toMatchObject({
      name: 'flowguard_help',
      description: tools.help.description,
      input: z.toJSONSchema(z.object(tools.help.args), { io: 'input' }),
      options: { codemode: false },
    });
  });

  it('never accepts an existing regular file as a usable worktree', () => {
    expect(isUsableWorktree(fileURLToPath(import.meta.url))).toBe(false);
  });

  it('restores every canonical productive definition for an already active root before any prompt snapshot', async () => {
    const host = await setup();
    expect([...host.definitions.keys()].sort()).toEqual([...FLOWGUARD_TOOL_NAMES].sort());
    expect(host.context.tool.transform).toHaveBeenCalledTimes(2);
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.createLogger).not.toHaveBeenCalled();
  });

  it('publishes newly activated productive tools during prompt preflight, exactly once', async () => {
    const host = await setup([]);
    await host.seedActive('session', makeState('TICKET').policySnapshot.hash);
    await host.sessionHooks.get('prompt')!({ sessionID: 'session' });
    await host.sessionHooks.get('prompt')!({ sessionID: 'session' });
    expect([...host.definitions.keys()].sort()).toEqual([...FLOWGUARD_TOOL_NAMES].sort());
    expect(host.context.tool.transform).toHaveBeenCalledTimes(2);
  });

  it('refuses an already captured incomplete ACTIVE snapshot rather than publishing too late and pretending readiness', async () => {
    const host = await setup([]);
    await host.seedActive('session', makeState('TICKET').policySnapshot.hash);
    await expect(host.request({ sessionID: 'session', agent: 'build', tools: {} })).rejects.toThrow(
      'snapshot was captured',
    );
    expect([...host.definitions.keys()].sort()).toEqual([...FLOWGUARD_TOOL_NAMES].sort());
  });

  it('surfaces productive publication failure and permits a fresh explicit retry without replacing authority', async () => {
    const host = await setup([]);
    await host.seedActive('session', makeState('TICKET').policySnapshot.hash);
    const bytes = structuredClone([...host.activation.values]);
    host.context.tool.transform.mockRejectedValueOnce(new Error('publication failed'));
    await expect(host.sessionHooks.get('prompt')!({ sessionID: 'session' })).rejects.toThrow(
      'publication failed',
    );
    expect([...host.definitions.keys()]).toEqual(['flowguard_help']);
    expect([...host.activation.values]).toEqual(bytes);
    await host.sessionHooks.get('prompt')!({ sessionID: 'session' });
    expect([...host.definitions.keys()].sort()).toEqual([...FLOWGUARD_TOOL_NAMES].sort());
  });

  it('shares a single scoped runtime across native calls and distinct sessions in the same worktree', async () => {
    const host = await setup(['session', 'second']);
    await host.before(v2ToolEvent());
    await host.before(v2ToolEvent({ sessionID: 'second', id: 'second' }));
    expect(h.createLogger).toHaveBeenCalledOnce();
    expect(h.before.mock.calls[0]?.[0]).toBe(h.before.mock.calls[1]?.[0]);
    expect(host.sessionGet).toHaveBeenCalledTimes(4);
  });

  it('refuses native callbacks during partial setup before any scope or governance effect', async () => {
    const host = createV2Host(process.cwd());
    await host.seedActive('session', makeState('TICKET').policySnapshot.hash);
    const register = host.context.tool.hook.getMockImplementation()!;
    host.context.tool.hook.mockImplementationOnce(async (name, callback) => {
      await expect(callback(v2ToolEvent())).rejects.toThrow('not ready');
      expect(host.sessionGet).not.toHaveBeenCalled();
      expect(h.before).not.toHaveBeenCalled();
      return register(name, callback);
    });
    cleanup = (await FlowGuardAuditPlugin.setup(host.ctx)) || undefined;
    await host.before(v2ToolEvent());
    expect(h.before).toHaveBeenCalledOnce();
  });

  it('rejects a claimed canonical root that is not a usable directory before creating runtime logging', async () => {
    const host = await setup();
    h.resolve.mockResolvedValueOnce({
      status: 'resolved',
      worktreeRoot: '/nonexistent/native-worktree',
      fingerprint: 'fingerprint',
      sessDir: '/session',
      state: makeState('TICKET'),
    });
    await expect(host.before(v2ToolEvent())).rejects.toThrow('GOVERNANCE_AUTHORITY_BLOCKED');
    expect(h.createLogger).not.toHaveBeenCalled();
    const dispose = cleanup!;
    cleanup = undefined;
    await expect(dispose()).resolves.toBeUndefined();
  });

  it('rejects a host capability mismatch before publishing registrations', async () => {
    const host = createV2Host(process.cwd());
    vi.spyOn(OpenCodeHostAdapter.prototype, 'validateCapabilities').mockResolvedValueOnce({
      valid: false,
      mismatches: [{ capability: 'preToolBlock', expected: true, actual: false }],
      contractAttested: [],
      runtimeVerified: [],
    });
    await expect(FlowGuardAuditPlugin.setup(host.ctx)).rejects.toHaveProperty(
      'code',
      'HOST_CAPABILITY_MISMATCH',
    );
    expect(host.registrations).toHaveLength(0);
  });

  it('surfaces both setup failure and cleanup failure instead of losing either cause', async () => {
    const host = createV2Host(process.cwd());
    host.failAt(3);
    const error = new Error('shutdown failed');
    vi.spyOn(OpenCodeHostAdapter.prototype, 'shutdown').mockRejectedValueOnce(error);
    await expect(FlowGuardAuditPlugin.setup(host.ctx)).rejects.toMatchObject({
      code: 'PLUGIN_CLEANUP_FAILED',
      errors: [
        expect.objectContaining({ message: 'registration failed' }),
        expect.objectContaining({ code: 'PLUGIN_CLEANUP_FAILED', errors: [error] }),
      ],
    });
    expect(host.registrations.every((item) => item.dispose.mock.calls.length === 1)).toBe(true);
  });

  it.each(['string', 'structured'] as const)(
    'adapts actual canonical executor context and %s result through native registration',
    async (kind) => {
      const host = await setup();
      const signal = new AbortController().signal;
      const execute = vi
        .spyOn(tools.status, 'execute')
        .mockImplementationOnce(async (args, context) => {
          expect(args).toEqual({});
          expect(context).toMatchObject({
            sessionID: 'session',
            messageID: 'message',
            agent: 'build',
            directory: process.cwd(),
            worktree: process.cwd(),
            abort: signal,
          });
          context.metadata({ metadata: { first: true } });
          context.metadata({ title: 'Status', metadata: { second: true } });
          return kind === 'string'
            ? 'canonical result'
            : { output: 'canonical result', metadata: { result: true } };
        });
      const result = await host.definitions
        .get('flowguard_status')!
        .execute(
          { view: 'current', ignored: true },
          { sessionID: 'session', messageID: 'message', agent: 'build', id: 'call', signal },
        );
      expect(result).toEqual({
        content: 'canonical result',
        metadata: {
          first: true,
          second: true,
          title: 'Status',
          ...(kind === 'structured' ? { result: true } : {}),
        },
      });
      expect(execute).toHaveBeenCalledOnce();
    },
  );

  it('blocks the registered executor on unavailable fresh authority even when its hook is skipped', async () => {
    const host = await setup();
    h.resolve
      .mockResolvedValueOnce({
        status: 'resolved',
        worktreeRoot: process.cwd(),
        fingerprint: 'fingerprint',
        sessDir: '/session',
        state: makeState('TICKET'),
      })
      .mockResolvedValueOnce({
        status: 'unavailable',
        code: 'BINDING_INVALID',
        reason: 'changed before execution',
      });
    const execute = vi.spyOn(tools.status, 'execute');
    await expect(
      host.definitions.get('flowguard_status')!.execute({}, { sessionID: 'session' }),
    ).rejects.toThrow('BINDING_INVALID');
    expect(execute).not.toHaveBeenCalled();
  });

  it('permits hydrate of an existing bound session through hook and executor without inventing activation', async () => {
    const host = await setup();
    h.resolve.mockResolvedValue({
      status: 'resolved',
      worktreeRoot: process.cwd(),
      fingerprint: 'fingerprint',
      sessDir: '/session',
      state: makeState('TICKET'),
    });
    const execute = vi.spyOn(tools.hydrate, 'execute').mockResolvedValueOnce('existing session');
    await host.before(v2ToolEvent({ tool: 'flowguard_hydrate', input: {} }));
    const result = await host.definitions.get('flowguard_hydrate')!.execute(
      {},
      {
        sessionID: 'session',
        messageID: 'message',
        agent: 'build',
        signal: new AbortController().signal,
      },
    );
    expect(result).toMatchObject({ content: 'existing session' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('reports the actual runtime diagnostic cause without discarding serialized error details', async () => {
    const host = await setup();
    await host.before(v2ToolEvent());
    const runtime = h.before.mock.calls[0]![0] as FlowGuardPluginRuntime;
    runtime.logError('boundary diagnostic', new Error('original cause'));
    expect(h.log.error).toHaveBeenCalledWith('audit', 'boundary diagnostic', {
      error: expect.objectContaining({ message: 'original cause' }),
    });
  });

  it('fails every ACTIVE operation closed on an unreadable config instead of running on defaults', async () => {
    const host = await setup();
    h.createLogger.mockResolvedValueOnce({
      log: h.log,
      config: DEFAULT_CONFIG,
      configReadError: new Error('unreadable config'),
      disposeLogging: h.dispose,
    });
    await expect(host.before(v2ToolEvent())).rejects.toHaveProperty('code', 'CONFIG_INVALID');
    expect(h.before).not.toHaveBeenCalled();
    expect(h.dispose).toHaveBeenCalledOnce();
    // The failed runtime is not cached: a readable config is re-read, never defaulted.
    await host.before(v2ToolEvent());
    expect(h.before).toHaveBeenCalledOnce();
    expect(host.prompt).not.toHaveBeenCalled();
  });

  it('leaves a non-reviewer native subagent on the ordinary governance path', async () => {
    const host = await setup();
    const event = v2ToolEvent({ tool: 'subagent', input: { agent: 'general' } });
    await host.before(event);
    expect(h.before).toHaveBeenCalledOnce();
    expect(h.before.mock.calls[0]?.[1]).toMatchObject({ tool: 'subagent' });
  });

  it('resolves actual session location before invoking canonical tool governance', async () => {
    const host = await setup();
    const event = v2ToolEvent();
    await host.before(event);
    expect(host.sessionGet).toHaveBeenCalledWith({ sessionID: 'session' }, expect.anything());
    expect(h.resolve).toHaveBeenCalledWith({ root: process.cwd(), sessionId: 'session' });
    expect(h.before).toHaveBeenCalledWith(
      expect.anything(),
      { tool: 'read', sessionID: 'session', callID: NATIVE_CALL },
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
      callID: encodeHostCallId('session', 'message', 'native-call'),
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
    const host = await setup([]);
    await expect(
      host.before(
        v2ToolEvent({ tool: 'flowguard_hydrate', input: { origin: 'human', command: '/start' } }),
      ),
    ).rejects.toThrow('GOVERNANCE_NOT_ACTIVE');
    expect(h.before).not.toHaveBeenCalled();
  });

  it('also blocks hydrate bootstrap at the native executor boundary without relying on hook delivery', async () => {
    const host = await setup();
    const hydrate = host.definitions.get('flowguard_hydrate')!;
    await expect(
      hydrate.execute(
        {},
        {
          sessionID: 'unstarted',
          messageID: 'message',
          agent: 'build',
          id: 'call',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow('GOVERNANCE_NOT_ACTIVE');
  });

  it('rejects malformed governed tool inputs rather than inventing an empty argument object', async () => {
    const host = await setup();
    await expect(host.before(v2ToolEvent({ input: 'unstructured' }))).rejects.toThrow(
      /not an object/,
    );
    expect(h.before).not.toHaveBeenCalled();
  });

  it('blocks reviewer release without matching state authority after generic gates and before provider execution', async () => {
    const host = await setup();
    await expect(
      host.before(
        v2ToolEvent({ tool: 'subagent', input: { agent: 'flowguard-reviewer', prompt: 'review' } }),
      ),
    ).rejects.toThrow(/exact ACTIVE parent/);
    expect(h.before).toHaveBeenCalledOnce();
    expect(host.prompt).not.toHaveBeenCalled();
  });

  it('blocks caller-created reviewer sessions at the native context boundary too', async () => {
    const host = await setup(['session', 'child']);
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
    ).rejects.toThrow(/direct child/);
    expect(host.prompt).not.toHaveBeenCalled();
  });

  it('does not change parent model/variant, options, tools or context', async () => {
    const host = await setup(['parent']);
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
      ...v2ToolEvent({ tool: 'flowguard_status' }),
      status: 'completed',
      result: { content: 'native', metadata: { retained: true } },
    };
    await host.after(event);
    expect(h.after).toHaveBeenCalledOnce();
    expect(event.result).toEqual({ content: 'changed', metadata: { retained: true } });
    expect(h.after.mock.calls[0]?.[1]).toEqual({
      tool: 'flowguard_status',
      sessionID: 'session',
      callID: NATIVE_CALL,
      args: event.input,
    });
  });

  it('handles a valid metadata-only native result as an empty application text without losing fields', async () => {
    const host = await setup();
    const event = {
      ...v2ToolEvent({ tool: 'flowguard_status' }),
      status: 'completed',
      result: { metadata: { native: true }, output: { data: 'native' } },
    };
    await host.after(event);
    expect(h.after.mock.calls[0]?.[2]).toEqual({
      title: '',
      output: '',
      metadata: { native: true },
    });
    expect(event.result).toEqual({
      content: '',
      metadata: { native: true },
      output: { data: 'native' },
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

  it('preserves authoritative rich content and native fields while projecting the single application text', async () => {
    const host = await setup();
    const attachment = { type: 'file', uri: 'file:///artifact', mime: 'text/plain' };
    const event = {
      ...v2ToolEvent({ tool: 'flowguard_status' }),
      status: 'completed',
      result: {
        content: [{ type: 'text', text: '{}' }, attachment],
        metadata: { retained: true },
        output: { native: true },
      },
    };
    await host.after(event);
    expect(h.after.mock.calls[0]?.[2]).toEqual({
      title: '',
      output: '{}',
      metadata: { retained: true },
    });
    expect(event.result.content).toEqual([{ type: 'text', text: '{}' }, attachment]);
    expect(event.result.content[1]).toBe(attachment);
    expect(event.result.output).toEqual({ native: true });
    expect(event.result.metadata).toEqual({ retained: true });
  });

  it('replaces only the canonical text when application processing blocks a native rich completion', async () => {
    const host = await setup();
    h.after.mockImplementationOnce(async (_runtime, _input, output) => {
      (output as { output: string }).output = '{"error":true,"code":"BLOCKED"}';
    });
    const attachment = { type: 'file', uri: 'file:///artifact', mime: 'text/plain' };
    const event = {
      ...v2ToolEvent({ tool: 'shell', input: { command: 'test' } }),
      status: 'completed',
      result: { content: [attachment, { type: 'text', text: 'original' }], metadata: {} },
    };
    await host.after(event);
    expect(h.after.mock.calls[0]?.[1]).toMatchObject({ tool: 'bash', callID: NATIVE_CALL });
    expect(event.result.content).toEqual([
      attachment,
      { type: 'text', text: '{"error":true,"code":"BLOCKED"}' },
    ]);
    expect(event.result.content[0]).toBe(attachment);
  });

  it.each([
    { content: [] },
    { content: [{ type: 'file', uri: 'file:///artifact', mime: 'text/plain' }] },
    {
      content: [
        { type: 'text', text: '{}' },
        { type: 'text', text: '{}' },
      ],
    },
  ])(
    'refuses ambiguous or text-free authoritative rich content without modifying it: %j',
    async ({ content }) => {
      const host = await setup();
      const event = {
        ...v2ToolEvent({ tool: 'flowguard_status' }),
        status: 'completed',
        result: { content },
      };
      const original = structuredClone(event);
      await expect(host.after(event)).rejects.toThrow(/exactly one unambiguous text part/);
      expect(event).toEqual(original);
      expect(h.after).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    {},
    1,
    [null],
    [{ type: 'text', text: 1 }],
    [{ type: 'file', uri: 1, mime: 'text/plain' }],
    [{ type: 'file', uri: 'file:///artifact' }],
    [{ type: 'unknown' }],
    [{ type: 'text', text: '{}' }, 'not-a-part'],
    [
      { type: 'text', text: '{}' },
      { type: 'file', uri: 1, mime: 'text/plain' },
    ],
    [
      { type: 'text', text: '{}' },
      { type: 'file', uri: 'file:///artifact', mime: 1 },
    ],
    [
      { type: 'text', text: '{}' },
      { type: 'unknown', uri: 'file:///artifact', mime: 'text/plain' },
    ],
  ])('rejects malformed native authoritative content with a typed error: %j', async (content) => {
    const host = await setup();
    const event = {
      ...v2ToolEvent({ tool: 'flowguard_status' }),
      status: 'completed',
      result: { content },
    };
    const original = structuredClone(event);
    await expect(host.after(event)).rejects.toHaveProperty(
      'code',
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
    );
    expect(event).toEqual(original);
    expect(h.after).not.toHaveBeenCalled();
  });

  it('retains native rich read-only results and checks activation before draining cached diagnostics', async () => {
    const host = await setup();
    await host.before(v2ToolEvent());
    const lookups = host.sessionGet.mock.calls.length;
    const authorities = h.resolve.mock.calls.length;
    const result = {
      content: [
        { type: 'text', text: 'file contents' },
        { type: 'file', uri: 'file:///artifact', mime: 'text/plain' },
      ],
      metadata: { native: true },
    };
    const event = { ...v2ToolEvent(), status: 'completed', result };
    await host.after(event);
    expect(event.result).toBe(result);
    expect(h.after).toHaveBeenCalledOnce();
    expect(h.after.mock.calls[0]?.[1]).toEqual({
      tool: 'read',
      sessionID: 'session',
      callID: NATIVE_CALL,
      args: event.input,
    });
    expect(h.after.mock.calls[0]?.[2]).toEqual({
      title: '',
      output: result.content,
      metadata: result.metadata,
    });
    expect(host.sessionGet).toHaveBeenCalledTimes(lookups + 1);
    expect(h.resolve).toHaveBeenCalledTimes(authorities);
  });

  it.each([null, undefined, 'input', 1, []])(
    'rejects malformed authoritative completion input before application processing: %j',
    async (input) => {
      const host = await setup();
      const event = {
        ...v2ToolEvent({ tool: 'flowguard_status', input }),
        status: 'completed',
        result: { content: '{}' },
      };
      const original = structuredClone(event);
      await expect(host.after(event)).rejects.toHaveProperty(
        'code',
        'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      );
      expect(event).toEqual(original);
      expect(h.after).not.toHaveBeenCalled();
    },
  );

  it('never creates a runtime or authority merely to observe an unmatched read-only completion', async () => {
    const host = await setup([]);
    const event = {
      ...v2ToolEvent(),
      status: 'completed',
      result: { content: [{ type: 'text', text: 'native' }] },
    };
    const original = structuredClone(event);
    await host.after(event);
    expect(event).toEqual(original);
    expect(host.sessionGet).toHaveBeenCalledOnce();
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.createLogger).not.toHaveBeenCalled();
    expect(h.after).not.toHaveBeenCalled();
  });

  it('evicts failed runtime initialization so a fresh callback can initialize successfully', async () => {
    const host = await setup();
    h.createLogger.mockRejectedValueOnce(new Error('logger unavailable'));
    await expect(host.before(v2ToolEvent())).rejects.toThrow('logger unavailable');
    await expect(host.before(v2ToolEvent())).resolves.toBeUndefined();
    expect(h.createLogger).toHaveBeenCalledTimes(2);
    expect(h.before).toHaveBeenCalledOnce();
  });

  it.each(['context', 'compaction', 'generate'])(
    'keeps productive tools in the ACTIVE root %s request snapshot',
    async (hook) => {
      const host = await setup();
      const view = {
        sessionID: 'session',
        agent: 'build',
        tools: { flowguard_plan: {}, flowguard_help: {}, shell: {} },
        messages: [],
        system: [],
      };
      await host.sessionHooks.get(hook)!(view);
      expect(view.tools).toEqual({ flowguard_plan: {}, flowguard_help: {}, shell: {} });
    },
  );

  it('executes inert help without activation or workflow access', async () => {
    const host = await setup([]);
    await expect(
      host.definitions.get('flowguard_help')!.execute(
        { view: 'context' },
        {
          sessionID: 'ordinary',
          messageID: 'message',
          agent: 'build',
          id: 'help',
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toEqual({ content: tools.help.description, metadata: {} });
    expect(h.resolve).not.toHaveBeenCalled();
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
    await host.after({ ...v2ToolEvent(), status: 'completed', result: { content: 'late read' } });
    expect(h.after).not.toHaveBeenCalled();
  });

  it.each([new Error('lost stream'), undefined])(
    'lost event stream %j fences later governance without pretending recovery',
    async (error) => {
      const host = await setup();
      const log = vi.spyOn(OpenCodeHostAdapter.prototype, 'log').mockImplementation(() => {});
      host.failEvents(error);
      await vi.waitFor(() => expect(log).toHaveBeenCalled());
      await expect(host.before(v2ToolEvent())).rejects.toThrow(/lost required event observation/);
      expect(h.before).not.toHaveBeenCalled();
    },
  );

  it('unexpected clean event-stream termination is also a failure, not an implicit deactivate', async () => {
    const host = await setup();
    const log = vi.spyOn(OpenCodeHostAdapter.prototype, 'log').mockImplementation(() => {});
    host.endEvents();
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    await expect(host.before(v2ToolEvent())).rejects.toThrow(/lost required event observation/);
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
    expect(host.wait).not.toHaveBeenCalled();
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

  it('blocks a moved ACTIVE session instead of reusing or silently rebinding its runtime', async () => {
    const host = await setup();
    h.resolve.mockImplementation(({ root, sessionId }: { root: string; sessionId: string }) =>
      Promise.resolve({
        status: 'resolved',
        worktreeRoot: root,
        fingerprint: 'fingerprint',
        sessDir: `/session/${sessionId}`,
        state: makeState('TICKET'),
      }),
    );
    await host.before(v2ToolEvent());
    const moved = path.dirname(process.cwd());
    host.sessionGet.mockResolvedValueOnce({
      id: 'session',
      parentID: 'parent',
      location: { directory: moved },
    });
    await expect(host.before(v2ToolEvent())).rejects.toThrow('GOVERNANCE_AUTHORITY_BLOCKED');
    expect(h.before).toHaveBeenCalledOnce();
    expect(h.createLogger).toHaveBeenCalledOnce();
    await cleanup!();
    expect(h.dispose).toHaveBeenCalledOnce();
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
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.dispose).not.toHaveBeenCalled();
    await expect(host.before(v2ToolEvent())).rejects.toThrow(/not ready/);
    finish();
    await pending;
    await disposing;
    expect(h.dispose).toHaveBeenCalledOnce();
  });

  it('cleanup drains in-flight productive publication and disposes the late registration too', async () => {
    const host = await setup([]);
    await host.seedActive('session', makeState('TICKET').policySnapshot.hash);
    const publish = host.context.tool.transform.getMockImplementation()!;
    let finish: () => void = () => {};
    host.context.tool.transform.mockImplementationOnce(async (callback) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return publish(callback);
    });
    const publishing = host.sessionHooks.get('prompt')!({ sessionID: 'session' });
    await vi.waitFor(() => expect(host.context.tool.transform).toHaveBeenCalledTimes(2));
    const disposing = cleanup!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    finish();
    await publishing;
    await disposing;
    expect(host.definitions.has('flowguard_plan')).toBe(true);
    expect(host.registrations.every((item) => item.dispose.mock.calls.length === 1)).toBe(true);
    expect(h.dispose).toHaveBeenCalledOnce();
  });

  it('cleanup drains cached read-only completion diagnostics and fences stale read callbacks', async () => {
    const host = await setup();
    await host.before(v2ToolEvent());
    const lookups = host.sessionGet.mock.calls.length;
    let finish: () => void = () => {};
    h.after.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const event = {
      ...v2ToolEvent(),
      status: 'completed',
      result: { content: [{ type: 'text', text: 'native read' }] },
    };
    const pending = host.after(event);
    await vi.waitFor(() => expect(h.after).toHaveBeenCalledOnce());
    const disposing = cleanup!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.dispose).not.toHaveBeenCalled();
    await expect(host.after(event)).rejects.toThrow(/not ready/);
    finish();
    await pending;
    await disposing;
    expect(host.sessionGet).toHaveBeenCalledTimes(lookups + 1);
    expect(h.after).toHaveBeenCalledOnce();
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
      const rejected = expect(pending).rejects.toThrow(/not ready|lost required event observation/);
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

  it('cleanup also drains a cached deletion notification that performs no fresh invocation', async () => {
    const host = await setup();
    await host.before(v2ToolEvent());
    let finish: () => void = () => {};
    h.event.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    host.emit({ type: 'session.deleted', id: 'delete', data: { sessionID: 'session' } });
    await vi.waitFor(() => expect(h.event).toHaveBeenCalledOnce());
    const disposing = cleanup!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.dispose).not.toHaveBeenCalled();
    finish();
    await disposing;
    expect(h.dispose).toHaveBeenCalledOnce();
  });
});
