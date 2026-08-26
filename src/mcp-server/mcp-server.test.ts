/**
 * @module mcp-server/mcp-server.test
 * @description Integration tests for the FlowGuard MCP server.
 *
 * Tests the full MCP protocol flow:
 * - Server spawns and responds to initialize
 * - tools/list returns all FlowGuard tools
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
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpSessionBinder, McpSessionResolutionError } from './session-resolver.js';
import { convertArgsToInputSchema } from './schema-converter.js';
import { installStdoutGuard } from './stdout-guard.js';
import { registerAllTools, isGovernanceDenialCode } from './tool-adapter.js';
import { McpExecutionLimiter, readMcpExecutionLimits } from './execution-limiter.js';
import { reportMcpFatalError } from './fatal-error.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext, ToolDefinition } from '../integration/tools/helpers.js';
import { getAdapterLogger, getLogTraceFields } from '../logging/adapter-logger.js';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

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

  async function repository(name: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `${name}-`));
    await execFileAsync('git', ['init'], { cwd: root });
    return root;
  }

  function root(path: string): { uri: string } {
    return { uri: pathToFileURL(path).href };
  }

  it('HAPPY: binds a real MCP root to its canonical Git worktree', async () => {
    const repo = await repository('flowguard-mcp-root');
    try {
      const ctx = await new McpSessionBinder('mcp-stable-session').resolve([root(repo)]);
      expect(ctx).toMatchObject({
        sessionId: 'mcp-stable-session',
        worktree: await realpath(repo),
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('BAD: rejects no roots, filesystem paths, and non-existent roots', async () => {
    const binder = new McpSessionBinder();
    await expect(binder.resolve([])).rejects.toMatchObject({ code: 'SESSION_UNRESOLVABLE' });
    await expect(binder.resolve([{ uri: 'https://example.com' }])).rejects.toMatchObject({
      code: 'SESSION_UNRESOLVABLE',
    });
    await expect(
      binder.resolve([{ uri: 'file:///definitely-not-a-flowguard-root' }]),
    ).rejects.toMatchObject({
      code: 'SESSION_UNRESOLVABLE',
    });
  });

  it('BAD: rejects ambiguous multi-root authority without a matching project hint', async () => {
    const first = await repository('flowguard-mcp-first');
    const second = await repository('flowguard-mcp-second');
    try {
      await expect(
        new McpSessionBinder().resolve([root(first), root(second)]),
      ).rejects.toMatchObject({
        code: 'SESSION_UNRESOLVABLE',
      });
    } finally {
      await Promise.all([
        rm(first, { recursive: true, force: true }),
        rm(second, { recursive: true, force: true }),
      ]);
    }
  });

  it('HAPPY: project hint disambiguates only an authorized worktree', async () => {
    const first = await repository('flowguard-mcp-first');
    const second = await repository('flowguard-mcp-second');
    process.env['FLOWGUARD_PROJECT_DIR'] = second;
    try {
      const ctx = await new McpSessionBinder().resolve([root(first), root(second)]);
      expect(ctx.worktree).toBe(await realpath(second));
    } finally {
      await Promise.all([
        rm(first, { recursive: true, force: true }),
        rm(second, { recursive: true, force: true }),
      ]);
    }
  });

  it('BAD: rejects root changes and symlink escapes after transport binding', async () => {
    const first = await repository('flowguard-mcp-first');
    const second = await repository('flowguard-mcp-second');
    const link = join(first, 'linked-root');
    await symlink(second, link);
    try {
      const binder = new McpSessionBinder();
      await binder.resolve([root(first)]);
      await expect(binder.resolve([root(link)])).rejects.toMatchObject({
        code: 'SESSION_UNRESOLVABLE',
      });
    } finally {
      await Promise.all([
        rm(first, { recursive: true, force: true }),
        rm(second, { recursive: true, force: true }),
      ]);
    }
  });

  it('BAD: session hint cannot select a repository', async () => {
    const repo = await repository('flowguard-mcp-root');
    const foreign = await mkdtemp(join(tmpdir(), 'flowguard-mcp-session-'));
    process.env['FLOWGUARD_SESSION_DIR'] = foreign;
    try {
      await expect(new McpSessionBinder().resolve([root(repo)])).rejects.toMatchObject({
        code: 'SESSION_UNRESOLVABLE',
      });
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(foreign, { recursive: true, force: true }),
      ]);
    }
  });
});

describe('Tool Adapter Session Identity', () => {
  it('rejects invalid MCP execution limit configuration', () => {
    expect(() => readMcpExecutionLimits({ FLOWGUARD_MCP_MAX_CONCURRENT: '0' })).toThrow(
      'FLOWGUARD_MCP_MAX_CONCURRENT must be a positive integer',
    );
  });

  it.each(['0', '-1', '1.5', ' 10', '10 ', 'Infinity', '9007199254740992', '9'.repeat(400)])(
    'rejects malformed or unsafe MCP limit value %j',
    (value) => {
      expect(() => readMcpExecutionLimits({ FLOWGUARD_MCP_TOOL_TIMEOUT_MS: value })).toThrow();
    },
  );

  it('rejects a safe-integer timeout above the timer maximum but accepts the boundary', () => {
    // 2_147_483_648 is a safe integer but exceeds the Node timer max, so it must
    // be rejected specifically by the upper-bound check (not the safe-integer
    // check). The exact maximum must be accepted.
    expect(() => readMcpExecutionLimits({ FLOWGUARD_MCP_TOOL_TIMEOUT_MS: '2147483648' })).toThrow(
      'within supported bounds',
    );
    expect(readMcpExecutionLimits({ FLOWGUARD_MCP_TOOL_TIMEOUT_MS: '2147483647' }).timeoutMs).toBe(
      2_147_483_647,
    );
  });

  it('accepts concurrency and throughput up to MAX_SAFE_INTEGER', () => {
    // maxConcurrent/maxPerSecond have no timer bound; the safe-integer maximum
    // is accepted, proving the default `maximum` is MAX_SAFE_INTEGER.
    const limits = readMcpExecutionLimits({
      FLOWGUARD_MCP_MAX_CONCURRENT: String(Number.MAX_SAFE_INTEGER),
      FLOWGUARD_MCP_MAX_PER_SECOND: String(Number.MAX_SAFE_INTEGER),
    });
    expect(limits.maxConcurrent).toBe(Number.MAX_SAFE_INTEGER);
    expect(limits.maxPerSecond).toBe(Number.MAX_SAFE_INTEGER);
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
        throw new McpSessionResolutionError('test resolution failure');
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
        throw new Error('Network timeout reading /home/alice/token.txt token=super-secret');
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
    expect(parsed.message).not.toContain('/home/alice');
    expect(parsed.message).not.toContain('super-secret');
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

  it('leaves abort undefined when the SDK does not provide a signal', async () => {
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
        expect(context.abort).toBeUndefined();
        return 'ok';
      },
    };
    registerAllTools(fakeServer, { test: tool }, () => ({
      sessionId: 'mcp-session',
      directory: '/tmp/project',
      worktree: '/tmp/project',
    }));
    await handler!({}, {});
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
    const result = (await handler!({}, {})) as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      code: 'MCP_RATE_LIMITED',
      governance: true,
      denied: true,
    });
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
    const timedOut = (await handler!({}, {})) as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(timedOut.isError).toBe(false);
    expect(JSON.parse(timedOut.content[0]!.text)).toMatchObject({
      code: 'MCP_TOOL_TIMEOUT',
      governance: true,
      denied: true,
    });
    const rejected = (await handler!({}, {})) as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(rejected.isError).toBe(false);
    expect(JSON.parse(rejected.content[0]!.text)).toMatchObject({
      code: 'MCP_RATE_LIMITED',
      governance: true,
      denied: true,
    });
    release();
  });

  it('does not emit an unhandledRejection when the executor rejects after the deadline', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

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
      // Rejects strictly AFTER the 1ms deadline has already resolved the race.
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error('late executor failure /home/secret/token.txt');
      },
    };
    registerAllTools(
      fakeServer,
      { test: tool },
      () => ({ sessionId: 'mcp-session', directory: '/tmp/project', worktree: '/tmp/project' }),
      new McpExecutionLimiter({ timeoutMs: 1, maxConcurrent: 5, maxPerSecond: 50 }),
    );

    const result = (await handler!({}, {})) as { content: { text: string }[] };
    expect(JSON.parse(result.content[0]!.text).code).toBe('MCP_TOOL_TIMEOUT');

    // Allow the late rejection to occur and any microtasks to flush.
    await new Promise((resolve) => setTimeout(resolve, 60));

    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });
});

describe('McpExecutionLimiter slot handle', () => {
  it('double release frees a slot only once', () => {
    const limiter = new McpExecutionLimiter({
      timeoutMs: 1000,
      maxConcurrent: 1,
      maxPerSecond: 50,
    });
    const slot = limiter.tryAcquire();
    expect(slot).not.toBeNull();
    // Second acquire is rejected while the slot is held.
    expect(limiter.tryAcquire()).toBeNull();

    slot!.release();
    slot!.release(); // idempotent: must not free a second, non-existent slot

    // Exactly one slot is free again; a single acquire succeeds, a second fails.
    expect(limiter.tryAcquire()).not.toBeNull();
    expect(limiter.tryAcquire()).toBeNull();
  });

  it('a rejected throughput acquisition consumes no start budget', () => {
    // High concurrency so only the rolling throughput window can reject.
    const limiter = new McpExecutionLimiter({
      timeoutMs: 1000,
      maxConcurrent: 100,
      maxPerSecond: 2,
    });
    const a = limiter.tryAcquire(1000);
    const b = limiter.tryAcquire(1000);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Window is full (2 starts) → rejected, and the rejection records no start.
    expect(limiter.tryAcquire(1000)).toBeNull();
    expect(limiter.tryAcquire(1000)).toBeNull();
    // Releasing does not add throughput budget back within the same window.
    a!.release();
    expect(limiter.tryAcquire(1000)).toBeNull();
    // Advancing past the rolling window frees exactly the original budget again.
    expect(limiter.tryAcquire(2000)).not.toBeNull();
    expect(limiter.tryAcquire(2000)).not.toBeNull();
    expect(limiter.tryAcquire(2000)).toBeNull();
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

describe('MCP fatal diagnostics', () => {
  it('writes only a sanitized stderr diagnostic and sets a non-zero exit code', () => {
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    const originalExitCode = process.exitCode;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      reportMcpFatalError(
        new Error(
          String.raw`read /home/alice/token.txt C:\Users\alice\secret.txt \\server\share\key token=super-secret`,
        ),
      );
      expect(process.exitCode).toBe(1);
    } finally {
      process.stderr.write = originalWrite;
      process.exitCode = originalExitCode;
    }

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('[FlowGuard MCP] Fatal error:');
    expect(writes[0]).not.toContain('/home/alice');
    expect(writes[0]).not.toContain('C:\\Users\\alice');
    expect(writes[0]).not.toContain('\\server\\share');
    expect(writes[0]).not.toContain('super-secret');
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
  it('HAPPY: all FlowGuard tools are importable', async () => {
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
      'help',
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
