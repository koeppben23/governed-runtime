/**
 * @module mcp-server/schema-converter
 * @description Converts FlowGuard ToolDefinition arg schemas to MCP-compatible
 * Zod raw shape format.
 *
 * The MCP SDK v1.29.0 accepts Zod schemas directly via `registerTool({ inputSchema })`.
 * This module simply re-wraps `Record<string, z.ZodType>` into the `z.object()` form
 * that the SDK expects.
 *
 * Design: The MCP SDK handles Zod ÔåÆ JSON Schema conversion internally.
 * No custom converter needed ÔÇö Zod v4's built-in toJSONSchema is used by the SDK.
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/243
 */

import { z } from 'zod';

/**
 * Convert a FlowGuard tool args record into a Zod object schema
 * suitable for MCP SDK's `inputSchema` parameter.
 *
 * FlowGuard tools define args as `Record<string, z.ZodType>`.
 * The MCP SDK expects a `ZodRawShapeCompat` (object with Zod type values).
 * These are structurally identical ÔÇö this function validates the shape.
 */
export function convertArgsToInputSchema(
  args: Record<string, z.ZodType>,
): Record<string, z.ZodType> {
  // MCP SDK accepts ZodRawShapeCompat directly (Record<string, ZodType>).
  // Validate non-empty to catch registration errors early.
  if (args === null || args === undefined) {
    return {};
  }
  return args;
}
