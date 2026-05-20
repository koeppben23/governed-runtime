/**
 * @module hooks/shared/stdout-writer
 * @description Format and write hook decisions to stdout.
 *
 * Implements the universal deny response format used by both Claude Code and Codex:
 * - Deny: write JSON with `hookSpecificOutput.permissionDecision: "deny"`
 * - Allow: write nothing (exit 0 with empty stdout)
 *
 * Pure formatting logic — no I/O decisions (caller controls when to write).
 *
 * @version v1
 */

import type { HookDenyOutput, HookEventName } from './types.js';

/**
 * Format a deny decision as the stdout JSON payload.
 *
 * @param eventName - The hook event that triggered the denial.
 * @param code - Machine-readable denial code (e.g. 'HOST_TOOL_PHASE_DENIED').
 * @param reason - Human-readable explanation of the denial.
 * @returns Formatted deny output object.
 */
export function formatDenyOutput(
  eventName: HookEventName,
  code: string,
  reason: string,
): HookDenyOutput {
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      permissionDecision: 'deny',
      permissionDecisionReason: `${code}: ${reason}`,
    },
  };
}

/**
 * Write a deny decision to stdout.
 * Writes the JSON payload followed by a newline, then exits.
 *
 * @param eventName - The hook event that triggered the denial.
 * @param code - Machine-readable denial code.
 * @param reason - Human-readable denial reason.
 */
export function writeDeny(eventName: HookEventName, code: string, reason: string): void {
  const output = formatDenyOutput(eventName, code, reason);
  process.stdout.write(JSON.stringify(output) + '\n');
}

/**
 * Write a diagnostic message to stderr.
 * Hook scripts use stderr for logging — stdout is reserved for protocol responses.
 *
 * @param message - Diagnostic message.
 */
export function writeLog(message: string): void {
  process.stderr.write(`[FlowGuard Hook] ${message}\n`);
}
