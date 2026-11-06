/**
 * @module integration/types
 * @description Host-neutral application ports consumed by governance hooks.
 * These are not SDK types. The native V2 composition root validates/adapts
 * id/input/result and resolves scope before calling these application ports.
 *
 * tool.execute.before:
 *   - input: { tool, sessionID, callID } (read-only identity + session metadata)
 *   - output: { args } (mutable tool arguments)
 *
 * tool.execute.after:
 *   - input: { tool, sessionID, callID, args } (read-only, includes original args)
 *   - output: { title, output, metadata } (mutable tool result)
 *
 * Native contract authority: .sdk-baselines/opencode/plugin-tool.d.ts.
 * The native host does not guarantee object input; the boundary checks it.
 *
 * @version v3
 */

// ─── Before-Hook Types ────────────────────────────────────────────────────────

/** Input parameter for `command.execute.before` hooks. */
export interface CommandHookBeforeInput {
  readonly command: string;
  readonly sessionID: string;
  readonly arguments: string;
}

/** Output parameter for `command.execute.before` hooks. */
export interface CommandHookBeforeOutput {
  parts: unknown[];
}

/**
 * Input parameter for `tool.execute.before` hooks.
 *
 * Read-only: carries tool identity and session metadata.
 * Tool arguments live on the output parameter (mutable by design).
 */
export interface ToolHookBeforeInput {
  readonly tool: string;
  readonly sessionID: string;
  readonly callID: string;
}

/**
 * Output parameter for `tool.execute.before` hooks.
 *
 * Mutable: the plugin may modify `args` to alter tool invocation.
 */
export interface ToolHookBeforeOutput {
  args: Record<string, unknown>;
}

// ─── After-Hook Types ─────────────────────────────────────────────────────────

/**
 * Input parameter for `tool.execute.after` hooks.
 *
 * Read-only: carries tool identity, session metadata, AND the original
 * args that were passed to the tool execution.
 */
export interface ToolHookAfterInput {
  readonly tool: string;
  readonly sessionID: string;
  readonly callID: string;
  readonly args: Record<string, unknown>;
}

/**
 * Output parameter for `tool.execute.after` hooks.
 *
 * Mutable: the plugin may modify `title`, `output`, or `metadata`
 * to alter the result surfaced to the LLM.
 */
export interface ToolHookAfterOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
}
