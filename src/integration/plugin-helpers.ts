/**
 * @module integration/plugin-helpers
 * @description Pure utility functions extracted from plugin.ts.
 *
 * Stateless functions with no closure dependencies. Unit-testable without mock setup.
 *
 * @version v1
 */

import { defaultReasonRegistry } from '../config/reasons.js';
import { buildBlockedDiagnostics } from '../diagnostics/index.js';
import { AUTO_ADVANCE_OVERFLOW_CODE } from '../rails/auto-advance-overflow.js';
import {
  REASON_PLUGIN_ENFORCEMENT_UNAVAILABLE,
  REVIEW_ACCEPTANCE_PATH_NATIVE,
  REASON_SESSION_LOCK_CONTENDED,
  LOCK_CONTENDED_OUTPUT_FIELD,
} from '../shared/flowguard-identifiers.js';
import { HOST_TASK_FINDINGS_REJECTION_FIELD } from './tools/review-validation.js';

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
  let resultStr: string;
  try {
    resultStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
  } catch {
    return null;
  }
  try {
    return JSON.parse(resultStr);
  } catch {
    try {
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
 * `recovery`. Unknown codes are surfaced with marked unregistered output;
 * the block itself is enforced by the caller, not by the registry.
 *
 * @param code - Error/reason code (e.g. 'SUBAGENT_MANDATE_MISMATCH')
 * @param detail - Key-value detail map for the error payload (also used for template interpolation)
 * @returns JSON string of the blocked output object
 */
export function strictBlockedOutput(code: string, detail: Record<string, string>): string {
  const formatted = defaultReasonRegistry.format(code, detail);
  const diagnostics = buildBlockedDiagnostics(formatted.code, detail);
  return JSON.stringify({
    error: true,
    code: formatted.code,
    message: formatted.reason,
    detail,
    recovery: formatted.recovery,
    ...(formatted.quickFix !== undefined ? { quickFix: formatted.quickFix } : {}),
    ...(diagnostics ? { diagnostics } : {}),
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
  const registeredReason = defaultReasonRegistry.get(code);
  const effectiveMessage =
    registeredReason && reason.length > 0
      ? reason
      : appendUnregisteredContext(formatted.reason, reason);
  const diagnostics = buildBlockedDiagnostics(code, { ...detail, reason: effectiveMessage });
  const payload = {
    error: true,
    code,
    // Prefer the live enforcement reason (carries dynamic context like session IDs)
    // over the registry template, but fall back to the registry message when reason is empty.
    message: effectiveMessage,
    detail,
    recovery: formatted.recovery,
    ...(formatted.quickFix !== undefined ? { quickFix: formatted.quickFix } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  };
  const err = new Error(`[FlowGuard] ${JSON.stringify(payload)}`);
  err.name = 'FlowGuardEnforcementError';
  return err;
}

function appendUnregisteredContext(formattedReason: string, reason: string): string {
  if (!reason) return formattedReason;
  return `${formattedReason} Context: ${reason}`;
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
 * Detect a fail-closed review denial produced by the native_subagent_attested path
 * because first-party plugin enforcement was unavailable (#419).
 *
 * Reads the structured blocked-result fields (`code` + `diagnostics.deniedReviewPath`)
 * surfaced by the pure validation layer — never parses human-readable messages — so the
 * plugin boundary can emit a single diagnostic warn without re-deriving the path.
 *
 * @param rawOutput - The raw tool output string from the tool.execute.after hook
 * @returns true when the output is a native enforcement-unavailable denial
 */
export function isNativeEnforcementUnavailableDenial(rawOutput: unknown): boolean {
  const parsed = parseToolResult(rawOutput);
  if (!parsed || parsed.code !== REASON_PLUGIN_ENFORCEMENT_UNAVAILABLE) return false;
  const diagnostics = parsed.diagnostics;
  if (typeof diagnostics !== 'object' || diagnostics === null) return false;
  return (
    (diagnostics as { deniedReviewPath?: unknown }).deniedReviewPath ===
    REVIEW_ACCEPTANCE_PATH_NATIVE
  );
}

export interface HostTaskFindingsRejectionLogContext {
  readonly path: 'host_task';
  readonly reason: string;
  readonly status: string;
  readonly obligationId?: string;
}

/**
 * Detect a host-task findings rejection surfaced by the pure validation layer.
 * Detection is structured-only so strict-path denials cannot be mislabeled as
 * host-task denials by matching on shared reason codes.
 */
export function getHostTaskFindingsRejection(
  rawOutput: unknown,
): HostTaskFindingsRejectionLogContext | null {
  const parsed = parseToolResult(rawOutput);
  if (!parsed) return null;
  const rejection = parsed[HOST_TASK_FINDINGS_REJECTION_FIELD];
  if (typeof rejection !== 'object' || rejection === null) return null;

  const { path, reason, status, obligationId } = rejection as {
    path?: unknown;
    reason?: unknown;
    status?: unknown;
    obligationId?: unknown;
  };
  if (path !== 'host_task' || typeof reason !== 'string' || typeof status !== 'string') {
    return null;
  }
  return {
    path,
    reason,
    status,
    ...(typeof obligationId === 'string' ? { obligationId } : {}),
  };
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
