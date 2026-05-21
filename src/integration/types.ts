/**
 * @module integration/types
 * @description Typed interfaces for the OpenCode plugin hook boundary.
 *
 * These interfaces mirror the exact shapes defined by the OpenCode SDK
 * (`@opencode-ai/plugin` type definitions) for tool execution hooks.
 *
 * SDK source of truth: .sdk-baselines/opencode/plugin-index.d.ts
 *
 * tool.execute.before:
 *   - input: { tool, sessionID, callID } (read-only identity + session metadata)
 *   - output: { args } (mutable tool arguments)
 *
 * tool.execute.after:
 *   - input: { tool, sessionID, callID, args } (read-only, includes original args)
 *   - output: { title, output, metadata } (mutable tool result)
 *
 * @see https://opencode.ai/docs/plugins
 *
 * Type narrowing: these interfaces intentionally narrow SDK types from
 * `any` to `Record<string, unknown>` and add `readonly` modifiers for
 * compile-time fail-closed safety. The SDK contractually guarantees
 * object shapes at runtime (args, metadata are always objects); the
 * narrowing catches accidental mutations and property access errors
 * early, without changing runtime behavior.
 *
 * @version v3
 */

// ─── Before-Hook Types ────────────────────────────────────────────────────────

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
