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
