/**
 * @module integration/tools/blocked-presentation
 * @description Blocked-response presentation authority.
 *
 * Builds the structured diagnostics + rendered markdown for a blocked tool
 * result from its FINAL canonical code. Orchestrator rewrites may change a
 * blocked result's `code` after the tool boundary already attached a
 * presentation; consumers re-derive through `rebuildBlockedPresentation` so a
 * response never carries two different reason codes
 * (`presentation.reasonCode === canonicalResult.code`).
 *
 * @version v1
 */

import { buildBlockedDiagnostics, formatDiagnosticCard } from '../../diagnostics/index.js';
import type { RuntimeDiagnostics } from '../../diagnostics/index.js';

/** Blocked-response fields: structured diagnostics and rendered markdown. */
export function buildBlockedPresentation(
  code: string,
  message: string,
  detail: Record<string, string>,
): {
  diagnostics?: RuntimeDiagnostics;
  presentation?: { markdown: string };
} {
  const diagnostics = buildBlockedDiagnostics(code, detail);
  if (!diagnostics) return {};
  return {
    diagnostics,
    presentation: { markdown: formatDiagnosticCard({ code, message, diagnostics }) },
  };
}

/**
 * Re-derive blocked-presentation fields from the FINAL canonical code.
 */
export function rebuildBlockedPresentation(
  code: string,
  message: string,
): {
  diagnostics?: RuntimeDiagnostics;
  presentation?: { markdown: string };
} {
  return buildBlockedPresentation(code, message, {});
}
