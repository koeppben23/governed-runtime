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
import { getInstalledCommand } from '../installed-commands.js';

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
      kind: 'recovery',
      message: 'Independent review capability must be restored before this review can continue.',
      steps: ['Restore the reviewer capability and retry the implementation review.'],
    },
  };
  return renderMarkdown(document);
}

export function buildImplReviewChangesRequestedMarkdown(
  statusLine: string,
  proofSummary: CompactProofPresentation,
  productNextAction: { readonly text: string; readonly commands: readonly string[] },
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
      action: implReviewAction(productNextAction),
    },
  };
  return renderMarkdown(document);
}

function implReviewAction(productNextAction: {
  readonly text: string;
  readonly commands: readonly string[];
}): {
  invocation: string | null;
  description: string;
  visibility: 'recommended' | 'available';
  intent?: import('../../presentation/action-intent.js').ActionIntent;
} {
  const invocation = productNextAction.commands[0] ?? null;
  const cmd = invocation ? getInstalledCommand(invocation) : null;
  return {
    invocation,
    description: cmd?.description ?? productNextAction.text,
    visibility: 'recommended',
    ...(cmd?.intent ? { intent: cmd.intent } : {}),
  };
}
