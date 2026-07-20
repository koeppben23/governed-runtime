/**
 * @test-policy
 * HAPPY: renders full plan body with phase label, version, policy, task via the
 *        shared renderer (renderMarkdown), next action as a Decision required
 *        conclusion.
 * CORNER: omits version/policy/task rows when absent.
 * CORNER: conclusion adapts to available product commands.
 * EDGE: plan body is preserved verbatim (no markdown corruption).
 * EDGE: status must not say "approved" — it must say "ready for".
 * PERF: not applicable; pure function.
 *
 * Note: v2 renders through the central PresentationDocument → renderMarkdown
 * pipeline. Metadata is emitted as `**Label:** value` (keyValue), the next
 * action as a `## Decision required` conclusion with `•`/`→` action lines —
 * NOT the legacy blockquote/`## Next recommended action` footer.
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
      expect(card).toContain('## Decision required');
    });

    it('includes phase label in the status line', () => {
      const card = buildPlanReviewCard({
        planText: 'Simple plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
      });

      expect(card).toContain('**Status:** Ready for plan approval');
    });

    it('includes plan version when provided', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
        planVersion: 3,
      });

      expect(card).toContain('**Plan version:** v3');
    });

    it('omits plan version when planVersion is 0', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
        planVersion: 0,
      });

      expect(card).not.toContain('**Plan version:** v0');
    });

    it('omits plan version when planVersion is -1', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
        planVersion: -1,
      });

      expect(card).not.toContain('**Plan version:**');
    });

    it('omits plan version when planVersion is 1.5 (non-integer)', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
        planVersion: 1.5 as unknown as number,
      });

      expect(card).not.toContain('**Plan version:**');
    });

    it('renders plan version when planVersion is 1', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
        planVersion: 1,
      });

      expect(card).toContain('**Plan version:** v1');
    });

    it('includes policy mode when provided', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
        policyMode: 'regulated',
      });

      expect(card).toContain('**Policy:** regulated');
    });

    it('includes task title when provided', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
        taskTitle: 'Implement payment validation',
      });

      expect(card).toContain('**Task:** Implement payment validation');
    });

    it('renders /approve, /request-changes, /reject with explanations when all three are available', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
      });

      expect(card).toContain('• `/approve` — approve the plan if it is complete and acceptable');
      expect(card).toContain('• `/request-changes` — send the plan back for revision');
      expect(card).toContain('• `/reject` — stop this task');
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

      expect(card).toContain('• `/approve` — approve the plan if it is complete and acceptable');
      expect(card).not.toContain('`/request-changes`');
      expect(card).not.toContain('`/reject`');
    });

    it('renders a terminal conclusion when no product commands are available', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction: { text: 'Review the plan manually.', commands: [] },
      });

      expect(card).toContain('Review the plan manually.');
      expect(card).not.toContain('## Decision required');
      expect(card).not.toContain('`/approve`');
      expect(card).not.toContain('`/request-changes`');
      expect(card).not.toContain('`/reject`');
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

      expect(card).toContain('**Plan version:** v2');
      expect(card).toContain('**Policy:** team');
      expect(card).toContain('**Task:** Fix login bug');
      expect(card).toContain(fullPlanBody);
    });
  });

  describe('STRUCTURE', () => {
    // These tests pin section ordering and renderer spacing so string-literal
    // and array-literal mutations cannot survive.

    it('starts with the H1 title and renders the status metadata below it', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan body line.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
      });

      const lines = card.split('\n');
      expect(lines.length).toBeGreaterThan(5);
      expect(lines[0]).toBe('# FlowGuard Plan Review');
      // Renderer enforces exactly one blank line between sections.
      expect(lines[1]).toBe('');
      expect(lines[2]).toBe('**Status:** Ready for plan approval');
    });

    it('renders the body section under the ## Proposed Plan heading with canonical spacing', () => {
      const card = buildPlanReviewCard({
        planText: 'BODY_MARKER',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
      });

      expect(card).toContain('## Proposed Plan\n\nBODY_MARKER');
    });

    it('renders the next action as a terminal conclusion paragraph when no commands', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction: {
          text: 'NEXT_ACTION_MARKER',
          commands: [] as readonly string[],
        },
      });

      // Terminal conclusion is the final block, separated by the renderer's \n\n.
      expect(card).toContain('\n\nNEXT_ACTION_MARKER');
      expect(card.endsWith('NEXT_ACTION_MARKER')).toBe(true);
    });

    it('separates the decision question from the action lines with a single newline', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction: {
          text: 'Action paragraph.',
          commands: ['/approve'] as readonly string[],
        },
      });

      // Decision-required conclusion: question then action lines (single newline).
      expect(card).toContain(
        'Action paragraph.\n• `/approve` — approve the plan if it is complete and acceptable',
      );
    });

    it('starts the action list empty and only adds requested commands (no synthetic entries)', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction: {
          text: 'Action.',
          commands: ['/approve'] as readonly string[],
        },
      });

      const actionLines = card.split('\n').filter((l) => l.startsWith('• '));
      expect(actionLines).toEqual([
        '• `/approve` — approve the plan if it is complete and acceptable',
      ]);
    });

    it('omits the decision block entirely when no commands are recommended', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction: {
          text: 'Action only.',
          commands: [] as readonly string[],
        },
      });

      expect(card.endsWith('Action only.')).toBe(true);
      expect(card).not.toContain('## Decision required');
      const actionLines = card.split('\n').filter((l) => l.startsWith('• '));
      expect(actionLines).toHaveLength(0);
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
      expect(card).toContain('• `/request-changes` — send the plan back for revision');
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
      expect(card).toContain('• `/reject` — stop this task');
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
      expect(card).toContain('• `/approve`');
      expect(card).toContain('• `/reject`');
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
      const idxApprove = card.indexOf('• `/approve`');
      const idxRequest = card.indexOf('• `/request-changes`');
      const idxReject = card.indexOf('• `/reject`');
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

      expect(card).toContain('**Status:** Ready for plan approval');
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

  describe('forced convergence', () => {
    it('renders a "reviewer did NOT approve" warning when forceConverged', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
        forcedConvergence: true,
      });

      expect(card).toContain('Reviewer did NOT approve this plan.');
      expect(card).toContain('iteration limit');
    });

    it('omits the warning on normal (reviewer-approved) convergence', () => {
      const card = buildPlanReviewCard({
        planText: 'Plan.',
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
        forcedConvergence: false,
      });

      expect(card).not.toContain('Reviewer did NOT approve');
    });
  });
});
