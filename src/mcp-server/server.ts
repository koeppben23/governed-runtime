/**
 * @module mcp-server/server
 * @description FlowGuard MCP Server - universal tool surface for any MCP-compatible
 * AI-assisted engineering host (Claude Code, Codex, or future platforms).
 *
 * Architecture:
 * - stdio transport (JSON-RPC over stdin/stdout)
 * - stdout guard: non-MCP writes redirected to stderr (defense-in-depth)
 * - Stateless: all state on filesystem, crash-safe restart
 * - Delegates to same rail executors as the OpenCode plugin
 *
 * The server exposes all 13 FlowGuard governance tools via the MCP protocol.
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/243
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'node:crypto';
import { registerAllTools, type FlowGuardToolRegistry } from './tool-adapter.js';
import { resolveSessionContext } from './session-resolver.js';
import { installStdoutGuard } from './stdout-guard.js';
import { PACKAGE_VERSION } from '../shared/package-version.js';
import { mcpLogger } from './mcp-logger.js';
import { McpExecutionLimiter, readMcpExecutionLimits } from './execution-limiter.js';

// --- Tool Imports ---

import { status } from '../integration/tools/index.js';
import { hydrate } from '../integration/tools/index.js';
import { plan } from '../integration/tools/index.js';
import { implement } from '../integration/tools/index.js';
import { review_implementation } from '../integration/tools/index.js';
import { architecture } from '../integration/tools/index.js';
import { decision } from '../integration/tools/index.js';
import { run_check } from '../integration/tools/index.js';
import { ticket } from '../integration/tools/index.js';
import { review } from '../integration/tools/index.js';
import { abort_session } from '../integration/tools/index.js';
import { archive } from '../integration/tools/index.js';
// 'continue' is a reserved word - imported via namespace
import { continue as continue_cmd } from '../integration/tools/index.js';

// --- Tool Registry ---

const FLOWGUARD_TOOLS: FlowGuardToolRegistry = {
  status,
  hydrate,
  plan,
  implement,
  review_implementation,
  architecture,
  decision,
  run_check,
  ticket,
  review,
  abort_session,
  archive,
  continue: continue_cmd,
};

// --- Server Factory ---

/**
 * Create and configure the FlowGuard MCP server.
 *
 * Does NOT start the transport - call `start()` on the returned object.
 */
export function createMcpServer(): McpServer {
  mcpLogger.info('mcp', 'server_created', { version: PACKAGE_VERSION() });
  const sessionId = `mcp-${randomUUID()}`;
  const server = new McpServer(
    {
      name: 'flowguard',
      version: PACKAGE_VERSION(),
    },
    {
      capabilities: {
        tools: { listChanged: false },
      },
    },
  );
  const limiter = new McpExecutionLimiter(readMcpExecutionLimits());

  // Register all 13 FlowGuard tools
  registerAllTools(
    server,
    FLOWGUARD_TOOLS,
    () => {
      // Resolve session context fresh for each tool call from host-advertised
      // sources (FLOWGUARD_SESSION_DIR / FLOWGUARD_PROJECT_DIR env, or MCP roots).
      // MCP roots/list is not wired here yet, so roots are passed as undefined and
      // the env sources carry resolution. When no source is present the resolver
      // fails closed (SESSION_UNRESOLVABLE) — never a cwd guess.
      return resolveSessionContext(undefined, sessionId);
    },
    limiter,
  );

  return server;
}

/**
 * Start the FlowGuard MCP server on stdio transport.
 *
 * This function:
 * 1. Installs the stdout guard (redirect non-MCP writes -> stderr)
 * 2. Creates the MCP server with all tools registered
 * 3. Connects via stdio transport
 * 4. Blocks until the transport closes
 */
export async function startMcpServer(): Promise<void> {
  // CRITICAL: Install stdout guard before any module can write to stdout.
  // MCP stdio protocol requires stdout exclusively for JSON-RPC messages.
  installStdoutGuard();

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  transport.onerror = (err) => {
    mcpLogger.error('mcp', 'transport_error', {
      errorName: err instanceof Error ? err.name : typeof err,
    });
  };
  await server.connect(transport);

  // The server runs until the transport is closed by the host.
  // No explicit keep-alive needed - the transport handles stdin reading.
}
