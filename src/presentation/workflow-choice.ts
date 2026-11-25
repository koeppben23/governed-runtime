/**
 * @module presentation/workflow-choice
 * @description Canonical workflow-choice card used by `/start` and `/hydrate`.
 *
 * The choice is a decision, not a success next-action: all three commands are
 * available and nothing runs until the user sends one. Keeping the card in one
 * place prevents `/start` from repeating the same workflow list in a second
 * `## Next` section.
 */

import type { CompactCardDocument, PresentationAction, PresentationConclusion } from './model.js';

export const WORKFLOW_CHOICE_QUESTION =
  'Choose one workflow to start. Nothing runs until you send a command.';

export const WORKFLOW_CHOICE_ACTIONS: readonly PresentationAction[] = [
  {
    invocation: '/task',
    description: 'Capture the task and start the standard governed flow (recommended)',
    visibility: 'available',
  },
  {
    invocation: '/architecture',
    description: 'Create or revise an ADR without starting a task flow',
    visibility: 'available',
  },
  {
    invocation: '/review',
    description: 'Review a diff, branch, PR, or pasted text',
    visibility: 'available',
  },
];

export function buildWorkflowChoiceConclusion(): PresentationConclusion {
  return {
    kind: 'decision_required',
    question: WORKFLOW_CHOICE_QUESTION,
    actions: WORKFLOW_CHOICE_ACTIONS,
  };
}

export function buildWorkflowChoiceDocument(): CompactCardDocument {
  return {
    kind: 'compact_card',
    density: 'compact',
    form: 'decision',
    sections: [],
    conclusion: buildWorkflowChoiceConclusion(),
  };
}
