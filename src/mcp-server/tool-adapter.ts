/**
 * @module mcp-server/tool-adapter
 * @description Bridges FlowGuard ToolDefinition objects to MCP tool handlers.
 *
 * Responsibilities:
 * - Registers all 12 FlowGuard tools with the MCP server
 * - Builds ToolContext for each tool call from MCP request context
 * - Maps ToolResult (string | {output, metadata}) -> MCP CallToolResult
 * - Validates args via Zod before delegation (fail-closed on invalid input)
 * - Maps errors to MCP isError responses with diagnostic codes
 *
 * Layer: mcp-server (entry point layer, may import from integration/)
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/243
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import type { ToolDefinition, ToolContext, ToolResult } from '../integration/tools/helpers.js';
import { convertArgsToInputSchema } from './schema-converter.js';
import type { McpSessionContext } from './session-resolver.js';

// --- Tool Registry ---

/** All FlowGuard tool definitions keyed by their MCP tool name. */
export interface FlowGuardToolRegistry {
  readonly [name: string]: ToolDefinition;
}

// --- Result Conversion ---

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
 * Used for genuine tool execution failures.
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

/**
 * Create an MCP result for governance denials.
 *
 * Unlike execution errors (isError: true), governance denials use isError: false
 * with structured content. This is semantically correct: the tool was never invoked,
 * so there is no execution error — there is a policy decision.
 *
 * MCP clients can programmatically detect governance denials via the `governance: true`
 * field in the JSON content.
 */
function toMcpDenial(code: string, message: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ governance: true, denied: true, code, message }),
      },
    ],
    isError: false,
  };
}

/**
 * Known FlowGuard governance denial codes.
 * These indicate that the tool was blocked by policy, not that execution failed.
 */
const GOVERNANCE_DENIAL_CODES = new Set([
  'PHASE_GATE_BLOCKED',
  'OBLIGATION_UNRESOLVED',
  'RISK_BLOCKED',
  'RISK_CLASSIFICATION_BLOCKED',
  'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
  'SESSION_UNRESOLVABLE',
  'COMMAND_NOT_ALLOWED',
  'TOOL_BLOCKED_IN_PHASE',
  'FOUR_EYES_ACTOR_MATCH',
  'REGULATED_ACTOR_UNKNOWN',
  'DECISION_IDENTITY_REQUIRED',
  'ACTOR_ASSURANCE_INSUFFICIENT',
  'SUBAGENT_UNAUTHORIZED',
  'HOOK_STDIN_INVALID',
  'HOOK_PAYLOAD_INVALID',
]);

/** @internal */
export function isGovernanceDenialCode(code: string): boolean {
  return GOVERNANCE_DENIAL_CODES.has(code);
}

// --- Arg Sanitization (Gap 1 Mitigation) ---

/**
 * Sanitize tool arguments before execution.
 *
 * Removes null-valued keys that some models (notably DeepSeek R1) inject
 * into tool call arguments. On out-of-process platforms (Claude Code, Codex)
 * we cannot mutate args via PreToolUse hooks, so sanitization happens here
 * in the MCP server layer instead.
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/251 (Gap 1)
 */
export function sanitizeNullArgs(args: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== null) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// --- Tool Registration ---

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
 * @param tools - FlowGuard tool registry (name -> ToolDefinition)
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

        // Sanitize args: strip null values injected by some models (Gap 1 mitigation).
        const cleanArgs = sanitizeNullArgs(args);

        // Build ToolContext compatible with FlowGuard tool execute() signature
        const toolContext: ToolContext = {
          sessionID: sessionCtx.sessionId,
          messageID: `mcp-msg-${randomUUID()}`,
          agent: 'mcp-client',
          directory: sessionCtx.directory,
          worktree: sessionCtx.worktree,
          abort: extra.signal ?? new AbortController().signal,
          metadata: () => {
            /* MCP: metadata is embedded in text output */
          },
        };

        try {
          const result = await toolDef.execute(cleanArgs, toolContext);
          return toMcpResult(result);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);

          // Extract FlowGuard error code if available
          const code = extractErrorCode(err) ?? 'TOOL_EXECUTION_ERROR';

          // Governance denials are policy decisions, not execution errors.
          if (isGovernanceDenialCode(code)) {
            return toMcpDenial(code, message);
          }
          return toMcpError(code, message);
        }
      },
    );
  }
}

// --- Error Code Extraction ---

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
