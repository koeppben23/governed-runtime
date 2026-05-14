/**
 * @module diagnostics/format-card
 * @description Human-readable failure card formatting for runtime diagnostics.
 */

import type { RuntimeDiagnostics } from './types.js';

function section(title: string, values: readonly string[]): string[] {
  if (values.length === 0) return [];
  return [`${title}:`, ...values.map((value) => `- ${value}`), ''];
}

export function formatDiagnosticCard(input: {
  readonly code: string;
  readonly message: string;
  readonly diagnostics: RuntimeDiagnostics;
}): string {
  const { code, message, diagnostics } = input;
  return [
    'FlowGuard blocked this action.',
    '',
    'Reason:',
    `${code}: ${message}`,
    '',
    'Root cause:',
    diagnostics.rootCause,
    '',
    ...section('Observed', diagnostics.observed),
    ...section('Required', diagnostics.required),
    ...section('Missing evidence', diagnostics.missingEvidence ?? []),
    ...section('Next', diagnostics.safeNextActions),
  ]
    .join('\n')
    .trimEnd();
}
