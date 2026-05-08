/**
 * @module integration/types
 * @description Typed interfaces for the OpenCode plugin hook boundary.
 *
 * The OpenCode SDK passes untyped inputs to plugin hooks.
 * These interfaces provide type-safe access to the commonly used fields.
 *
 * OpenCode docs convention (tool.execute.before):
 *   - `input`: tool name and session metadata (read-only)
 *   - `output`: tool arguments (mutable by the plugin)
 *
 * OpenCode docs convention (tool.execute.after):
 *   - `input`: tool name and session metadata (read-only)
 *   - `output`: tool result string (mutable by the plugin)
 *
 * @see https://opencode.ai/docs/plugins
 * @version v2
 */

/**
 * Plugin hook tool input — typed view of the `input` parameter
 * received by tool.execute.before and tool.execute.after hooks.
 *
 * Per OpenCode docs, `input` carries tool identity and session metadata.
 * Tool arguments live on the `output` parameter in before hooks.
 */
export interface ToolHookInput {
  readonly tool: string;
  readonly sessionID: string;
}

/**
 * Plugin hook before-hook output — typed view of the `output` parameter
 * received by tool.execute.before hooks.
 *
 * Per OpenCode docs, the before-hook output carries mutable tool arguments.
 */
export interface ToolHookBeforeOutput {
  args: Record<string, unknown>;
}

/**
 * Plugin hook after-hook output — typed view of the `output` parameter
 * received by tool.execute.after hooks.
 */
export interface ToolHookOutput {
  /** Mutable output string — the plugin may mutate this in after hooks. */
  output: string;
}
