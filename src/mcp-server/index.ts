#!/usr/bin/env node
/**
 * @module mcp-server/index
 * @description Entry point for the FlowGuard MCP server binary (`flowguard-mcp`).
 *
 * Starts the MCP server on stdio transport, exposing all 12 FlowGuard governance
 * tools to supported MCP-capable hosts.
 *
 * Usage:
 *   npx flowguard-mcp              # direct invocation
 *   # Or via .mcp.json config:     # Claude Code / Codex
 *   { "mcpServers": { "flowguard": { "command": "npx", "args": ["flowguard-mcp"] } } }
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/243
 */

import { startMcpServer } from './server.js';
import { reportMcpFatalError } from './fatal-error.js';

startMcpServer().catch((err: unknown) => {
  reportMcpFatalError(err);
});
