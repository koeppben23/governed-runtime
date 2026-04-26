/**
 * @module integration/types
 * @description Typed interfaces for the OpenCode plugin hook boundary.
 *
 * The OpenCode SDK passes untyped inputs to plugin hooks.
 * These interfaces provide type-safe access to the commonly used fields.
 *
 * @version v1
 */

/**
 * Plugin hook tool input — typed view of the `input` parameter
 * received by tool.execute.before and tool.execute.after hooks.
 */
export interface ToolHookInput {
  readonly tool: string;
  readonly sessionID: string;
  readonly args: Record<string, unknown>;
}

/**
 * Plugin hook tool output — typed view of the `output` parameter
 * received by tool.execute.after hooks.
 */
export interface ToolHookOutput {
  /** Mutable output string — the plugin may mutate this in after hooks. */
  output: string;
}
