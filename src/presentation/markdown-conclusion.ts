/**
 * @module presentation/markdown-conclusion
 * @description Conclusion and action rendering for PresentationDocument.
 *
 * @version v1
 */

import type { PresentationConclusion, PresentationAction } from './model.js';
import { normalizedMarkdown, PresentationContractError } from './model.js';
import { validateRecoveryConclusion } from './markdown-contract.js';
import type { PresentationGlyphs } from './glyph-profile.js';

export function renderConclusion(
  conclusion: PresentationConclusion,
  glyphs: PresentationGlyphs,
): string {
  switch (conclusion.kind) {
    case 'next_action':
      return renderAction(conclusion.action, glyphs);
    case 'decision_required': {
      // The question is free-form text sourced from upstream projections
      // (e.g. directive/evalResult). Validate it against the
      // structural contract so a stray trailing newline/whitespace fails
      // closed instead of silently violating the document invariants.
      const question = normalizedMarkdown(conclusion.question);
      if (question.length === 0) {
        throw new PresentationContractError(
          'PresentationConclusion: decision_required question must not be empty',
        );
      }
      const lines: string[] = [];
      lines.push(`## Decision required\n`);
      lines.push(question);
      for (const action of conclusion.actions) {
        lines.push(renderAction(action, glyphs));
      }
      return lines.join('\n');
    }
    case 'terminal': {
      // Terminal message is free-form upstream text; enforce the same
      // structural contract as all other rendered content.
      const message = normalizedMarkdown(conclusion.message);
      if (message.length === 0) {
        throw new PresentationContractError(
          'PresentationConclusion: terminal message must not be empty',
        );
      }
      return message;
    }
    case 'review_pending': {
      const message = normalizedMarkdown(conclusion.message);
      if (message.length === 0) {
        throw new PresentationContractError(
          'PresentationConclusion: review_pending message must not be empty',
        );
      }
      return `## Independent review pending\n\n${message}`;
    }
    case 'recovery': {
      validateRecoveryConclusion(conclusion);
      return `## Recovery\n\n${conclusion.message}\n${conclusion.steps.map((step) => `- ${step}`).join('\n')}`;
    }
  }
}

export function renderAction(action: PresentationAction, glyphs: PresentationGlyphs): string {
  const symbol =
    action.visibility === 'recommended' ? glyphs.recommendedAction : glyphs.availableAction;
  const invocation = action.invocation ? ` \`${action.invocation}\`` : '';
  return `${symbol}${invocation} — ${action.description}`;
}
