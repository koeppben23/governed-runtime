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

export class DenyOutputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DenyOutputError';
  }
}

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
 * Writes the JSON payload followed by a newline.
 *
 * @param eventName - The hook event that triggered the denial.
 * @param code - Machine-readable denial code.
 * @param reason - Human-readable denial reason.
 */
export async function writeDeny(
  eventName: HookEventName,
  code: string,
  reason: string,
): Promise<void> {
  const output = formatDenyOutput(eventName, code, reason);
  const payload = JSON.stringify(output) + '\n';
  try {
    await writeStdout(payload);
  } catch (err) {
    process.exitCode = 2;
    writeStderrBestEffort(
      `[FlowGuard Hook] DENY_OUTPUT_FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    writeStderrBestEffort(payload);
    throw new DenyOutputError('Failed to write deny decision to stdout', { cause: err });
  }
}

function writeStdout(payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (err?: Error | null): void => {
      if (settled) return;
      settled = true;
      process.stdout.off('error', onError);
      if (err) {
        reject(err);
        return;
      }
      resolve();
    };

    const onError = (err: Error): void => finish(err);

    try {
      process.stdout.once('error', onError);
      process.stdout.write(payload, (err?: Error | null) => finish(err));
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function writeStderrBestEffort(message: string): void {
  try {
    process.stderr.write(message);
  } catch {
    // Nothing safer is available here; the caller receives DenyOutputError.
  }
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
