#!/usr/bin/env node
/**
 * @module mcp-server/index
 * @description Entry point for the FlowGuard MCP server binary (`flowguard-mcp`).
 *
 * Starts the MCP server on stdio transport, exposing all 12 FlowGuard governance
 * tools to any MCP-compatible AI coding agent.
 *
 * Usage:
 *   npx flowguard-mcp              # direct invocation
 *   # Or via .mcp.json config:     # Claude Code / Codex
 *   { "mcpServers": { "flowguard": { "command": "npx", "args": ["flowguard-mcp"] } } }
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/243
 */

import { startMcpServer } from './server.js';

startMcpServer().catch((err: unknown) => {
  process.stderr.write(
    `[FlowGuard MCP] Fatal error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
});
