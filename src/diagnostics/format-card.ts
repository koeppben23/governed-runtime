/**
 * @module diagnostics/format-card
 * @description Diagnostic card formatting using the shared presentation renderer.
 */

import type { RuntimeDiagnostics } from './types.js';
import type { DiagnosticCardDocument, PresentationSection } from '../presentation/model.js';
import { normalizedMarkdown } from '../presentation/model.js';
import { renderMarkdown } from '../presentation/markdown.js';

export type DiagnosticCardInput = Readonly<{
  code: string;
  message: string;
  diagnostics: RuntimeDiagnostics;
}>;

/**
 * Build a DiagnosticCardDocument from a diagnostic input.
 * Uses shared presentation primitives instead of a plaintext engine.
 */
export function buildBlockedDiagnosticDocument(input: DiagnosticCardInput): DiagnosticCardDocument {
  const { code, message, diagnostics } = input;
  const sections: PresentationSection[] = [];

  sections.push({
    kind: 'text',
    content: normalizedMarkdown('FlowGuard blocked this action.'),
  });

  sections.push({
    kind: 'blocker',
    code,
    text: message,
  });

  sections.push({
    kind: 'keyValue',
    items: [{ label: 'Root cause', value: diagnostics.rootCause }],
  });

  if (diagnostics.observed.length > 0) {
    sections.push({ kind: 'bulletList', heading: 'Observed', items: diagnostics.observed });
  }
  if (diagnostics.required.length > 0) {
    sections.push({ kind: 'bulletList', heading: 'Required', items: diagnostics.required });
  }
  if (diagnostics.missingEvidence?.length) {
    sections.push({
      kind: 'bulletList',
      heading: 'Missing evidence',
      items: diagnostics.missingEvidence,
    });
  }
  return {
    kind: 'diagnostic_card',
    form: 'diagnostic',
    sections,
    conclusion: {
      kind: 'recovery',
      message: 'Use the canonical recovery steps below.',
      steps:
        diagnostics.safeNextActions.length > 0
          ? diagnostics.safeNextActions
          : ['Inspect the diagnostic details before retrying.'],
    },
  };
}

/**
 * Format a diagnostic card to a Markdown string.
 * Preserved public API — delegates to the shared renderer.
 */
export function formatDiagnosticCard(input: DiagnosticCardInput): string {
  return renderMarkdown(buildBlockedDiagnosticDocument(input));
}
