/**
 * @module mcp-server/tool-adapter
 * @description Bridges FlowGuard ToolDefinition objects to MCP tool handlers.
 *
 * Responsibilities:
 * - Registers all 12 FlowGuard tools with the MCP server
 * - Builds ToolContext for each tool call from MCP request context
 * - Maps ToolResult (string | {output, metadata}) ÔåÆ MCP CallToolResult
 * - Validates args via Zod before delegation (fail-closed on invalid input)
 * - Maps errors to MCP isError responses with diagnostic codes
 *
 * Layer: mcp-server (entry point layer, may import from integration/)
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/243
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../integration/tools/helpers.js';
import { convertArgsToInputSchema } from './schema-converter.js';
import type { McpSessionContext } from './session-resolver.js';

// ÔöÇÔöÇÔöÇ Tool Registry ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

/** All FlowGuard tool definitions keyed by their MCP tool name. */
export interface FlowGuardToolRegistry {
  readonly [name: string]: ToolDefinition;
}

// ÔöÇÔöÇÔöÇ Result Conversion ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

/**
 * Convert a FlowGuard ToolResult to an MCP CallToolResult.
 * Handles both string and {output, metadata} shapes.
 */
function toMcpResult(result: ToolResult): CallToolResult {
  const text = typeof result === 'string' ? result : result.output;
  return {
    content: [{ type: 'text', text }],
    isError: false,
  };
}

/**
 * Create an MCP error result with diagnostic information.
 */
function toMcpError(code: string, message: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: true, code, message }),
      },
    ],
    isError: true,
  };
}

// ÔöÇÔöÇÔöÇ Tool Registration ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

/**
 * Register all FlowGuard tools with the MCP server.
 *
 * Each tool is registered with:
 * - Name prefixed with `flowguard_`
 * - Description from the ToolDefinition
 * - Input schema from the ToolDefinition args (Zod shape, handled by SDK)
 * - Handler that builds ToolContext and delegates to execute()
 *
 * @param server - MCP server instance
 * @param tools - FlowGuard tool registry (name ÔåÆ ToolDefinition)
 * @param resolveContext - Resolves session context for the current call
 */
export function registerAllTools(
  server: McpServer,
  tools: FlowGuardToolRegistry,
  resolveContext: () => McpSessionContext,
): void {
  for (const [name, toolDef] of Object.entries(tools)) {
    const mcpName = `flowguard_${name}`;
    const inputSchema = convertArgsToInputSchema(toolDef.args);

    server.registerTool(
      mcpName,
      {
        description: toolDef.description,
        inputSchema,
      },
      async (args: Record<string, unknown>, extra) => {
        const sessionCtx = resolveContext();

        // Build ToolContext compatible with FlowGuard tool execute() signature
        const toolContext: ToolContext = {
          sessionID: `mcp-${Date.now()}`,
          messageID: `mcp-msg-${Date.now()}`,
          agent: 'mcp-client',
          directory: sessionCtx.directory,
          worktree: sessionCtx.worktree,
          abort: extra.signal ?? new AbortController().signal,
          metadata: () => {
            /* MCP: metadata is embedded in text output */
          },
        };

        try {
          const result = await toolDef.execute(args, toolContext);
          return toMcpResult(result);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);

          // Extract FlowGuard error code if available
          const code = extractErrorCode(err) ?? 'TOOL_EXECUTION_ERROR';
          return toMcpError(code, message);
        }
      },
    );
  }
}

// ÔöÇÔöÇÔöÇ Error Code Extraction ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

/**
 * Extract a FlowGuard diagnostic code from an error.
 * FlowGuard enforcement errors embed codes in the message or as properties.
 */
function extractErrorCode(err: unknown): string | undefined {
  if (err === null || err === undefined) return undefined;
  if (typeof err === 'object') {
    const record = err as Record<string, unknown>;
    if (typeof record['code'] === 'string') return record['code'];
  }
  if (err instanceof Error) {
    // FlowGuard errors often contain [CODE] prefix in message
    const match = /\[([A-Z_]+)\]/.exec(err.message);
    if (match) return match[1];
  }
  return undefined;
}
