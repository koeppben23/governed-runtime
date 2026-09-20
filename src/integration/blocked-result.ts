/**
 * @module integration/blocked-result
 * @description Canonical blocked tool-result authority.
 *
 * Builds the structured diagnostics, rendered markdown, and JSON envelope for a
 * blocked tool result from its FINAL canonical code. Shared by the tool layer
 * and the review bounded context; owned by no single command or context.
 *
 * @version v1
 */

import { buildBlockedDiagnostics, formatDiagnosticCard } from '../diagnostics/index.js';
import type { RuntimeDiagnostics } from '../diagnostics/index.js';
import { normalizedMarkdown } from '../presentation/model.js';
import { renderMarkdown } from '../presentation/markdown.js';
import { projectReasonFromRegistry } from '../presentation/reason-projection.js';
import { lookupReasonCopy } from '../presentation/index.js';
import { defaultReasonRegistry } from '../config/reasons.js';
import { getAdapterLogger, getLogTraceFields } from '../logging/adapter-logger.js';

/** Blocked-response fields: structured diagnostics and rendered markdown. */
export function buildBlockedPresentation(
  code: string,
  message: string,
  detail: Record<string, string>,
  recoveryAction?: string,
): {
  diagnostics?: RuntimeDiagnostics;
  presentation?: { markdown: string };
} {
  const diagnostics = buildBlockedDiagnostics(code, detail);
  if (!diagnostics) {
    const reason = projectReasonFromRegistry(code, detail);
    if (!reason) return {};
    return {
      presentation: {
        markdown: renderMarkdown({
          kind: 'diagnostic_card',
          form: 'diagnostic',
          sections: [
            { kind: 'text', content: normalizedMarkdown('FlowGuard blocked this action.') },
            { kind: 'blocker', code, text: message },
          ],
          conclusion: {
            kind: 'recovery',
            message: 'Use the canonical recovery steps below.',
            steps: recoveryAction
              ? [reason.recovery.primary, ...reason.recovery.secondary, recoveryAction]
              : [reason.recovery.primary, ...reason.recovery.secondary],
          },
        }),
      },
    };
  }
  return {
    diagnostics,
    presentation: { markdown: formatDiagnosticCard({ code, message, diagnostics }) },
  };
}

/**
 * Migrated reason-copy headline field, present only for authored codes.
 *
 * Shared with the rail-result presentation helpers
 * (`integration/tools/helpers-rail-presentation.ts`).
 */
export function headlineFields(code: string): { headline?: string } {
  const copy = lookupReasonCopy(code);
  return copy?.headline ? { headline: copy.headline } : {};
}

/**
 * Format a blocked error using the reason registry.
 * Used for inline blocked returns in tool logic (outside rail calls).
 */
export function formatBlocked(
  code: string,
  vars?: Record<string, string>,
  extra?: Record<string, unknown>,
): string {
  getAdapterLogger().warn('machine', 'tool_blocked', { code, ...getLogTraceFields() });
  const info = defaultReasonRegistry.format(code, vars);
  // Render the diagnostic through the shared renderer so blocked returns from
  // inline tool logic present consistently with the rest of the surface.
  const blockedPresentation = buildBlockedPresentation(
    info.code,
    info.reason,
    vars ?? {},
    typeof extra?.recoveryAction === 'string' ? extra.recoveryAction : undefined,
  );
  return JSON.stringify({
    error: true,
    code: info.code,
    message: info.reason,
    recovery: info.recovery,
    quickFix: info.quickFix,
    ...headlineFields(info.code),
    ...blockedPresentation,
    ...(extra ?? {}),
  });
}

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
  const headline = lookupReasonCopy(formatted.code)?.headline;
  return JSON.stringify({
    error: true,
    code: formatted.code,
    message: formatted.reason,
    detail,
    recovery: formatted.recovery,
    ...(headline ? { headline } : {}),
    ...(formatted.quickFix !== undefined ? { quickFix: formatted.quickFix } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  });
}

/**
 * Error class for structured FlowGuard enforcement failures.
 *
 * The OpenCode plugin runtime captures `Error.message` and surfaces it to
 * the LLM. Encoding the structured payload as JSON in the message gives
 * the agent actionable recovery guidance instead of an opaque string.
 *
 * The name is "FlowGuardEnforcementError" so callers can branch on
 * `instanceof Error && err.name === 'FlowGuardEnforcementError'`.
 */
class FlowGuardEnforcementError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FlowGuardEnforcementError';
    this.code = code;
  }
}

/**
 * Build a structured FlowGuard enforcement error suitable for throwing
 * from a plugin hook.
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
  return new FlowGuardEnforcementError(code, `[FlowGuard] ${JSON.stringify(payload)}`);
}

function appendUnregisteredContext(formattedReason: string, reason: string): string {
  if (!reason) return formattedReason;
  return `${formattedReason} Context: ${reason}`;
}
