/**
 * @module integration/tools/implement-review-presentation
 * @description Typed state-bound presentation documents for implementation review outcomes.
 */

import { renderMarkdown } from '../../presentation/markdown.js';
import {
  normalizedMarkdown,
  type CompactCardDocument,
  type PresentationSection,
} from '../../presentation/model.js';
import { buildProofGraphSection } from '../../presentation/proof-summary.js';
import type { CompactProofPresentation } from '../../presentation/proof-model.js';

export function buildImplReviewBlockedMarkdown(
  message: string,
  proofSummary: CompactProofPresentation,
): string {
  const document: CompactCardDocument = {
    kind: 'compact_card',
    density: 'compact',
    form: 'blocked',
    sections: [
      {
        kind: 'blocker',
        heading: 'Implementation review blocked',
        code: null,
        text: message,
      },
      buildProofGraphSection(proofSummary),
    ],
    conclusion: {
      kind: 'next_action',
      action: {
        invocation: '/implement',
        description: 'Restore independent review capability and retry the implementation review.',
        visibility: 'recommended',
      },
    },
  };
  return renderMarkdown(document);
}

export function buildImplReviewChangesRequestedMarkdown(
  statusLine: string,
  proofSummary: CompactProofPresentation,
): string {
  const sections: PresentationSection[] = [
    { kind: 'text', content: normalizedMarkdown(statusLine) },
    buildProofGraphSection(proofSummary),
  ];
  const document: CompactCardDocument = {
    kind: 'compact_card',
    density: 'compact',
    form: 'success',
    sections,
    conclusion: {
      kind: 'next_action',
      action: {
        invocation: '/implement',
        description: 'Make the requested code changes, then call flowguard_implement to re-record.',
        visibility: 'recommended',
      },
    },
  };
  return renderMarkdown(document);
}
