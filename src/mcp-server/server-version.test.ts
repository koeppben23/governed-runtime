import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PACKAGE_VERSION } from '../shared/package-version.js';

const mcpServerCalls = vi.hoisted(() => ({
  values: [] as { serverInfo: unknown; options: unknown }[],
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class MockMcpServer {
    constructor(serverInfo: unknown, options: unknown) {
      mcpServerCalls.values.push({ serverInfo, options });
    }
  },
}));

vi.mock('./tool-adapter.js', () => ({
  registerAllTools: vi.fn(),
}));

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
});
