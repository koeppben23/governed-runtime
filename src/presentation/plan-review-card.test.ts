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
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function readGolden(name: string): Promise<string> {
  const p = resolve(__dirname, '..', '..', 'testdata', 'presentation', name);
  return readFile(p, 'utf-8');
}

// #709 implementation-plan visual contract: one `#` top heading, `##` sections.
const fullPlanBody = [
  '# Implementation Plan',
  '',
  '> **Objective:** Implement payment validation. | **Scope:** src/payments | **Risk:** Low | **Version:** 1',
  '',
  '## Approach',
  '- Use a validation pipeline.',
  '',
  '## Implementation',
  '### 1. Add validator',
  '**Files:** `src/payments/validate.ts`',
  '**Changes:** add validate().',
  '',
  '## Change Inventory',
  '| Area | Files | Change |',
  '|---|---|---|',
  '| Payments | `src/payments/validate.ts` | CREATE |',
  '',
  '## Acceptance Criteria',
  '- [ ] Valid payment returns true.',
  '',
  '## Verification',
  '1. `npm test` — Source: package.json#scripts.test',
].join('\n');

// The same body after the renderer demotes it for embedding in the review card
// (# -> ###, ## -> ####, ### -> #####) so it nests under `## Proposed Plan`.
const fullPlanBodyEmbedded = [
  '### Implementation Plan',
  '',
  '> **Objective:** Implement payment validation. | **Scope:** src/payments | **Risk:** Low | **Version:** 1',
  '',
  '#### Approach',
  '- Use a validation pipeline.',
  '',
  '#### Implementation',
  '##### 1. Add validator',
  '**Files:** `src/payments/validate.ts`',
  '**Changes:** add validate().',
  '',
  '#### Change Inventory',
  '| Area | Files | Change |',
  '|---|---|---|',
  '| Payments | `src/payments/validate.ts` | CREATE |',
  '',
  '#### Acceptance Criteria',
  '- [ ] Valid payment returns true.',
  '',
  '#### Verification',
  '1. `npm test` — Source: package.json#scripts.test',
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
  it('keeps Unicode canonical by default and supports an ASCII transient rendering', () => {
    const input = {
      planText: 'Plan.',
      phase: 'PLAN_REVIEW' as const,
      phaseLabel: 'Ready for plan approval',
      productNextAction,
      forcedConvergence: true,
    };
    const canonical = buildPlanReviewCard(input);

    expect(buildPlanReviewCard(input)).toBe(canonical);
    expect(canonical).toContain('⚠ Reviewer did NOT approve this plan.');
    expect(buildPlanReviewCard(input, { glyphProfile: 'ascii' })).toContain(
      '[WARN] Reviewer did NOT approve this plan.',
    );
  });

  describe('HAPPY', () => {
    it('renders the full plan body without truncation', () => {
      const card = buildPlanReviewCard({
        planText: fullPlanBody,
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
      });

      expect(card).toContain(fullPlanBodyEmbedded);
      expect(card).toContain('# FlowGuard Plan Review');
      expect(card).toContain('## Proposed Plan');
      expect(card).toContain('## Decision required');
      // Exactly one document-level H1 (the card title); the plan body H1 is demoted.
      expect(card.match(/^# /gm)).toHaveLength(1);
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
      expect(card).toContain(fullPlanBodyEmbedded);
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
        'Action paragraph.\n- `/approve` — approve the plan if it is complete and acceptable',
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

      const actionLines = card.split('\n').filter((l) => l.startsWith('- '));
      expect(actionLines).toEqual([
        '- `/approve` — approve the plan if it is complete and acceptable',
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
      const actionLines = card.split('\n').filter((l) => l.startsWith('- '));
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
    it('preserves plan body content (only heading levels are demoted, no other corruption)', () => {
      const body =
        '## Plan\n\nUse `code` and **bold** and _italic_.\n\n> A quote block\n\n```ts\nconst x = 1;\n```';

      const card = buildPlanReviewCard({
        planText: body,
        phase: 'PLAN_REVIEW',
        phaseLabel: 'Ready for plan approval',
        productNextAction,
      });

      // Heading demoted under `## Proposed Plan` (## -> ###); everything else intact.
      expect(card).toContain('### Plan\n\nUse `code` and **bold** and _italic_.');
      expect(card).toContain('```ts\nconst x = 1;\n```');
      expect(card).toContain('> A quote block');
      // Exactly one document-level H1.
      expect(card.match(/^# /gm)).toHaveLength(1);
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

// ─── Golden Baseline Tests ──────────────────────────────────────────────────────

// #709 implementation-plan visual contract (one `#` top heading). Exercises the
// real template structure so the golden catches double-H1 / inversion regressions.
const planBody = [
  '# Implementation Plan',
  '',
  '> **Objective:** Implement payment validation. | **Scope:** src/payments | **Risk:** Low | **Version:** 3',
  '',
  '## Approach',
  '- Use a validation pipeline.',
  '',
  '## Implementation',
  '### 1. Add validator',
  '**Files:** src/payments/validate.ts',
  '**Changes:** add validate().',
  '',
  '## Change Inventory',
  '| Area | Files | Change |',
  '|---|---|---|',
  '| Payments | src/payments/validate.ts | CREATE |',
  '',
  '## Acceptance Criteria',
  '- [ ] Valid payment returns true.',
  '',
  '## Verification',
  '1. npm test — Source: package.json#scripts.test',
].join('\n');

describe('plan review golden fixtures', () => {
  it('review-plan-approved matches golden output', async () => {
    const card = buildPlanReviewCard({
      planText: planBody,
      phase: 'PLAN_REVIEW',
      phaseLabel: 'Ready for plan approval',
      productNextAction: {
        text: 'Plan ready.',
        commands: ['/approve', '/request-changes', '/reject'],
      },
      planVersion: 3,
      policyMode: 'team',
      taskTitle: 'Add payment validation',
      forcedConvergence: false,
    });
    expect(card).toBe(await readGolden('review-plan-approved.md'));
  });

  it('review-plan-changes-requested matches golden output', async () => {
    const card = buildPlanReviewCard({
      planText: planBody,
      phase: 'PLAN_REVIEW',
      phaseLabel: 'Ready for plan approval',
      productNextAction: {
        text: 'Plan needs revision.',
        commands: ['/approve', '/request-changes', '/reject'],
      },
      planVersion: 2,
      policyMode: 'team',
      taskTitle: 'Add payment validation',
      forcedConvergence: true,
    });
    expect(card).toBe(await readGolden('review-plan-changes-requested.md'));
  });

  it('injects proof obligations section when proofSummary is provided', () => {
    const card = buildPlanReviewCard({
      planText: fullPlanBody,
      phase: 'PLAN_REVIEW',
      phaseLabel: 'Ready for plan approval',
      productNextAction: {
        text: 'Review the plan.',
        commands: ['/approve', '/request-changes'],
      },
      planVersion: 1,
      proofSummary: {
        kind: 'declaration',
        flow: 'plan',
        claimCount: 2,
        criticalCount: 1,
      },
    });
    expect(card).toContain('## Proof obligations');
    expect(card).toContain('2 plan claim(s) declared');
    expect(card).toContain('1 critical');
    expect(card).toContain('AWAITING EVIDENCE');
  });

  it('omits proof obligations section when proofSummary is absent', () => {
    const card = buildPlanReviewCard({
      planText: fullPlanBody,
      phase: 'PLAN_REVIEW',
      phaseLabel: 'Ready for plan approval',
      productNextAction: {
        text: 'Review the plan.',
        commands: ['/approve', '/request-changes'],
      },
      planVersion: 1,
    });
    expect(card).not.toContain('## Proof obligations');
  });
});
