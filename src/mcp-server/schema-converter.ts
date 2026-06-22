/**
 * @module mcp-server/schema-converter
 * @description Converts FlowGuard ToolDefinition arg schemas to a STRICT MCP
 * `inputSchema` so that the published JSON Schema declares
 * `additionalProperties: false`.
 *
 * Why strict (issue #565):
 * The MCP SDK v1.29.0 accepts either a Zod raw shape (`Record<string, ZodType>`)
 * or a full Zod schema via `registerTool({ inputSchema })`. When a raw shape is
 * passed the SDK derives the *input* JSON Schema (Zod `io: 'input'`), which
 * OMITS `additionalProperties` — i.e. the tool surface silently accepts unknown
 * keys. That made multi-mode tool misuse (e.g. sending `reviewVerdict` on an
 * empty `flowguard_implement` record) unrepresentable to reject at the schema
 * layer; the only guard was runtime validation.
 *
 * By wrapping the args in `z.object(args).strict()` and passing that ZodObject
 * as `inputSchema`, the SDK surfaces `additionalProperties: false` in
 * `tools/list`, so MCP hosts that honor `strict` reject unknown keys before the
 * call reaches FlowGuard. Optional args remain optional (strict only forbids
 * UNKNOWN keys; it never marks declared keys as required).
 *
 * This is defense-in-depth: runtime validation still fails closed for hosts
 * that do not enforce `strict`.
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/565
 * @see https://github.com/koeppben23/governed-runtime/issues/243
 */

import { z } from 'zod';

/**
 * A strict Zod object schema suitable for the MCP SDK's `inputSchema` parameter.
 * `.strict()` is what causes the emitted JSON Schema to declare
 * `additionalProperties: false`. The concrete generic config is owned by Zod; we
 * expose the broad `ZodObject` type so call sites stay decoupled from Zod
 * internals.
 */
export type StrictInputSchema = ReturnType<typeof buildStrictObject>;

function buildStrictObject(shape: z.ZodRawShape) {
  return z.object(shape).strict();
}

/**
 * Convert a FlowGuard tool args record into a STRICT Zod object schema for the
 * MCP SDK's `inputSchema` parameter.
 *
 * FlowGuard tools define args as `Record<string, z.ZodType>`. We wrap that shape
 * in `z.object(...).strict()` so the published schema forbids unknown keys
 * (`additionalProperties: false`) while keeping every declared key's optionality
 * intact.
 */
export function convertArgsToInputSchema(args: Record<string, z.ZodType>): StrictInputSchema {
  const shape: z.ZodRawShape = args ?? {};
  return buildStrictObject(shape);
}
