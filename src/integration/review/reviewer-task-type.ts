import type { ReviewerPromptType } from '../../templates/mandates-reviewer-criteria.js';

export type ReviewerTaskKind = 'plan' | 'implementation' | 'architecture' | 'review' | 'implement';

/**
 * Map workflow/obligation vocabulary to the canonical task-local reviewer
 * criteria selector. Keep this translation in one place so every transport
 * emits the same phase-specific review contract.
 */
export function reviewerPromptTypeForTask(kind: ReviewerTaskKind): ReviewerPromptType {
  switch (kind) {
    case 'plan':
      return 'plan';
    case 'implementation':
    case 'implement':
      return 'implementation';
    case 'architecture':
      return 'adr';
    case 'review':
      return 'content';
  }
}
