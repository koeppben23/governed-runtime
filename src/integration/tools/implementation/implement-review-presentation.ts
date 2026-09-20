/**
 * @module integration/tools/implementation/implement-review-presentation
 * @description Typed state-bound presentation documents for implementation review outcomes.
 */

import { renderMarkdown } from '../../../presentation/markdown.js';
import {
  normalizedMarkdown,
  type CompactCardDocument,
  type PresentationSection,
} from '../../../presentation/model.js';
import { buildProofGraphSection } from '../../../presentation/proof-summary.js';
import type { CompactProofPresentation } from '../../../presentation/proof-model.js';
import { getInstalledCommand } from '../../installed-commands.js';
import { directiveLabel } from '../../../presentation/directive-copy.js';
import type { DirectiveProjection } from '../../../presentation/review-decision.js';
import { IntegrationInvariantError } from '../../errors.js';

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
  directive: DirectiveProjection,
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
      action: implReviewAction(directive),
    },
  };
  return renderMarkdown(document);
}

function implReviewAction(directive: DirectiveProjection): {
  invocation: string | null;
  description: string;
  visibility: 'recommended' | 'available';
  intent?: import('../../../presentation/action-intent.js').ActionIntent;
} {
  const invocation = directive.commands[0] ?? null;
  if (!invocation) {
    return {
      invocation: null,
      description: directiveLabel(directive.code),
      visibility: 'recommended',
    };
  }
  const cmd = getInstalledCommand(invocation);
  if (!cmd) {
    throw new IntegrationInvariantError(
      'IMPLEMENT_REVIEW_COMMAND_METADATA_MISSING',
      `implementation review action: no installed command metadata for "${invocation}".`,
    );
  }
  return {
    invocation: cmd.invocation,
    description: cmd.description,
    visibility: 'recommended',
    ...(cmd.intent ? { intent: cmd.intent } : {}),
  };
}
