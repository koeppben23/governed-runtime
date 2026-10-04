/**
 * @module integration/plugin-helpers
 * @description Pure utility functions extracted from plugin.ts.
 *
 * Stateless functions with no closure dependencies. Unit-testable without mock setup.
 *
 * @version v1
 */

import { parseToolResult } from './blocked-result.js';
import { AUTO_ADVANCE_OVERFLOW_CODE } from '../rails/auto-advance-overflow.js';
import {
  REASON_SESSION_LOCK_CONTENDED,
  LOCK_CONTENDED_OUTPUT_FIELD,
} from '../shared/flowguard-identifiers.js';

/**
 * Extract the raw output string from a tool output object.
 *
 * The OpenCode plugin `output` object can contain output as either
 * a string (direct output) or a structured object to serialize.
 * This replicates exactly the inline ternary that was previously
 * duplicated at multiple call sites.
 *
 * @param output - The tool output object from plugin hooks
 * @returns The output as a string
 */
export function getToolOutput(output: unknown): string {
  const inner = (output as { output?: unknown } | null | undefined)?.output;
  return typeof inner === 'string' ? inner : JSON.stringify(inner ?? '');
}

/**
 * Extract the args object from a tool input with appropriate type casting.
 *
 * The OpenCode plugin `input` object is untyped at the hook boundary.
 * This helper extracts the `args` field with correct null/default handling.
 *
 * @param input - The tool input object from plugin hooks
 * @returns The args as a record, or empty object if unavailable
 */
export function getToolArgs(input: unknown): Record<string, unknown> {
  return ((input as Record<string, unknown>)?.args as Record<string, unknown>) ?? {};
}

/**
 * Extract the metadata object from a tool output.
 *
 * The OpenCode SDK `tool.execute.after` output includes a `metadata` field
 * that the tool implementation may populate with arbitrary key-value data.
 * For the built-in `task` tool, this may include the child session ID.
 *
 * Per SDK baseline (plugin-index.d.ts): output.metadata is typed as `any`.
 *
 * @param output - The tool output object from plugin hooks
 * @returns The metadata as a record, or empty object if unavailable
 */
export function getToolMetadata(output: unknown): Record<string, unknown> {
  const inner = (output as { metadata?: unknown } | null | undefined)?.metadata;
  return typeof inner === 'object' && inner !== null && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : {};
}

/**
 * Extract the callID from a tool hook input.
 *
 * The OpenCode SDK `tool.execute.after` input includes a `callID` field
 * that uniquely identifies the tool invocation within the session.
 *
 * Per SDK baseline (plugin-index.d.ts): input.callID is typed as `string`.
 *
 * @param input - The tool input object from plugin hooks
 * @returns The callID string, or empty string if unavailable
 */
export function getToolCallID(input: unknown): string {
  const val = (input as Record<string, unknown> | null | undefined)?.callID;
  return typeof val === 'string' ? val : '';
}

/**
 * Detect an auto-advance overflow fail-closed result in a FlowGuard tool output.
 *
 * #428: when auto-advance exceeds its step ceiling, the pure rail/boundary layers
 * surface a structured fail-closed result. The plugin boundary is the only reliable
 * logger writer (ALS-scoped), so it must detect overflow via the STRUCTURED result
 * — `code === AUTO_ADVANCE_OVERFLOW` plus the typed `autoAdvanceOverflow` field —
 * NOT a message substring, so detection cannot drift with copy changes.
 *
 * Fails closed on parse: any malformed output yields `null` (no throw, no guess).
 *
 * @param rawOutput - The raw tool output string from the tool.execute.after hook
 * @returns `{ phase, limit }` when the output is a structured overflow result, else `null`
 */
export function getAutoAdvanceOverflow(
  rawOutput: unknown,
): { phase: string; limit: number } | null {
  const parsed = parseToolResult(rawOutput);
  if (!parsed || parsed.code !== AUTO_ADVANCE_OVERFLOW_CODE) return null;
  const overflow = parsed.autoAdvanceOverflow;
  if (typeof overflow !== 'object' || overflow === null) return null;
  const { phase, limit } = overflow as { phase?: unknown; limit?: unknown };
  if (typeof phase !== 'string' || typeof limit !== 'number') return null;
  return { phase, limit };
}

/**
 * Session write-lock signal for the hydrate boundary (#429).
 *
 * - `'contended'` → hydrate FAILED CLOSED: the lock could not be acquired before
 *   timeout (BLOCKED with `code === SESSION_LOCK_CONTENDED`). Operator-relevant,
 *   logged at error severity.
 * - `'waited'`    → hydrate SUCCEEDED but had to wait for a concurrent holder
 *   first (success output carries `lockContended === true`). Logged at warn.
 * - `null`        → no contention (uncontended success, or unrelated output).
 *
 * Detection is STRUCTURED (registered code + typed boolean field), never a
 * message substring, so it cannot drift with copy changes. Fails closed on
 * parse: malformed output yields `null` (no throw, no guess).
 */
export type SessionLockSignal = 'contended' | 'waited';

export function getSessionLockSignal(rawOutput: unknown): SessionLockSignal | null {
  const parsed = parseToolResult(rawOutput);
  if (!parsed) return null;
  // An error/blocked output is only a lock signal when it is the registered
  // SESSION_LOCK_CONTENDED block; any other error is unrelated. Critically, an
  // error output is NEVER reported as 'waited' even if it carries a stray
  // lockContended field — 'waited' means a SUCCESSFUL hydrate that contended.
  if (parsed.error === true) {
    return parsed.code === REASON_SESSION_LOCK_CONTENDED ? 'contended' : null;
  }
  if (parsed[LOCK_CONTENDED_OUTPUT_FIELD] === true) {
    return 'waited';
  }
  return null;
}
