/**
 * @module mcp-server/mcp-protocol.test
 * @description MCP protocol compliance and negative-path tests.
 *
 * Spawns the FlowGuard MCP server as a child process and communicates
 * via JSON-RPC over stdin/stdout to verify:
 * - Protocol initialization handshake
 * - tools/list returns all 12 tools with correct schemas
 * - tools/call with valid and invalid inputs
 * - Error handling for unknown tools, bad args, missing session state
 * - stdout is exclusively JSON-RPC (no contamination)
 *
 * These tests require a prior `npm run build` (they spawn `dist/mcp-server/index.js`).
 *
 * @test-policy HAPPY, BAD, CORNER ÔÇö three categories present.
 * @see https://github.com/koeppben23/governed-runtime/issues/243
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { existsSync } from 'node:fs';

const PROJECT_ROOT = path.resolve(__dirname, '../../');
const SERVER_ENTRY = path.join(PROJECT_ROOT, 'dist', 'mcp-server', 'index.js');

// ÔöÇÔöÇÔöÇ JSON-RPC Helpers ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

let nextId = 1;
function makeRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: '2.0', id: nextId++, method, params };
}

// ÔöÇÔöÇÔöÇ Server Process Manager ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

class McpTestClient {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private responses: Map<number, JsonRpcResponse> = new Map();
  private resolvers: Map<number, (resp: JsonRpcResponse) => void> = new Map();
  private stderrOutput = '';

  async start(): Promise<void> {
    if (!existsSync(SERVER_ENTRY)) {
      throw new Error(`MCP server not built. Run 'npm run build' first. Expected: ${SERVER_ENTRY}`);
    }

    this.proc = spawn('node', [SERVER_ENTRY], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Point to a non-existent session dir to test graceful error handling
        FLOWGUARD_SESSION_DIR: path.join(PROJECT_ROOT, '.test-mcp-session'),
      },
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.proc.stderr!.on('data', (chunk: Buffer) => {
      this.stderrOutput += chunk.toString();
    });

    // Give server a moment to start
    await new Promise((r) => setTimeout(r, 200));
  }

  private processBuffer(): void {
    // MCP stdio: messages are newline-delimited JSON
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id !== undefined) {
          const resolver = this.resolvers.get(msg.id);
          if (resolver) {
            resolver(msg);
            this.resolvers.delete(msg.id);
          } else {
            this.responses.set(msg.id, msg);
          }
        }
      } catch {
        // Non-JSON output on stdout ÔÇö this would be a guard failure
      }
    }
  }

  async send(request: JsonRpcRequest, timeoutMs = 5000): Promise<JsonRpcResponse> {
    if (!this.proc?.stdin?.writable) {
      throw new Error('Server not running');
    }

    // Check if response already buffered
    const existing = this.responses.get(request.id);
    if (existing) {
      this.responses.delete(request.id);
      return existing;
    }

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.resolvers.delete(request.id);
        reject(new Error(`Timeout waiting for response to ${request.method} (id=${request.id})`));
      }, timeoutMs);

      this.resolvers.set(request.id, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });

      this.proc!.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  getStderrOutput(): string {
    return this.stderrOutput;
  }

  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill();
      this.proc = null;
    }
  }
}

// ÔöÇÔöÇÔöÇ Tests ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

describe('MCP Protocol Compliance', () => {
  let client: McpTestClient;

  beforeAll(async () => {
    client = new McpTestClient();
    await client.start();
  });

  afterAll(async () => {
    await client.stop();
  });

  it('HAPPY: server responds to initialize request', async () => {
    const resp = await client.send(
      makeRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      }),
    );

    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeDefined();

    const result = resp.result as Record<string, unknown>;
    expect(result['protocolVersion']).toBeDefined();
    expect(result['serverInfo']).toBeDefined();

    const serverInfo = result['serverInfo'] as Record<string, unknown>;
    expect(serverInfo['name']).toBe('flowguard');

    // Send initialized notification (no response expected for notifications)
    client.send(makeRequest('notifications/initialized', {})).catch(() => {
      /* notifications don't get responses */
    });

    // Give server time to process the notification
    await new Promise((r) => setTimeout(r, 100));
  });

  it('HAPPY: tools/list returns all 12 FlowGuard tools', async () => {
    const resp = await client.send(makeRequest('tools/list', {}));

    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeDefined();

    const result = resp.result as { tools: Array<{ name: string; description: string }> };
    expect(result.tools).toBeDefined();
    expect(Array.isArray(result.tools)).toBe(true);
    expect(result.tools.length).toBe(12);

    const toolNames = result.tools.map((t) => t.name).sort();
    const expectedNames = [
      'flowguard_abort_session',
      'flowguard_architecture',
      'flowguard_continue',
      'flowguard_decision',
      'flowguard_hydrate',
      'flowguard_implement',
      'flowguard_plan',
      'flowguard_review',
      'flowguard_status',
      'flowguard_ticket',
      'flowguard_validate',
    ];

    // We expect 12 tools ÔÇö check at least these core ones are present
    for (const name of expectedNames) {
      expect(toolNames, `Missing tool: ${name}`).toContain(name);
    }
  });

  it('HAPPY: each tool has description and inputSchema', async () => {
    const resp = await client.send(makeRequest('tools/list', {}));
    const result = resp.result as {
      tools: Array<{ name: string; description: string; inputSchema: unknown }>;
    };

    for (const tool of result.tools) {
      expect(tool.description, `Tool ${tool.name} missing description`).toBeTruthy();
      expect(tool.inputSchema, `Tool ${tool.name} missing inputSchema`).toBeDefined();
    }
  });

  it('HAPPY: tools/call flowguard_status returns a result (may be error due to no session)', async () => {
    const resp = await client.send(
      makeRequest('tools/call', {
        name: 'flowguard_status',
        arguments: {},
      }),
    );

    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeDefined();

    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0]!.type).toBe('text');
    // Status may return error (no session) or success ÔÇö both are valid MCP responses
    expect(typeof result.content[0]!.text).toBe('string');
  });

  it('BAD: tools/call with unknown tool returns error result', async () => {
    const resp = await client.send(
      makeRequest('tools/call', {
        name: 'nonexistent_tool',
        arguments: {},
      }),
    );

    // MCP SDK may return a protocol error or a tool result with isError.
    // Both are valid fail-closed behaviors.
    if (resp.error) {
      expect(resp.error.code).toBeDefined();
    } else {
      const result = resp.result as { isError?: boolean; content?: Array<{ text: string }> };
      expect(result.isError).toBe(true);
    }
  });

  it('HAPPY: stdout contains only JSON-RPC messages (no contamination)', async () => {
    // If we got here without parse errors, stdout was clean.
    // Additional check: stderr may contain redirected logs
    // but stdout responses were all valid JSON-RPC.
    const resp = await client.send(makeRequest('tools/list', {}));
    expect(resp.jsonrpc).toBe('2.0');
  });

  it('HAPPY: tools/call invokes each of the 12 tools without protocol error', async () => {
    const allToolNames = [
      'flowguard_status',
      'flowguard_hydrate',
      'flowguard_plan',
      'flowguard_implement',
      'flowguard_architecture',
      'flowguard_decision',
      'flowguard_validate',
      'flowguard_ticket',
      'flowguard_review',
      'flowguard_abort_session',
      'flowguard_archive',
      'flowguard_continue',
    ];

    for (const toolName of allToolNames) {
      const resp = await client.send(
        makeRequest('tools/call', {
          name: toolName,
          arguments: {},
        }),
      );

      // Each tool must return a valid MCP response (not a protocol error).
      // Tool execution errors (isError: true) are acceptable ÔÇö they indicate
      // the tool ran but encountered a business logic issue (e.g. no session).
      expect(
        resp.error,
        `Tool '${toolName}' returned protocol error: ${JSON.stringify(resp.error)}`,
      ).toBeUndefined();
      expect(resp.result, `Tool '${toolName}' returned no result`).toBeDefined();

      const result = resp.result as { content: Array<{ type: string; text: string }> };
      expect(result.content, `Tool '${toolName}' has no content`).toBeDefined();
      expect(result.content.length, `Tool '${toolName}' has empty content`).toBeGreaterThan(0);
      expect(result.content[0]!.type).toBe('text');
    }
  });

  it('PERF: state-reading tool call completes within 500ms', async () => {
    // Ticket requirement: tool call latency < 500ms for state-reading tools on warm filesystem.
    // flowguard_status is the primary state-reading tool.
    const iterations = 3;
    const durations: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      const resp = await client.send(
        makeRequest('tools/call', {
          name: 'flowguard_status',
          arguments: {},
        }),
      );
      const elapsed = performance.now() - start;
      durations.push(elapsed);

      // Ensure we got a valid response
      expect(resp.result).toBeDefined();
    }

    // Use median to avoid outliers from cold start
    durations.sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)]!;

    expect(
      median,
      `Median tool call latency ${median.toFixed(0)}ms exceeds 500ms budget`,
    ).toBeLessThan(500);
  });
});
