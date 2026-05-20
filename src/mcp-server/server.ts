/**
 * @module mcp-server/server
 * @description FlowGuard MCP Server ÔÇö universal tool surface for any MCP-compatible
 * AI coding agent (Claude Code, Codex, or future platforms).
 *
 * Architecture:
 * - stdio transport (JSON-RPC over stdin/stdout)
 * - stdout guard: non-MCP writes redirected to stderr (defense-in-depth)
 * - Stateless: all state on filesystem, crash-safe restart
 * - Delegates to same rail executors as the OpenCode plugin
 *
 * The server exposes all 12 FlowGuard governance tools via the MCP protocol.
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/243
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools, type FlowGuardToolRegistry } from './tool-adapter.js';
import { resolveSessionContext } from './session-resolver.js';
import { installStdoutGuard } from './stdout-guard.js';

// ÔöÇÔöÇÔöÇ Tool Imports ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

import { status } from '../integration/tools/index.js';
import { hydrate } from '../integration/tools/index.js';
import { plan } from '../integration/tools/index.js';
import { implement } from '../integration/tools/index.js';
import { architecture } from '../integration/tools/index.js';
import { decision } from '../integration/tools/index.js';
import { validate } from '../integration/tools/index.js';
import { ticket } from '../integration/tools/index.js';
import { review } from '../integration/tools/index.js';
import { abort_session } from '../integration/tools/index.js';
import { archive } from '../integration/tools/index.js';
// 'continue' is a reserved word ÔÇö imported via namespace
import { continue as continue_cmd } from '../integration/tools/index.js';

// ÔöÇÔöÇÔöÇ Tool Registry ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

const FLOWGUARD_TOOLS: FlowGuardToolRegistry = {
  status,
  hydrate,
  plan,
  implement,
  architecture,
  decision,
  validate,
  ticket,
  review,
  abort_session,
  archive,
  continue: continue_cmd,
};

// ÔöÇÔöÇÔöÇ Server Factory ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

/** FlowGuard package version (injected at build time or read from package.json). */
const SERVER_VERSION = '1.2.0-rc.3';

/**
 * Create and configure the FlowGuard MCP server.
 *
 * Does NOT start the transport ÔÇö call `start()` on the returned object.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'flowguard',
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: { listChanged: false },
      },
    },
  );

  // Register all 12 FlowGuard tools
  registerAllTools(server, FLOWGUARD_TOOLS, () => {
    // Resolve session context fresh for each tool call.
    // MCP roots are not available in the handler context,
    // so we rely on env + cwd. Roots support via server.server.roots
    // can be added when hosts advertise them.
    return resolveSessionContext();
  });

  return server;
}

/**
 * Start the FlowGuard MCP server on stdio transport.
 *
 * This function:
 * 1. Installs the stdout guard (redirect non-MCP writes ÔåÆ stderr)
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
  await server.connect(transport);

  // The server runs until the transport is closed by the host.
  // No explicit keep-alive needed ÔÇö the transport handles stdin reading.
}
