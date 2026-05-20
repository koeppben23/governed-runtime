/**
 * @module hooks/shared/types
 * @description Shared type definitions for FlowGuard command/HTTP hook scripts.
 *
 * Defines the canonical stdin/stdout protocol types for both Claude Code and Codex
 * hook events. All hook scripts operate on these types — platform-specific differences
 * are abstracted away by platform-detect.ts.
 *
 * @see https://docs.anthropic.com/en/docs/claude-code/hooks
 * @see https://developers.openai.com/codex/hooks
 * @see https://github.com/koeppben23/governed-runtime/issues/244
 * @version v1
 */

// ─── Platform Detection ──────────────────────────────────────────────────────

/** Supported hook host platforms. */
export type HookPlatform = 'claude-code' | 'codex' | 'unknown';

// ─── Hook Event Types ────────────────────────────────────────────────────────

/** Hook event names supported by FlowGuard. */
export type HookEventName = 'PreToolUse' | 'PostToolUse' | 'SessionStart' | 'Stop';

// ─── Stdin Input Types ───────────────────────────────────────────────────────

/**
 * Common fields present in all hook stdin payloads across both platforms.
 */
export interface HookInputBase {
  /** The tool name being invoked (e.g. "Bash", "Write", "Edit"). */
  readonly tool_name: string;
  /** The tool's input arguments. */
  readonly tool_input: Readonly<Record<string, unknown>>;
  /** Session identifier (format varies by platform). */
  readonly session_id: string;
  /** Working directory of the host agent. */
  readonly cwd: string;
}

/**
 * Claude Code specific stdin fields.
 * Claude Code provides `transcript_path` but NOT `hook_event_name`.
 */
export interface ClaudeCodeHookInput extends HookInputBase {
  /** Path to the session transcript file (Claude Code only). */
  readonly transcript_path?: string;
}

/**
 * Codex specific stdin fields.
 * Codex provides `hook_event_name` and `model` but NOT `transcript_path`.
 */
export interface CodexHookInput extends HookInputBase {
  /** The hook event name — Codex-specific field used for platform detection. */
  readonly hook_event_name?: string;
  /** The model being used — Codex-specific field. */
  readonly model?: string;
}

/**
 * Union of all possible hook input shapes.
 * The actual platform is detected by stdin-reader + platform-detect.
 */
export type HookInput = ClaudeCodeHookInput & CodexHookInput;

/**
 * SessionStart event input (different shape — no tool_name/tool_input).
 */
export interface SessionStartInput {
  readonly session_id: string;
  readonly cwd: string;
  /** Claude Code only. */
  readonly transcript_path?: string;
  /** Codex only. */
  readonly hook_event_name?: string;
  /** Codex only. */
  readonly model?: string;
}

/**
 * Stop event input (similar to SessionStart — no tool context).
 */
export interface StopInput {
  readonly session_id: string;
  readonly cwd: string;
  /** Claude Code only. */
  readonly transcript_path?: string;
  /** Codex only. */
  readonly hook_event_name?: string;
  /** Codex only. */
  readonly model?: string;
}

// ─── Stdout Output Types ─────────────────────────────────────────────────────

/**
 * Deny response — written to stdout to block a tool call.
 * This format is universal across both Claude Code and Codex.
 */
export interface HookDenyOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: HookEventName;
    readonly permissionDecision: 'deny';
    readonly permissionDecisionReason: string;
  };
}

/**
 * Allow response — exit 0 with no output (or empty JSON).
 * This type exists for documentation; in practice we simply exit(0).
 */
export type HookAllowOutput = Record<string, never>;

// ─── Internal Decision Types ─────────────────────────────────────────────────

/** Result of hook evaluation logic. */
export interface HookDecision {
  /** Whether the tool call is allowed. */
  readonly allowed: boolean;
  /** Denial code (matches PhaseGateResult.code). */
  readonly code?: string;
  /** Human-readable reason for denial. */
  readonly reason?: string;
}

// ─── HTTP Server Types ───────────────────────────────────────────────────────

/** HTTP hook request body (same shape as stdin JSON). */
export interface HttpHookRequest {
  readonly event: HookEventName;
  readonly payload: HookInput | SessionStartInput | StopInput;
}

/** HTTP hook response body. */
export interface HttpHookResponse {
  readonly decision: 'allow' | 'deny';
  readonly reason?: string;
  readonly code?: string;
}
