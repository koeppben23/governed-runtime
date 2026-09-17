/**
 * @module integration/tools/blocked-presentation
 * @description Blocked-response presentation authority.
 *
 * Builds the structured diagnostics + rendered markdown for a blocked tool
 * result from its FINAL canonical code.
 *
 * @version v1
 */

import { buildBlockedDiagnostics, formatDiagnosticCard } from '../../diagnostics/index.js';
import type { RuntimeDiagnostics } from '../../diagnostics/index.js';
import { normalizedMarkdown } from '../../presentation/model.js';
import { renderMarkdown } from '../../presentation/markdown.js';
import { projectReasonFromRegistry } from '../../presentation/reason-projection.js';

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
