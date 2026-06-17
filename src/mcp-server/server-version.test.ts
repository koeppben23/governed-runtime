import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PACKAGE_VERSION } from '../shared/package-version.js';

const mcpServerCalls = vi.hoisted(() => ({
  values: [] as { serverInfo: unknown; options: unknown }[],
}));

const transportEvents = vi.hoisted(() => ({
  handlers: {} as Record<string, ((...args: unknown[]) => void) | undefined>,
  connectFn: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class MockMcpServer {
    constructor(serverInfo: unknown, options: unknown) {
      mcpServerCalls.values.push({ serverInfo, options });
    }
    connect = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class MockStdioTransport {
    set onerror(handler: (err: unknown) => void) {
      transportEvents.handlers['error'] = handler;
    }
    connect = transportEvents.connectFn;
  },
}));

vi.mock('./tool-adapter.js', () => ({
  registerAllTools: vi.fn(),
}));

vi.mock('./stdout-guard.js', () => ({
  installStdoutGuard: vi.fn(),
}));

vi.mock('./mcp-logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mcp-logger.js')>();
  const spy = vi.fn();
  return {
    ...actual,
    mcpLogger: {
      ...actual.mcpLogger,
      error: (service: string, message: string, extra?: Record<string, unknown>) => {
        spy(service, message, extra);
        actual.mcpLogger.error(service, message, extra);
      },
      _spy: spy,
    },
  };
});

vi.mock('../integration/tools/index.js', () => {
  const tool = { description: 'test tool', args: {}, execute: vi.fn() };
  return {
    status: tool,
    hydrate: tool,
    plan: tool,
    implement: tool,
    architecture: tool,
    decision: tool,
    run_check: tool,
    ticket: tool,
    review: tool,
    abort_session: tool,
    archive: tool,
    continue: tool,
  };
});

describe('MCP server version', () => {
  afterEach(() => {
    mcpServerCalls.values.length = 0;
    vi.resetModules();
  });

  it('passes the canonical package version to the MCP SDK constructor', async () => {
    const { createMcpServer } = await import('./server.js');

    createMcpServer();

    expect(mcpServerCalls.values).toHaveLength(1);
    expect(mcpServerCalls.values[0]?.serverInfo).toEqual({
      name: 'flowguard',
      version: PACKAGE_VERSION(),
    });
  });

  it('does not contain a hardcoded SemVer server version literal', () => {
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf-8');

    expect(source).not.toMatch(/['"]\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?['"]/);
  });

  it('emits server_created log via mcpLogger', async () => {
    const { createMcpServer } = await import('./server.js');
    const { mcpLogger } = await import('./mcp-logger.js');
    const infoSpy = vi.spyOn(mcpLogger, 'info');

    createMcpServer();

    expect(infoSpy).toHaveBeenCalledWith('mcp', 'server_created', {
      version: PACKAGE_VERSION(),
    });

    infoSpy.mockRestore();
  });

  it('startMcpServer registers transport error handler that logs transport_error', async () => {
    const { startMcpServer } = await import('./server.js');
    const { mcpLogger } = await import('./mcp-logger.js');
    const errorSpy = vi.spyOn(mcpLogger, 'error');

    const startPromise = startMcpServer();
    const errorHandler = transportEvents.handlers['error'];
    expect(errorHandler).toBeDefined();

    errorHandler!(new Error('pipe broken'));

    expect(errorSpy).toHaveBeenCalledWith('mcp', 'transport_error', {
      errorName: 'Error',
    });

    errorSpy.mockRestore();
    // Resolve the connect promise so the test finishes cleanly
    await startPromise;
  });
});
