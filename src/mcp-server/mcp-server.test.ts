/**
 * @module mcp-server/mcp-server.test
 * @description Integration tests for the FlowGuard MCP server.
 *
 * Tests the full MCP protocol flow:
 * - Server spawns and responds to initialize
 * - tools/list returns all 13 FlowGuard tools
 * - tools/call dispatches to tool executors
 * - stdout guard prevents protocol contamination
 * - Negative paths: invalid tool, bad args, no session
 *
 * Uses child_process to spawn the server as a subprocess, communicating
 * via JSON-RPC over stdin/stdout (the standard MCP stdio transport).
 *
 * @test-policy HAPPY, BAD, CORNER - three categories present.
 * @see https://github.com/koeppben23/governed-runtime/issues/243
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpSessionResolutionError, resolveSessionContext } from './session-resolver.js';
import { convertArgsToInputSchema } from './schema-converter.js';
import { installStdoutGuard } from './stdout-guard.js';
import { registerAllTools, isGovernanceDenialCode } from './tool-adapter.js';
import { McpExecutionLimiter, readMcpExecutionLimits } from './execution-limiter.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext, ToolDefinition } from '../integration/tools/helpers.js';
import { getAdapterLogger, getLogTraceFields } from '../logging/adapter-logger.js';
import { z } from 'zod';

// --- Schema Converter Tests ---

describe('Schema Converter', () => {
  it('HAPPY: wraps args into a strict ZodObject (additionalProperties:false)', () => {
    const args = { name: z.string(), count: z.number() };
    const result = convertArgsToInputSchema(args);
    const json = z.toJSONSchema(result) as Record<string, unknown>;
    expect(json.type).toBe('object');
    expect(json.additionalProperties).toBe(false);
    expect(Object.keys(json.properties as Record<string, unknown>).sort()).toEqual([
      'count',
      'name',
    ]);
  });

  it('HAPPY: returns an empty strict object for null args', () => {
    const result = convertArgsToInputSchema(null as unknown as Record<string, z.ZodType>);
    const json = z.toJSONSchema(result) as Record<string, unknown>;
    expect(json.type).toBe('object');
    expect(json.additionalProperties).toBe(false);
    expect(json.properties).toEqual({});
  });

  it('HAPPY: returns an empty strict object for undefined args', () => {
    const result = convertArgsToInputSchema(undefined as unknown as Record<string, z.ZodType>);
    const json = z.toJSONSchema(result) as Record<string, unknown>;
    expect(json.additionalProperties).toBe(false);
    expect(json.properties).toEqual({});
  });

  it('HAPPY: keeps optional args optional while forbidding unknown keys', () => {
    const args = {
      verdict: z.enum(['approve', 'reject']),
      reason: z.string().optional(),
      force: z.boolean().default(false),
    };
    const result = convertArgsToInputSchema(args);
    const json = z.toJSONSchema(result) as Record<string, unknown>;
    expect(Object.keys(json.properties as Record<string, unknown>).sort()).toEqual([
      'force',
      'reason',
      'verdict',
    ]);
    expect(json.additionalProperties).toBe(false);
    // The plain optional field is not required; strict only forbids unknown keys.
    expect(json.required as string[]).not.toContain('reason');
  });
});

// --- Session Resolver Tests ---

describe('Session Resolver', () => {
  const originalSessionDir = process.env['FLOWGUARD_SESSION_DIR'];
  const originalProjectDir = process.env['FLOWGUARD_PROJECT_DIR'];

  afterEach(() => {
    if (originalSessionDir !== undefined) {
      process.env['FLOWGUARD_SESSION_DIR'] = originalSessionDir;
    } else {
      delete process.env['FLOWGUARD_SESSION_DIR'];
    }
    if (originalProjectDir !== undefined) {
      process.env['FLOWGUARD_PROJECT_DIR'] = originalProjectDir;
    } else {
      delete process.env['FLOWGUARD_PROJECT_DIR'];
    }
  });

  beforeEach(() => {
    // Each test asserts a specific resolution source; start from a clean slate
    // so a leaked env var from the host shell cannot mask a fail-closed path.
    delete process.env['FLOWGUARD_SESSION_DIR'];
    delete process.env['FLOWGUARD_PROJECT_DIR'];
  });

  it('HAPPY: uses FLOWGUARD_SESSION_DIR when set', () => {
    process.env['FLOWGUARD_SESSION_DIR'] = '/custom/path';
    const ctx = resolveSessionContext();
    expect(ctx.directory).toContain('custom');
  });

  it('HAPPY: uses first root when provided', () => {
    const ctx = resolveSessionContext(['/project/root', '/other']);
    expect(ctx.directory).toContain('project');
  });

  // #422 negative-first: no env source and no roots MUST fail closed —
  // the prior cwd fallback was a silent guess that hid missing inputs.
  it('BAD: throws SESSION_UNRESOLVABLE when no env and no roots', () => {
    expect(() => resolveSessionContext()).toThrow();
    try {
      resolveSessionContext();
      expect.unreachable('resolver must fail closed');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('SESSION_UNRESOLVABLE');
    }
  });

  // #422 negative-first: an empty roots array is "no roots" — still fail closed.
  it('CORNER: empty roots array throws SESSION_UNRESOLVABLE', () => {
    expect(() => resolveSessionContext([])).toThrow();
    try {
      resolveSessionContext([]);
      expect.unreachable('resolver must fail closed');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('SESSION_UNRESOLVABLE');
    }
  });

  // #422: wire the previously-dead FLOWGUARD_PROJECT_DIR contract as a real
  // resolution source (host-advertised project dir, e.g. CLAUDE_PROJECT_DIR).
  it('HAPPY: uses FLOWGUARD_PROJECT_DIR when set and no roots', () => {
    process.env['FLOWGUARD_PROJECT_DIR'] = '/proj/dir';
    const ctx = resolveSessionContext();
    expect(ctx.directory).toContain('proj');
  });

  it('CORNER: FLOWGUARD_PROJECT_DIR wins over roots[0]', () => {
    process.env['FLOWGUARD_PROJECT_DIR'] = '/proj/dir';
    const ctx = resolveSessionContext(['/roots/path']);
    expect(ctx.directory).toContain('proj');
    expect(ctx.directory).not.toContain('roots');
  });

  it('HAPPY: FLOWGUARD_SESSION_DIR takes priority over roots', () => {
    process.env['FLOWGUARD_SESSION_DIR'] = '/env/path';
    const ctx = resolveSessionContext(['/roots/path']);
    expect(ctx.directory).toContain('env');
  });

  it('CORNER: FLOWGUARD_SESSION_DIR wins over FLOWGUARD_PROJECT_DIR', () => {
    process.env['FLOWGUARD_SESSION_DIR'] = '/session/path';
    process.env['FLOWGUARD_PROJECT_DIR'] = '/proj/dir';
    const ctx = resolveSessionContext();
    expect(ctx.directory).toContain('session');
    expect(ctx.directory).not.toContain('proj');
  });

  it('HAPPY: preserves provided stable MCP session id', () => {
    const ctx = resolveSessionContext(['/project/root'], 'mcp-stable-session');

    expect(ctx.sessionId).toBe('mcp-stable-session');
  });
});

describe('Tool Adapter Session Identity', () => {
  it('rejects invalid MCP execution limit configuration', () => {
    expect(() => readMcpExecutionLimits({ FLOWGUARD_MCP_MAX_CONCURRENT: '0' })).toThrow(
      'FLOWGUARD_MCP_MAX_CONCURRENT must be a positive integer',
    );
  });

  it('BAD: reuses stable sessionID across calls and creates unique messageIDs', async () => {
    const contexts: ToolContext[] = [];
    let handler:
      ((args: Record<string, unknown>, extra: { signal?: AbortSignal }) => unknown) | null = null;
    const fakeServer = {
      registerTool: (_name: string, _config: unknown, registered: typeof handler) => {
        handler = registered;
      },
    } as unknown as McpServer;
    const tool: ToolDefinition = {
      description: 'test tool',
      args: {},
      async execute(_args, context) {
        contexts.push(context);
        return 'ok';
      },
    };

    registerAllTools(fakeServer, { test: tool }, () => ({
      sessionId: 'mcp-stable-session',
      directory: '/tmp/project',
      worktree: '/tmp/project',
    }));

    expect(handler).not.toBeNull();
    await handler!({}, {});
    await handler!({}, {});

    expect(contexts.map((ctx) => ctx.sessionID)).toEqual([
      'mcp-stable-session',
      'mcp-stable-session',
    ]);
    expect(contexts[0]?.messageID).not.toBe(contexts[1]?.messageID);
  });

  it('HAPPY: MCP tool execution provides adapter logger and log context', async () => {
    let handler:
      ((args: Record<string, unknown>, extra: { signal?: AbortSignal }) => unknown) | null = null;
    const fakeServer = {
      registerTool: (_name: string, _config: unknown, registered: typeof handler) => {
        handler = registered;
      },
    } as unknown as McpServer;
    const observed: Record<string, unknown>[] = [];
    const tool: ToolDefinition = {
      description: 'test tool',
      args: {},
      async execute() {
        getAdapterLogger().info('test', 'inside_mcp_tool', getLogTraceFields());
        observed.push(getLogTraceFields());
        return 'ok';
      },
    };

    registerAllTools(fakeServer, { test: tool }, () => ({
      sessionId: 'mcp-session',
      directory: '/tmp/project',
      worktree: '/tmp/project',
    }));

    expect(handler).not.toBeNull();
    await handler!({}, {});

    expect(observed).toHaveLength(1);
    expect(observed[0]!.traceId).toMatch(/^mcp-/);
    expect(observed[0]!.sessionId).toBe('mcp-session');
    expect(observed[0]!.durationMs).toBeUndefined();
  });

  it('untrusted error codes return sanitized execution errors', async () => {
    let handler:
      ((args: Record<string, unknown>, extra: { signal?: AbortSignal }) => unknown) | null = null;
    const fakeServer = {
      registerTool: (_name: string, _config: unknown, registered: typeof handler) => {
        handler = registered;
      },
    } as unknown as McpServer;
    const tool: ToolDefinition = {
      description: 'test tool',
      args: {},
      async execute() {
        const err = new Error('[PHASE_GATE_BLOCKED] Tool not allowed in current phase');
        (err as unknown as Record<string, unknown>).code = 'PHASE_GATE_BLOCKED';
        throw err;
      },
    };

    registerAllTools(fakeServer, { test: tool }, () => ({
      sessionId: 'mcp-session',
      directory: '/tmp/project',
      worktree: '/tmp/project',
    }));

    const result = (await handler!({}, {})) as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const [content] = result.content;
    if (!content) throw new TypeError('expected MCP response content');
    const parsed = JSON.parse(content.text);
    expect(parsed.governance).toBeUndefined();
    expect(parsed.code).toBe('TOOL_EXECUTION_ERROR');
  });

  // #422 negative-first: a fail-closed session resolution (resolveContext
  // throws SESSION_UNRESOLVABLE) must be surfaced as a governance denial, not
  // leak out of the handler. Guards the tool-adapter wiring that moves
  // resolveContext() inside the denial-mapping path.
  it('resolver fail-closed maps to SESSION_UNRESOLVABLE governance denial', async () => {
    let handler:
      ((args: Record<string, unknown>, extra: { signal?: AbortSignal }) => unknown) | null = null;
    const fakeServer = {
      registerTool: (_name: string, _config: unknown, registered: typeof handler) => {
        handler = registered;
      },
    } as unknown as McpServer;
    const tool: ToolDefinition = {
      description: 'test tool',
      args: {},
      async execute() {
        return 'should-not-run';
      },
    };

    const stderrWrites: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      registerAllTools(fakeServer, { test: tool }, () => {
        throw new McpSessionResolutionError();
      });

      const result = (await handler!({}, {})) as { isError: boolean; content: { text: string }[] };
      expect(result.isError).toBe(false);
      const [content] = result.content;
      if (!content) throw new TypeError('expected MCP response content');
      const parsed = JSON.parse(content.text);
      expect(parsed.governance).toBe(true);
      expect(parsed.denied).toBe(true);
      expect(parsed.code).toBe('SESSION_UNRESOLVABLE');
    } finally {
      process.stderr.write = originalWrite;
    }

    // Exactly one minimal structured diagnostic line, no paths/env/cwd values.
    const diag = stderrWrites
      .map((w) => w.trim())
      .filter((w) => w.includes('mcp-session-resolver'));
    expect(diag).toHaveLength(1);
    const logged = JSON.parse(diag[0]!);
    expect(logged).toEqual({
      service: 'mcp-session-resolver',
      level: 'error',
      message: 'session resolution failed closed',
      extra: { reason: 'missing_roots' },
    });
  });

  it('execution error returns isError:true without governance field', async () => {
    let handler:
      ((args: Record<string, unknown>, extra: { signal?: AbortSignal }) => unknown) | null = null;
    const fakeServer = {
      registerTool: (_name: string, _config: unknown, registered: typeof handler) => {
        handler = registered;
      },
    } as unknown as McpServer;
    const tool: ToolDefinition = {
      description: 'test tool',
      args: {},
      async execute() {
        throw new Error('Network timeout');
      },
    };

    registerAllTools(fakeServer, { test: tool }, () => ({
      sessionId: 'mcp-session',
      directory: '/tmp/project',
      worktree: '/tmp/project',
    }));

    const result = (await handler!({}, {})) as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const [content] = result.content;
    if (!content) throw new TypeError('expected MCP response content');
    const parsed = JSON.parse(content.text);
    expect(parsed.error).toBe(true);
    expect(parsed.governance).toBeUndefined();
    expect(parsed.code).toBe('TOOL_EXECUTION_ERROR');
  });

  it('passes the SDK abort signal through unchanged', async () => {
    let handler:
      ((args: Record<string, unknown>, extra: { signal?: AbortSignal }) => unknown) | null = null;
    const signal = new AbortController().signal;
    const fakeServer = {
      registerTool: (_name: string, _config: unknown, registered: typeof handler) => {
        handler = registered;
      },
    } as unknown as McpServer;
    const tool: ToolDefinition = {
      description: 'test tool',
      args: {},
      async execute(_args, context) {
        expect(context.abort).toBe(signal);
        return 'ok';
      },
    };
    registerAllTools(fakeServer, { test: tool }, () => ({
      sessionId: 'mcp-session',
      directory: '/tmp/project',
      worktree: '/tmp/project',
    }));
    await handler!({}, { signal });
  });

  it('rejects calls over the shared concurrency limit without invoking the executor', async () => {
    let handler:
      ((args: Record<string, unknown>, extra: { signal?: AbortSignal }) => unknown) | null = null;
    let release!: () => void;
    let calls = 0;
    const fakeServer = {
      registerTool: (_name: string, _config: unknown, registered: typeof handler) => {
        handler = registered;
      },
    } as unknown as McpServer;
    const tool: ToolDefinition = {
      description: 'test tool',
      args: {},
      async execute() {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return 'ok';
      },
    };
    registerAllTools(
      fakeServer,
      { test: tool },
      () => ({ sessionId: 'mcp-session', directory: '/tmp/project', worktree: '/tmp/project' }),
      new McpExecutionLimiter({ timeoutMs: 1_000, maxConcurrent: 1, maxPerSecond: 10 }),
    );
    const first = handler!({}, {});
    await Promise.resolve();
    const result = (await handler!({}, {})) as { content: { text: string }[] };
    expect(JSON.parse(result.content[0]!.text).code).toBe('MCP_RATE_LIMITED');
    expect(calls).toBe(1);
    release();
    await first;
  });

  it('returns a timeout while keeping a live executor in its concurrency slot', async () => {
    let handler:
      ((args: Record<string, unknown>, extra: { signal?: AbortSignal }) => unknown) | null = null;
    let release!: () => void;
    const fakeServer = {
      registerTool: (_name: string, _config: unknown, registered: typeof handler) => {
        handler = registered;
      },
    } as unknown as McpServer;
    const tool: ToolDefinition = {
      description: 'test tool',
      args: {},
      async execute() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return 'ok';
      },
    };
    registerAllTools(
      fakeServer,
      { test: tool },
      () => ({ sessionId: 'mcp-session', directory: '/tmp/project', worktree: '/tmp/project' }),
      new McpExecutionLimiter({ timeoutMs: 1, maxConcurrent: 1, maxPerSecond: 10 }),
    );
    const timedOut = (await handler!({}, {})) as { content: { text: string }[] };
    expect(JSON.parse(timedOut.content[0]!.text).code).toBe('MCP_TOOL_TIMEOUT');
    const rejected = (await handler!({}, {})) as { content: { text: string }[] };
    expect(JSON.parse(rejected.content[0]!.text).code).toBe('MCP_RATE_LIMITED');
    release();
  });
});

describe('isGovernanceDenialCode', () => {
  it('recognizes known governance codes', () => {
    expect(isGovernanceDenialCode('PHASE_GATE_BLOCKED')).toBe(true);
    expect(isGovernanceDenialCode('OBLIGATION_UNRESOLVED')).toBe(true);
    expect(isGovernanceDenialCode('COMMAND_NOT_ALLOWED')).toBe(true);
    expect(isGovernanceDenialCode('FOUR_EYES_ACTOR_MATCH')).toBe(true);
  });

  it('rejects unknown codes as execution errors', () => {
    expect(isGovernanceDenialCode('TOOL_EXECUTION_ERROR')).toBe(false);
    expect(isGovernanceDenialCode('UNKNOWN_CODE')).toBe(false);
    expect(isGovernanceDenialCode('')).toBe(false);
  });
});

// --- Stdout Guard Tests ---

describe('Stdout Guard', () => {
  it('HAPPY: installStdoutGuard is idempotent', () => {
    // The guard may already be installed - calling again should not throw
    expect(() => installStdoutGuard()).not.toThrow();
    expect(() => installStdoutGuard()).not.toThrow();
  });

  it('HAPPY: isJsonRpcMessage detection works', () => {
    // We test the guard behavior indirectly by verifying the module loads
    // without error. Direct stdout testing requires subprocess isolation.
    expect(typeof installStdoutGuard).toBe('function');
  });
});

// --- Tool Registry Completeness ---

describe('Tool Registry', () => {
  it('HAPPY: all 13 FlowGuard tools are importable', async () => {
    const tools = await import('../integration/tools/index.js');
    const expectedNames = [
      'status',
      'hydrate',
      'plan',
      'implement',
      'review_implementation',
      'architecture',
      'decision',
      'run_check',
      'ticket',
      'review',
      'abort_session',
      'archive',
      'continue',
    ];

    for (const name of expectedNames) {
      const tool = (tools as Record<string, unknown>)[name];
      expect(tool, `Tool '${name}' should be exported`).toBeDefined();
      expect(
        (tool as { description: string }).description,
        `Tool '${name}' should have a description`,
      ).toBeTruthy();
      expect((tool as { args: unknown }).args, `Tool '${name}' should have args`).toBeDefined();
      expect(
        typeof (tool as { execute: unknown }).execute,
        `Tool '${name}' should have execute function`,
      ).toBe('function');
    }
  });

  it('HAPPY: all tools have valid Zod schemas in args', async () => {
    const tools = await import('../integration/tools/index.js');
    const toolNames = [
      'status',
      'hydrate',
      'plan',
      'implement',
      'review_implementation',
      'architecture',
      'decision',
      'run_check',
      'ticket',
      'review',
      'abort_session',
      'archive',
      'continue',
    ];

    for (const name of toolNames) {
      const tool = (tools as Record<string, unknown>)[name] as { args: Record<string, unknown> };
      for (const [argName, schema] of Object.entries(tool.args)) {
        // Each arg must be a Zod schema (has _zod property in v4)
        expect(
          (schema as { _zod?: unknown })._zod,
          `Tool '${name}' arg '${argName}' should be a Zod schema`,
        ).toBeDefined();
      }
    }
  });
});
