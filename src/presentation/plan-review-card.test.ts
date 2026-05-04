/**
 * @test-policy
 * HAPPY: renders full plan body with phase label, version, policy, task.
 * HAPPY: PLAN_REVIEW footer includes /approve, /request-changes, /reject with explanations.
 * CORNER: omits version/policy/task sections when absent.
 * CORNER: footer adapts to available product commands.
 * EDGE: plan body is preserved verbatim (no markdown corruption).
 * EDGE: status must not say "approved" — it must say "ready for".
 * PERF: not applicable; pure function.
 */
import { describe, expect, it } from 'vitest';
import { buildPlanReviewCard } from './plan-review-card.js';

const fullPlanBody = [
  '## Objective',
  'Implement payment validation.',
  '',
  '## Approach',
  'Use a validation pipeline.',
  '',
  '## Steps',
  '1. Add `validate.ts` in `src/payments/`.',
  '2. Add tests in `src/payments/validate.test.ts`.',
  '',
  '## Files to Modify',
  '- `src/payments/validate.ts`',
  '- `src/payments/validate.test.ts`',
  '',
  '## Edge Cases',
  '1. Empty input → return false.',
  '2. Invalid currency → throw PaymentError.',
  '',
  '## Validation Criteria',
  '1. `npm test` passes.',
  '2. Valid payment returns true.',
  '',
  '## Verification Plan',
  '1. `npm test` — Source: package.json:scripts.test',
  '2. Manual review of payment edge cases.',
].join('\n');

const productNextAction = {
  text: 'Review the plan. If it is complete and acceptable, run /approve.',
  commands: ['/approve', '/request-changes', '/reject'] as readonly string[],
};

const productNextActionPartial = {
  text: 'Review the plan.',
  commands: ['/approve'] as readonly string[],
};

describe('buildPlanReviewCard', () => {
  describe('HAPPY', () => {
    it('renders the full plan body without truncation', () => {
      const card = buildPlanReviewCard({
        planText: fullPlanBody,
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
      });

      expect(card).toContain(fullPlanBody);
      expect(card).toContain('# FlowGuard Plan Review');
      expect(card).toContain('## Proposed Plan');
      expect(card).toContain('## Next recommended action');
    });

    it('includes phase label in the status line', () => {
      const card = buildPlanReviewCard({
        planText: 'Simple plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
      });

      expect(card).toContain('> **Status:** Ready for plan approval');
    });

    it('includes plan version when provided', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
        planVersion: 3,
      });

      expect(card).toContain('> **Plan version:** v3');
    });

    it('omits plan version when planVersion is 0', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
        planVersion: 0,
      });

      expect(card).not.toContain('> **Plan version:** v0');
    });

    it('omits plan version when planVersion is -1', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
        planVersion: -1,
      });

      expect(card).not.toContain('> **Plan version:**');
    });

    it('omits plan version when planVersion is 1.5 (non-integer)', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
        planVersion: 1.5 as unknown as number,
      });

      expect(card).not.toContain('> **Plan version:**');
    });

    it('renders plan version when planVersion is 1', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
        planVersion: 1,
      });

      expect(card).toContain('> **Plan version:** v1');
    });

    it('includes policy mode when provided', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
        policyMode: 'regulated',
      });

      expect(card).toContain('> **Policy:** regulated');
    });

    it('includes task title when provided', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
        taskTitle: 'Implement payment validation',
      });

      expect(card).toContain('> **Task:** Implement payment validation');
    });

    it('renders /approve, /request-changes, /reject with explanations when all three are available', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
      });

      expect(card).toContain('- `/approve` — approve the plan if it is complete and acceptable');
      expect(card).toContain('- `/request-changes` — send the plan back for revision');
      expect(card).toContain('- `/reject` — stop this task');
    });
  });

  describe('CORNER', () => {
    it('omits plan version when absent', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
      });

      expect(card).not.toContain('Plan version');
    });

    it('omits policy mode when absent', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
      });

      expect(card).not.toContain('Policy:');
    });

    it('omits task title when absent', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
      });

      expect(card).not.toContain('Task:');
    });

    it('renders only available product commands without listing unavailable ones', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction: productNextActionPartial,
      });

      expect(card).toContain('- `/approve` — approve the plan if it is complete and acceptable');
      expect(card).not.toContain('`/request-changes`');
      expect(card).not.toContain('`/reject`');
    });

    it('omits decision bullets when no product commands are available', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction: { text: 'Review the plan manually.', commands: [] },
      });

      expect(card).toContain('Review the plan manually.');
      expect(card).not.toContain('- `/approve`');
      expect(card).not.toContain('- `/request-changes`');
      expect(card).not.toContain('- `/reject`');
    });

    it('renders correctly with all optional fields set', () => {
      const card = buildPlanReviewCard({
        planText: fullPlanBody,
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
        planVersion: 2,
        policyMode: 'team',
        taskTitle: 'Fix login bug',
      });

      expect(card).toContain('> **Plan version:** v2');
      expect(card).toContain('> **Policy:** team');
      expect(card).toContain('> **Task:** Fix login bug');
      expect(card).toContain(fullPlanBody);
    });
  });

  describe('STRUCTURE', () => {
    // These tests pin exact section ordering, separators, and join behavior
    // so that string-literal and array-literal mutations cannot survive.

    it('joins lines with "\\n" and produces a multi-line markdown document', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan body line.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
      });

      const lines = card.split('\n');
      // Document must contain many lines; an empty join char would collapse to 1.
      expect(lines.length).toBeGreaterThan(10);
      expect(lines[0]).toBe('# FlowGuard Plan Review');
      // Second line must be the empty header separator.
      expect(lines[1]).toBe('');
      expect(lines[2]).toBe('> **Status:** Ready for plan approval');
    });

    it('places the body section after a horizontal rule separator', () => {
      const card = buildPlanReviewCard({
        planText: 'BODY_MARKER',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
      });

      // body = ['', '---', '', '## Proposed Plan', '', planText]
      // Must contain the exact sequence: blank line, '---', blank line, heading, blank line, body
      expect(card).toContain('\n\n---\n\n## Proposed Plan\n\nBODY_MARKER');
    });

    it('places the footer section after a horizontal rule separator', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction: {
          text: 'NEXT_ACTION_MARKER',
          commands: [] as readonly string[],
        },
      });

      // footer starts with: '', '---', '', '## Next recommended action', '', text
      expect(card).toContain('\n\n---\n\n## Next recommended action\n\nNEXT_ACTION_MARKER');
    });

    it('separates the next-action paragraph from the option bullets with a blank line', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction: {
          text: 'Action paragraph.',
          commands: ['/approve'] as readonly string[],
        },
      });

      // After the action paragraph, an empty line must precede the bullet list.
      expect(card).toContain(
        'Action paragraph.\n\n- `/approve` — approve the plan if it is complete and acceptable',
      );
      // No back-to-back bullet glue (would indicate missing blank line push).
      expect(card).not.toContain('Action paragraph.\n- `/approve`');
    });

    it('starts the option list empty and only adds requested commands (no synthetic entries)', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction: {
          text: 'Action.',
          commands: ['/approve'] as readonly string[],
        },
      });

      // Exactly one bullet line (the /approve bullet), no leftover seed entries.
      const bulletLines = card.split('\n').filter((l) => l.startsWith('- '));
      expect(bulletLines).toEqual([
        '- `/approve` — approve the plan if it is complete and acceptable',
      ]);
    });

    it('omits the entire option block (no blank-line separator) when no commands are recommended', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction: {
          text: 'Action only.',
          commands: [] as readonly string[],
        },
      });

      // Card ends with the action text, no trailing blank line + bullet list.
      expect(card.endsWith('Action only.')).toBe(true);
      const bulletLines = card.split('\n').filter((l) => l.startsWith('- '));
      expect(bulletLines).toHaveLength(0);
    });

    it('renders only /approve when only /approve is recommended (kills "always emit request-changes")', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction: {
          text: 'Action.',
          commands: ['/approve'] as readonly string[],
        },
      });
      expect(card).not.toContain('/request-changes');
      expect(card).not.toContain('/reject');
    });

    it('renders only /request-changes when only /request-changes is recommended', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction: {
          text: 'Action.',
          commands: ['/request-changes'] as readonly string[],
        },
      });
      expect(card).toContain('- `/request-changes` — send the plan back for revision');
      expect(card).not.toContain('/approve');
      expect(card).not.toContain('/reject');
    });

    it('renders only /reject when only /reject is recommended', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction: {
          text: 'Action.',
          commands: ['/reject'] as readonly string[],
        },
      });
      expect(card).toContain('- `/reject` — stop this task');
      expect(card).not.toContain('/approve');
      expect(card).not.toContain('/request-changes');
    });

    it('renders /approve and /reject without /request-changes when only those two are recommended', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction: {
          text: 'Action.',
          commands: ['/approve', '/reject'] as readonly string[],
        },
      });
      expect(card).toContain('- `/approve`');
      expect(card).toContain('- `/reject`');
      expect(card).not.toContain('/request-changes');
    });

    it('emits options in canonical order: approve, request-changes, reject', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        // Pass commands in a different order than canonical to confirm order is fixed.
        productNextAction: {
          text: 'Action.',
          commands: ['/reject', '/request-changes', '/approve'] as readonly string[],
        },
      });
      const idxApprove = card.indexOf('- `/approve`');
      const idxRequest = card.indexOf('- `/request-changes`');
      const idxReject = card.indexOf('- `/reject`');
      expect(idxApprove).toBeGreaterThan(-1);
      expect(idxRequest).toBeGreaterThan(idxApprove);
      expect(idxReject).toBeGreaterThan(idxRequest);
    });
  });

  describe('EDGE', () => {
    it('plan body is preserved verbatim (no markdown corruption)', () => {
      const markdownWithSpecialChars =
        '## Plan\n\nUse `code` and **bold** and _italic_.\n\n> A quote block\n\n```ts\nconst x = 1;\n```';

      const card = buildPlanReviewCard({
        planText: markdownWithSpecialChars,
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
      });

      expect(card).toContain(markdownWithSpecialChars);
      expect(card).toContain('```ts');
      expect(card).toContain('const x = 1;');
      expect(card).toContain('> A quote block');
    });

    it('status text says "ready for" not "approved"', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
      });

      expect(card).toContain('> **Status:** Ready for plan approval');
      expect(card).not.toMatch(/\bapproved\b/i);
    });

    it('returns a non-empty string for all valid inputs', () => {
      const card = buildPlanReviewCard({
        planText: '.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction: { text: 'Run /approve.', commands: [] },
      });

      expect(card.length).toBeGreaterThan(0);
      expect(card).toContain('Run /approve.');
    });
  });
});
