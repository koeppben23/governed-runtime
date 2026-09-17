/**
 * @module mcp-server/server-registry.test
 * @description Boot-contract tests for the MCP server factory: the tool
 *              registry authority, server identity/capabilities, the root
 *              change cache invalidation and the stdout guard ordering.
 *
 * The MCP SDK and the surrounding process boundaries are mocked so the test
 * asserts exactly what `server.ts` hands to them.
 */

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registerAllTools: vi.fn(),
  notificationHandler: undefined as ((notification: unknown) => void) | undefined,
  notificationSchema: undefined as
    { safeParse: (value: unknown) => { success: boolean } } | undefined,
  constructorArgs: [] as unknown[],
  listRoots: vi.fn(async () => ({ roots: [{ uri: 'file:///workspace' }] })),
  resolve: vi.fn(async () => ({
    sessionId: 'mcp-session',
    directory: '/workspace',
    worktree: '/workspace',
  })),
  installStdoutGuard: vi.fn(),
  connect: vi.fn(async () => undefined),
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class MockMcpServer {
    readonly server = {
      setNotificationHandler: (schema: unknown, handler: (notification: unknown) => void) => {
        mocks.notificationSchema = schema as typeof mocks.notificationSchema;
        mocks.notificationHandler = handler;
      },
      listRoots: mocks.listRoots,
    };

    constructor(...args: unknown[]) {
      mocks.constructorArgs.push(args);
    }

    connect = mocks.connect;
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class MockTransport {},
}));

vi.mock('./tool-adapter.js', () => ({
  registerAllTools: mocks.registerAllTools,
}));

vi.mock('./mcp-logger.js', () => ({
  mcpLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./execution-limiter.js', () => ({
  McpExecutionLimiter: class MockLimiter {
    readonly limits = { timeoutMs: 1000 };
  },
  readMcpExecutionLimits: () => ({ maxConcurrent: 1, maxPerSecond: 1, timeoutMs: 1000 }),
}));

vi.mock('./session-resolver.js', () => ({
  SESSION_UNRESOLVABLE_CODE: 'SESSION_UNRESOLVABLE',
  McpSessionResolutionError: class MockSessionError extends Error {},
  McpSessionBinder: class MockBinder {
    resolve = mocks.resolve;
  },
}));

vi.mock('./stdout-guard.js', () => ({
  installStdoutGuard: mocks.installStdoutGuard,
}));

const { FLOWGUARD_TOOLS, createMcpServer, startMcpServer } = await import('./server.js');

const EXPECTED_TOOL_NAMES = [
  'abort_session',
  'architecture',
  'archive',
  'continue',
  'decision',
  'declare_contract',
  'export',
  'help',
  'hydrate',
  'implement',
  'observe_repository',
  'plan',
  'record_mutation_evidence',
  'review',
  'review_implementation',
  'run_check',
  'status',
  'ticket',
];

describe('MCP server registry and boot contract', () => {
  it('exposes the complete FlowGuard tool registry as the single authority', () => {
    expect(Object.keys(FLOWGUARD_TOOLS).sort()).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('advertises the FlowGuard server identity and fixed tool-list capability', () => {
    createMcpServer();
    const [serverInfo, options] = mocks.constructorArgs[0] as [
      { name: string; version: string },
      { capabilities: { tools: { listChanged: boolean } } },
    ];

    expect(serverInfo.name).toBe('flowguard');
    expect(serverInfo.version).toBeTruthy();
    expect(options.capabilities.tools.listChanged).toBe(false);
  });

  it('registers the registry and a session context factory with the tool adapter', () => {
    mocks.registerAllTools.mockClear();
    createMcpServer();

    expect(mocks.registerAllTools).toHaveBeenCalledTimes(1);
    const [serverArg, toolsArg, contextFactory, limiterArg] = mocks.registerAllTools.mock
      .calls[0] as [unknown, unknown, () => Promise<unknown>, unknown];
    expect(serverArg).toBeDefined();
    expect(toolsArg).toBe(FLOWGUARD_TOOLS);
    expect(limiterArg).toBeDefined();
    expect(typeof contextFactory).toBe('function');
  });

  it('caches the resolved roots until the client reports a root change', async () => {
    mocks.registerAllTools.mockClear();
    mocks.listRoots.mockClear();
    mocks.resolve.mockClear();
    createMcpServer();

    const contextFactory = mocks.registerAllTools.mock.calls[0]![2] as () => Promise<unknown>;

    const first = await contextFactory();
    const second = await contextFactory();
    expect(mocks.listRoots).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);

    mocks.notificationHandler!({ method: 'notifications/roots/list_changed' });
    const third = await contextFactory();
    expect(mocks.listRoots).toHaveBeenCalledTimes(2);
    expect(third).not.toBe(first);
    expect(mocks.resolve).toHaveBeenLastCalledWith([{ uri: 'file:///workspace' }]);
  });

  it('only accepts the canonical roots-list-changed notification shape', () => {
    createMcpServer();
    expect(mocks.notificationSchema).toBeDefined();
    expect(
      mocks.notificationSchema!.safeParse({ method: 'notifications/roots/list_changed' }).success,
    ).toBe(true);
    expect(mocks.notificationSchema!.safeParse({ method: 'notifications/other' }).success).toBe(
      false,
    );
  });

  it('installs the stdout guard before connecting the stdio transport', async () => {
    mocks.installStdoutGuard.mockClear();
    mocks.connect.mockClear();

    await startMcpServer();

    expect(mocks.installStdoutGuard).toHaveBeenCalledTimes(1);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.installStdoutGuard.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.connect.mock.invocationCallOrder[0]!,
    );
  });
});
