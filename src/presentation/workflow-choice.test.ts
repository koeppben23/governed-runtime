import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.js';
import {
  WORKFLOW_CHOICE_ACTIONS,
  WORKFLOW_CHOICE_QUESTION,
  buildWorkflowChoiceConclusion,
  buildWorkflowChoiceDocument,
} from './workflow-choice.js';

describe('workflow choice presentation', () => {
  it('renders one decision card with all three commands and no duplicate lists', () => {
    const markdown = renderMarkdown(buildWorkflowChoiceDocument());
    expect(markdown).toContain('## Decision required');
    expect(markdown).toContain(WORKFLOW_CHOICE_QUESTION);
    expect(markdown).toContain(
      '- `/task` — Capture the task and start the standard governed flow (recommended)',
    );
    expect(markdown).toContain(
      '- `/architecture` — Create or revise an ADR without starting a task flow',
    );
    expect(markdown).toContain('- `/review` — Review a diff, branch, PR, or pasted text');
    expect(markdown).not.toContain('## Workflows');
    expect(markdown).not.toContain('## Next');
  });

  it('keeps every choice available rather than auto-selecting a workflow', () => {
    expect(buildWorkflowChoiceConclusion()).toMatchObject({
      kind: 'decision_required',
      question: WORKFLOW_CHOICE_QUESTION,
    });
    expect(WORKFLOW_CHOICE_ACTIONS.every((action) => action.visibility === 'available')).toBe(true);
  });
});
