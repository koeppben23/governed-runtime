/**
 * @module integration/plugin-helpers
 * @description Pure utility functions extracted from plugin.ts.
 *
 * Stateless functions with no closure dependencies. Unit-testable without mock setup.
 *
 * @version v1
 */

import { defaultReasonRegistry } from '../config/reasons.js';

/**
 * Parse tool output JSON with fallback for NextAction footer lines.
 *
 * The LLM output often contains a JSON block followed by free text
 * (such as a "Next action:" line or explanatory text). This function
 * first attempts to parse the full string as JSON, and if that fails,
 * tries parsing only the first line.
 *
 * @param rawOutput - The raw tool output, typically a JSON string
 * @returns Parsed object or null if parsing fails completely
 */
export function parseToolResult(rawOutput: unknown): Record<string, unknown> | null {
  try {
    const resultStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
    return JSON.parse(resultStr);
  } catch {
    try {
      const resultStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
      const firstLine = resultStr.split('\n')[0] ?? '';
      if (!firstLine.trim()) return null;
      return JSON.parse(firstLine);
    } catch {
      return null;
    }
  }
}

/**
 * Build a strictly blocked error output in the format OpenCode expects.
 *
 * Used when review orchestration fails in strict mode — the output
 * is injected into the tool response to signal the failure to the agent.
 *
 * Looks up the reason in the default registry to populate `message` and
 * `recovery`. Falls back to a generic message and empty recovery if the
 * code is not registered (unknown codes are still surfaced; the block
 * itself is enforced by the caller, not by the registry).
 *
 * @param code - Error/reason code (e.g. 'SUBAGENT_MANDATE_MISMATCH')
 * @param detail - Key-value detail map for the error payload (also used for template interpolation)
 * @returns JSON string of the blocked output object
 */
export function strictBlockedOutput(code: string, detail: Record<string, string>): string {
  const formatted = defaultReasonRegistry.format(code, detail);
  return JSON.stringify({
    error: true,
    code: formatted.code,
    message: formatted.reason,
    detail,
    recovery: formatted.recovery,
    ...(formatted.quickFix !== undefined ? { quickFix: formatted.quickFix } : {}),
  });
}

/**
 * Build a structured FlowGuard enforcement error suitable for throwing
 * from a plugin hook.
 *
 * The OpenCode plugin runtime captures `Error.message` and surfaces it to
 * the LLM. Encoding the structured payload as JSON in the message gives
 * the agent actionable recovery guidance instead of an opaque string.
 *
 * The error name is set to "FlowGuardEnforcementError" so callers can
 * branch on `instanceof Error && err.name === 'FlowGuardEnforcementError'`.
 *
 * @param code - Reason code from the registry
 * @param reason - Human-readable reason from the enforcement layer
 * @param detail - Optional key-value detail map (interpolated into the registry template)
 * @returns Error instance ready to throw
 */
export function buildEnforcementError(
  code: string,
  reason: string,
  detail: Record<string, string> = {},
): Error {
  const formatted = defaultReasonRegistry.format(code, detail);
  const payload = {
    error: true,
    code,
    // Prefer the live enforcement reason (carries dynamic context like session IDs)
    // over the registry template, but fall back to the registry message when reason is empty.
    message: reason && reason.length > 0 ? reason : formatted.reason,
    detail,
    recovery: formatted.recovery,
    ...(formatted.quickFix !== undefined ? { quickFix: formatted.quickFix } : {}),
  };
  const err = new Error(`[FlowGuard] ${JSON.stringify(payload)}`);
  err.name = 'FlowGuardEnforcementError';
  return err;
}

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
