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
