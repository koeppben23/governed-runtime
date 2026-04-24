/**
 * @module integration/review-enforcement.test
 * @description Tests for the review enforcement module (4-level enforcement).
 *
 * Validates that the plugin-level enforcement correctly:
 * - Level 1 (Binary Gate): Blocks verdicts when subagent was not called
 * - Level 2 (Session ID): Blocks verdicts with mismatched session IDs
 * - Level 3 (Prompt Integrity): Blocks subagent calls with empty/incomplete prompts
 * - Level 4 (Findings Integrity): Blocks verdicts with modified findings
 * - Clears state after successful verdict cycles
 * - Handles multi-iteration flows correctly
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all categories present.
 */

import { describe, it, expect } from 'vitest';
import {
  createSessionState,
  onFlowGuardToolAfter,
  onTaskToolAfter,
  enforceBeforeVerdict,
  enforceBeforeSubagentCall,
  matchPendingReview,
  recordPluginReview,
  extractContentMeta,
  extractCapturedFindings,
  promptContainsValue,
  REVIEW_REQUIRED_PREFIX,
  REVIEWER_SUBAGENT_TYPE,
  MIN_SUBAGENT_PROMPT_LENGTH,
  type SessionEnforcementState,
} from './review-enforcement.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOW = '2026-04-24T12:00:00.000Z';
const LATER = '2026-04-24T12:01:00.000Z';

/** Build a Mode A response with INDEPENDENT_REVIEW_REQUIRED containing iteration and planVersion. */
function modeASubagentResponse(
  opts: { iteration?: number; planVersion?: number; phase?: string } = {},
): string {
  const { iteration = 0, planVersion = 1, phase = 'PLAN' } = opts;
  return JSON.stringify({
    phase,
    status: `Plan submitted (v${planVersion}).`,
    selfReviewIteration: iteration,
    reviewMode: 'subagent',
    next:
      `${REVIEW_REQUIRED_PREFIX}: Call the flowguard-reviewer subagent via Task tool. ` +
      `Use subagent_type "flowguard-reviewer" with a prompt that includes: ` +
      `(1) the full plan text, (2) the ticket text, (3) iteration=${iteration}, ` +
      `(4) planVersion=${planVersion}.`,
  });
}

/** Build a Mode A response with self-review next (no subagent). */
function modeASelfReviewResponse(): string {
  return JSON.stringify({
    phase: 'PLAN',
    status: 'Plan submitted (v1).',
    reviewMode: 'self',
    next: 'Self-review needed. Review the plan critically against the ticket.',
  });
}

/** Build a Mode B success response. */
function modeBSuccessResponse(): string {
  return JSON.stringify({
    phase: 'PLAN',
    status: 'Self-review iteration 1/3. Verdict: approve.',
    reviewMode: 'subagent',
  });
}

/** Build a Mode B error response. */
function modeBErrorResponse(): string {
  return JSON.stringify({
    error: true,
    code: 'REVISED_PLAN_REQUIRED',
  });
}

/** Build a Task tool result with subagent findings. */
function taskResultWithFindings(
  sessionId: string,
  opts: {
    verdict?: string;
    blockingIssues?: unknown[];
  } = {},
): string {
  const { verdict = 'approve', blockingIssues = [] } = opts;
  return JSON.stringify({
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: verdict,
    blockingIssues,
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId },
    reviewedAt: NOW,
  });
}

/** Build a Task tool result with embedded text around JSON. */
function taskResultWithEmbeddedFindings(
  sessionId: string,
  opts: { verdict?: string; blockingIssues?: unknown[] } = {},
): string {
  return `Here are my review findings:\n${taskResultWithFindings(sessionId, opts)}\nEnd of review.`;
}

/** Build a substantive prompt for the subagent (meets MIN_SUBAGENT_PROMPT_LENGTH). */
function validSubagentPrompt(opts: { iteration?: number; planVersion?: number } = {}): string {
  const { iteration = 0, planVersion = 1 } = opts;
  return (
    `Review this plan critically. The plan proposes implementing a new feature ` +
    `for user authentication with OAuth2 integration. ` +
    `Ticket: PROJ-123 - Add OAuth2 login flow. ` +
    `iteration=${iteration}, planVersion=${planVersion}. ` +
    `Check for completeness, correctness, feasibility, risk, and quality. ` +
    `Return structured ReviewFindings JSON with your assessment.`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('review-enforcement', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('full cycle plan: Mode A → valid subagent call → matching verdict → allowed', () => {
      const state = createSessionState();

      // Mode A: plan returns INDEPENDENT_REVIEW_REQUIRED
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 0, planVersion: 3 }),
        NOW,
      );

      // L3: valid subagent call with correct prompt
      const prompt = validSubagentPrompt({ iteration: 0, planVersion: 3 });
      const l3 = enforceBeforeSubagentCall(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt,
      });
      expect(l3.allowed).toBe(true);

      // Task completes with findings
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt },
        taskResultWithFindings('sub-session-1'),
        LATER,
      );

      // L1+L2+L4: verdict with matching findings → allowed
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
        reviewFindings: {
          overallVerdict: 'approve',
          blockingIssues: [],
          reviewedBy: { sessionId: 'sub-session-1' },
        },
      });

      expect(result.allowed).toBe(true);
    });

    it('full cycle implement: Mode A → valid subagent call → matching verdict → allowed', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_implement',
        {},
        modeASubagentResponse({ iteration: 1, planVersion: 2, phase: 'IMPLEMENTATION' }),
        NOW,
      );

      const prompt = validSubagentPrompt({ iteration: 1, planVersion: 2 });
      const l3 = enforceBeforeSubagentCall(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt,
      });
      expect(l3.allowed).toBe(true);

      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt },
        taskResultWithFindings('sub-session-2'),
        LATER,
      );

      const result = enforceBeforeVerdict(state, 'flowguard_implement', {
        reviewVerdict: 'approve',
        reviewFindings: {
          overallVerdict: 'approve',
          blockingIssues: [],
          reviewedBy: { sessionId: 'sub-session-2' },
        },
      });

      expect(result.allowed).toBe(true);
    });

    it('no enforcement when self-review mode (no INDEPENDENT_REVIEW_REQUIRED)', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASelfReviewResponse(),
        NOW,
      );

      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
      });

      expect(result.allowed).toBe(true);
    });

    it('clears pending review after successful Mode B', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );
      expect(state.pendingReviews.size).toBe(1);

      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithFindings('s1'),
        LATER,
      );

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { selfReviewVerdict: 'approve', reviewFindings: {} },
        modeBSuccessResponse(),
        LATER,
      );

      expect(state.pendingReviews.size).toBe(0);
    });

    it('Mode A calls (initial submission) always allowed without enforcement', () => {
      const state = createSessionState();

      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        planText: '## Plan',
      });

      expect(result.allowed).toBe(true);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    // ── Level 1: Binary Gate ─────────────────────────────────
    it('L1: blocks plan verdict when subagent was NOT called', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
        reviewFindings: {
          reviewMode: 'subagent',
          reviewedBy: { sessionId: 'fabricated-id' },
        },
      });

      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_REVIEW_NOT_INVOKED');
    });

    it('L1: blocks implement verdict when subagent was NOT called', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_implement',
        {},
        modeASubagentResponse({ phase: 'IMPLEMENTATION' }),
        NOW,
      );

      const result = enforceBeforeVerdict(state, 'flowguard_implement', {
        reviewVerdict: 'changes_requested',
      });

      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_REVIEW_NOT_INVOKED');
    });

    it('L1: blocks changes_requested verdict too (not just approve)', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'changes_requested',
        planText: '## Revised plan',
      });

      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_REVIEW_NOT_INVOKED');
    });

    // ── Level 2: Session ID Match ────────────────────────────
    it('L2: blocks verdict with mismatched sessionId', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithFindings('real-session-123'),
        LATER,
      );

      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
        reviewFindings: {
          overallVerdict: 'approve',
          blockingIssues: [],
          reviewedBy: { sessionId: 'tampered-session-456' },
        },
      });

      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_SESSION_MISMATCH');
    });

    // ── Level 3: Prompt Integrity ────────────────────────────
    it('L3: blocks subagent call with empty prompt', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      const result = enforceBeforeSubagentCall(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt: '',
      });

      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_PROMPT_EMPTY');
    });

    it('L3: blocks subagent call with trivially short prompt', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 0, planVersion: 1 }),
        NOW,
      );

      const result = enforceBeforeSubagentCall(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt: 'Review the plan. iteration=0, planVersion=1',
      });

      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_PROMPT_EMPTY');
    });

    it('L3: blocks subagent call when prompt missing iteration', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 2, planVersion: 5 }),
        NOW,
      );

      // Long enough but missing iteration=2
      const prompt =
        'Review this plan. It covers authentication, authorization, and session management. ' +
        'The plan proposes implementing a new feature for user authentication with OAuth2. ' +
        'planVersion=5. Check for completeness.';

      const result = enforceBeforeSubagentCall(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt,
      });

      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_PROMPT_MISSING_CONTEXT');
      if (!result.allowed) {
        expect(result.reason).toContain('iteration=2');
      }
    });

    it('L3: blocks subagent call when prompt missing planVersion', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 0, planVersion: 7 }),
        NOW,
      );

      // Long enough, has iteration but wrong planVersion
      const prompt =
        'Review this plan critically. iteration=0. The plan proposes implementing a new feature ' +
        'for user authentication with OAuth2 integration. Check completeness and correctness. ' +
        'Return structured ReviewFindings JSON.';

      const result = enforceBeforeSubagentCall(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt,
      });

      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_PROMPT_MISSING_CONTEXT');
      if (!result.allowed) {
        expect(result.reason).toContain('planVersion=7');
      }
    });

    // ── Level 4: Findings Integrity ──────────────────────────
    it('L4: blocks verdict when overallVerdict was modified (changes_requested → approve)', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      // Subagent returns changes_requested
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithFindings('s1', { verdict: 'changes_requested' }),
        LATER,
      );

      // Agent submits approve instead
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
        reviewFindings: {
          overallVerdict: 'approve',
          blockingIssues: [],
          reviewedBy: { sessionId: 's1' },
        },
      });

      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_FINDINGS_VERDICT_MISMATCH');
    });

    it('L4: blocks verdict when blockingIssues count was reduced', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      // Subagent returns 3 blocking issues
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithFindings('s1', {
          verdict: 'changes_requested',
          blockingIssues: [
            { severity: 'critical', description: 'Issue 1' },
            { severity: 'major', description: 'Issue 2' },
            { severity: 'major', description: 'Issue 3' },
          ],
        }),
        LATER,
      );

      // Agent submits only 1 blocking issue (removed 2)
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'changes_requested',
        reviewFindings: {
          overallVerdict: 'changes_requested',
          blockingIssues: [{ severity: 'critical', description: 'Issue 1' }],
          reviewedBy: { sessionId: 's1' },
        },
      });

      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_FINDINGS_ISSUES_MISMATCH');
    });

    it('L4: blocks verdict when blockingIssues were added (inflated)', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      // Subagent returns 0 blocking issues
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithFindings('s1', { verdict: 'approve', blockingIssues: [] }),
        LATER,
      );

      // Agent adds phantom blocking issues
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
        reviewFindings: {
          overallVerdict: 'approve',
          blockingIssues: [{ severity: 'critical', description: 'Phantom issue' }],
          reviewedBy: { sessionId: 's1' },
        },
      });

      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_FINDINGS_ISSUES_MISMATCH');
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('does not enforce for non-FlowGuard tools', () => {
      const state = createSessionState();
      const result = enforceBeforeVerdict(state, 'bash', { command: 'npm test' });
      expect(result.allowed).toBe(true);
    });

    it('does not enforce for flowguard_status', () => {
      const state = createSessionState();
      const result = enforceBeforeVerdict(state, 'flowguard_status', {});
      expect(result.allowed).toBe(true);
    });

    it('handles non-JSON tool output gracefully', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(state, 'flowguard_plan', { planText: '## Plan' }, 'not json', NOW);
      expect(state.pendingReviews.size).toBe(0);
    });

    it('does not clear pending on Mode B error response', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );
      expect(state.pendingReviews.size).toBe(1);

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { selfReviewVerdict: 'changes_requested' },
        modeBErrorResponse(),
        LATER,
      );

      expect(state.pendingReviews.size).toBe(1);
    });

    it('ignores Task calls to other subagents', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      onTaskToolAfter(
        state,
        { subagent_type: 'explore', prompt: 'Find files' },
        'some result',
        LATER,
      );

      const pending = state.pendingReviews.get('flowguard_plan');
      expect(pending?.subagentCalled).toBe(false);
    });

    it('plan and implement have independent pending reviews', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );
      onFlowGuardToolAfter(
        state,
        'flowguard_implement',
        {},
        modeASubagentResponse({ phase: 'IMPLEMENTATION' }),
        NOW,
      );

      expect(state.pendingReviews.size).toBe(2);
      expect(state.pendingReviews.has('flowguard_plan')).toBe(true);
      expect(state.pendingReviews.has('flowguard_implement')).toBe(true);
    });

    it('two pending reviews: plan prompt satisfies only plan pending (P34 1:1)', () => {
      const state = createSessionState();

      // Plan pending: iteration=0, planVersion=3
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 0, planVersion: 3 }),
        NOW,
      );
      // Implement pending: iteration=1, planVersion=3
      onFlowGuardToolAfter(
        state,
        'flowguard_implement',
        {},
        modeASubagentResponse({ iteration: 1, planVersion: 3, phase: 'IMPLEMENTATION' }),
        NOW,
      );
      expect(state.pendingReviews.size).toBe(2);

      // Task call with plan-matching prompt (iteration=0)
      onTaskToolAfter(
        state,
        {
          subagent_type: REVIEWER_SUBAGENT_TYPE,
          prompt: validSubagentPrompt({ iteration: 0, planVersion: 3 }),
        },
        taskResultWithFindings('plan-session'),
        LATER,
      );

      const planPending = state.pendingReviews.get('flowguard_plan');
      const implPending = state.pendingReviews.get('flowguard_implement');
      expect(planPending?.subagentCalled).toBe(true);
      expect(planPending?.subagentRecord?.sessionId).toBe('plan-session');
      expect(implPending?.subagentCalled).toBe(false);
      expect(implPending?.subagentRecord).toBeNull();
    });

    it('two pending reviews: implement prompt satisfies only implement pending (P34 1:1)', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 0, planVersion: 3 }),
        NOW,
      );
      onFlowGuardToolAfter(
        state,
        'flowguard_implement',
        {},
        modeASubagentResponse({ iteration: 1, planVersion: 3, phase: 'IMPLEMENTATION' }),
        NOW,
      );

      // Task call with implement-matching prompt (iteration=1)
      onTaskToolAfter(
        state,
        {
          subagent_type: REVIEWER_SUBAGENT_TYPE,
          prompt: validSubagentPrompt({ iteration: 1, planVersion: 3 }),
        },
        taskResultWithFindings('impl-session'),
        LATER,
      );

      const planPending = state.pendingReviews.get('flowguard_plan');
      const implPending = state.pendingReviews.get('flowguard_implement');
      expect(planPending?.subagentCalled).toBe(false);
      expect(implPending?.subagentCalled).toBe(true);
      expect(implPending?.subagentRecord?.sessionId).toBe('impl-session');
    });

    it('two pending reviews require two separate subagent calls (P34 1:1)', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 0, planVersion: 3 }),
        NOW,
      );
      onFlowGuardToolAfter(
        state,
        'flowguard_implement',
        {},
        modeASubagentResponse({ iteration: 1, planVersion: 3, phase: 'IMPLEMENTATION' }),
        NOW,
      );

      // First call satisfies plan
      onTaskToolAfter(
        state,
        {
          subagent_type: REVIEWER_SUBAGENT_TYPE,
          prompt: validSubagentPrompt({ iteration: 0, planVersion: 3 }),
        },
        taskResultWithFindings('plan-session'),
        LATER,
      );

      // Second call satisfies implement
      onTaskToolAfter(
        state,
        {
          subagent_type: REVIEWER_SUBAGENT_TYPE,
          prompt: validSubagentPrompt({ iteration: 1, planVersion: 3 }),
        },
        taskResultWithFindings('impl-session'),
        LATER,
      );

      const planPending = state.pendingReviews.get('flowguard_plan');
      const implPending = state.pendingReviews.get('flowguard_implement');
      expect(planPending?.subagentCalled).toBe(true);
      expect(planPending?.subagentRecord?.sessionId).toBe('plan-session');
      expect(implPending?.subagentCalled).toBe(true);
      expect(implPending?.subagentRecord?.sessionId).toBe('impl-session');
    });

    it('two pending reviews: non-matching prompt satisfies neither (fail-closed)', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 0, planVersion: 3 }),
        NOW,
      );
      onFlowGuardToolAfter(
        state,
        'flowguard_implement',
        {},
        modeASubagentResponse({ iteration: 1, planVersion: 3, phase: 'IMPLEMENTATION' }),
        NOW,
      );

      // Task call with non-matching prompt (iteration=99)
      onTaskToolAfter(
        state,
        {
          subagent_type: REVIEWER_SUBAGENT_TYPE,
          prompt: validSubagentPrompt({ iteration: 99, planVersion: 3 }),
        },
        taskResultWithFindings('orphan-session'),
        LATER,
      );

      const planPending = state.pendingReviews.get('flowguard_plan');
      const implPending = state.pendingReviews.get('flowguard_implement');
      expect(planPending?.subagentCalled).toBe(false);
      expect(implPending?.subagentCalled).toBe(false);
    });

    it('single pending is matched without prompt content validation (unambiguous)', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 0, planVersion: 3 }),
        NOW,
      );

      // Task call with non-matching prompt — but only 1 pending, so unambiguous
      onTaskToolAfter(
        state,
        {
          subagent_type: REVIEWER_SUBAGENT_TYPE,
          prompt: 'Minimal prompt without matching context',
        },
        taskResultWithFindings('s1'),
        LATER,
      );

      const pending = state.pendingReviews.get('flowguard_plan');
      expect(pending?.subagentCalled).toBe(true);
    });

    it('fresh session state has no pending reviews', () => {
      const state = createSessionState();
      expect(state.pendingReviews.size).toBe(0);
    });

    it('allows verdict when no pending review exists (enforcement inactive)', () => {
      const state = createSessionState();

      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
      });

      expect(result.allowed).toBe(true);
    });

    it('L2: skips session-ID check when submitted sessionId is missing', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithFindings('real-session'),
        LATER,
      );

      // No sessionId in submitted findings → L2 skipped
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
        reviewFindings: {
          overallVerdict: 'approve',
          blockingIssues: [],
          reviewedBy: {},
        },
      });

      expect(result.allowed).toBe(true);
    });

    it('L2: skips session-ID check when actual sessionId is null (extraction failed)', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      // Task returns non-parseable response → sessionId = null (strict, no fallback)
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        'Plain text response without JSON',
        LATER,
      );

      const pending = state.pendingReviews.get('flowguard_plan');
      expect(pending?.subagentRecord?.sessionId).toBeNull();

      // Verdict with any sessionId → L2 skipped (actual is null)
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
        reviewFindings: {
          reviewedBy: { sessionId: 'any-id' },
        },
      });

      expect(result.allowed).toBe(true);
    });

    it('L3: allows subagent call when no pending reviews exist', () => {
      const state = createSessionState();

      // No prior FlowGuard tool call → no pending review
      const result = enforceBeforeSubagentCall(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt: validSubagentPrompt(),
      });

      expect(result.allowed).toBe(true);
    });

    it('L3: allows when subagent_type is not flowguard-reviewer', () => {
      const state = createSessionState();

      const result = enforceBeforeSubagentCall(state, {
        subagent_type: 'explore',
        prompt: '',
      });

      expect(result.allowed).toBe(true);
    });

    it('L3: allows when contentMeta extraction failed (defensive)', () => {
      const state = createSessionState();

      // Manually set pending review with null contentMeta (simulates extraction failure)
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        // next field without iteration/planVersion — contentMeta will be null
        JSON.stringify({
          phase: 'PLAN',
          reviewMode: 'subagent',
          next: `${REVIEW_REQUIRED_PREFIX}: Review the plan.`,
        }),
        NOW,
      );

      const pending = state.pendingReviews.get('flowguard_plan');
      expect(pending?.contentMeta).toBeNull();

      // Should allow (can't validate without content meta)
      const result = enforceBeforeSubagentCall(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt: validSubagentPrompt(),
      });

      expect(result.allowed).toBe(true);
    });

    it('L3: prompt matches one of multiple pending reviews → allowed', () => {
      const state = createSessionState();

      // Plan pending: iteration=0, planVersion=3
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 0, planVersion: 3 }),
        NOW,
      );

      // Implement pending: iteration=1, planVersion=3
      onFlowGuardToolAfter(
        state,
        'flowguard_implement',
        {},
        modeASubagentResponse({ iteration: 1, planVersion: 3, phase: 'IMPLEMENTATION' }),
        NOW,
      );

      // Prompt matches implement (iteration=1, version=3) but not plan (iteration=0)
      const prompt = validSubagentPrompt({ iteration: 1, planVersion: 3 });
      const result = enforceBeforeSubagentCall(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt,
      });

      expect(result.allowed).toBe(true);
    });

    it('L4: skips when no reviewFindings submitted (structural validation handles this)', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithFindings('s1', { verdict: 'changes_requested' }),
        LATER,
      );

      // No reviewFindings in args → L4 skipped
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'changes_requested',
        planText: '## Revised plan',
      });

      expect(result.allowed).toBe(true);
    });

    it('L4: skips when capturedFindings is null (subagent returned non-parseable output)', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      // Non-parseable subagent output → capturedFindings = null
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        'The plan looks good. I approve everything.',
        LATER,
      );

      const pending = state.pendingReviews.get('flowguard_plan');
      expect(pending?.capturedFindings).toBeNull();

      // L4 skipped, L1 passes (subagent was called), L2 skipped (null sessionId)
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
        reviewFindings: {
          overallVerdict: 'approve',
          blockingIssues: [],
          reviewedBy: { sessionId: 'some-id' },
        },
      });

      expect(result.allowed).toBe(true);
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('extracts sessionId from embedded JSON in Task result', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithEmbeddedFindings('embedded-session-id'),
        LATER,
      );

      const pending = state.pendingReviews.get('flowguard_plan');
      expect(pending?.subagentRecord?.sessionId).toBe('embedded-session-id');
    });

    it('sessionId is null when extraction fails (strict, no fallback)', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        'The plan looks good. I approve.',
        LATER,
      );

      const pending = state.pendingReviews.get('flowguard_plan');
      expect(pending?.subagentCalled).toBe(true);
      expect(pending?.subagentRecord?.sessionId).toBeNull();
    });

    it('capturedFindings extracted from embedded JSON in task result', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithEmbeddedFindings('s1', {
          verdict: 'changes_requested',
          blockingIssues: [{ severity: 'critical', description: 'Missing auth' }],
        }),
        LATER,
      );

      const pending = state.pendingReviews.get('flowguard_plan');
      expect(pending?.capturedFindings?.overallVerdict).toBe('changes_requested');
      expect(pending?.capturedFindings?.blockingIssuesCount).toBe(1);
    });

    it('handles empty args gracefully in onFlowGuardToolAfter', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);
      expect(state.pendingReviews.size).toBe(1);
    });

    it('handles empty args gracefully in onTaskToolAfter', () => {
      const state = createSessionState();
      onTaskToolAfter(state, {}, 'result', NOW);
      expect(state.pendingReviews.size).toBe(0);
    });

    it('handles empty args gracefully in enforceBeforeVerdict', () => {
      const state = createSessionState();
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {});
      expect(result.allowed).toBe(true);
    });

    it('handles empty args gracefully in enforceBeforeSubagentCall', () => {
      const state = createSessionState();
      const result = enforceBeforeSubagentCall(state, {});
      expect(result.allowed).toBe(true);
    });

    it('multi-iteration: re-signals review after changes_requested cycle', () => {
      const state = createSessionState();

      // Iteration 1: Mode A → pending
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan v1' },
        modeASubagentResponse({ iteration: 0, planVersion: 1 }),
        NOW,
      );
      expect(state.pendingReviews.size).toBe(1);

      // Iteration 1: Task call
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithFindings('iter1-session', { verdict: 'changes_requested' }),
        LATER,
      );

      // Iteration 1: Mode B success → clears pending
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        {
          selfReviewVerdict: 'changes_requested',
          planText: '## Plan v2',
          reviewFindings: {
            overallVerdict: 'changes_requested',
            blockingIssues: [],
            reviewedBy: { sessionId: 'iter1-session' },
          },
        },
        modeBSuccessResponse(),
        LATER,
      );
      expect(state.pendingReviews.size).toBe(0);

      // Iteration 2: non-converged Mode B with new INDEPENDENT_REVIEW_REQUIRED
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan v2' },
        modeASubagentResponse({ iteration: 1, planVersion: 2 }),
        LATER,
      );
      expect(state.pendingReviews.size).toBe(1);

      // Iteration 2: verdict WITHOUT subagent → blocked
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
      });
      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_REVIEW_NOT_INVOKED');
    });

    it('review enforcement result includes descriptive reason', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
      });

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('INDEPENDENT_REVIEW_REQUIRED');
        expect(result.reason).toContain(REVIEWER_SUBAGENT_TYPE);
        expect(result.reason).toContain('Task tool');
      }
    });

    it('L4: allows when submitted verdict matches captured (changes_requested → changes_requested)', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      // Subagent says changes_requested with 2 issues
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithFindings('s1', {
          verdict: 'changes_requested',
          blockingIssues: [
            { severity: 'critical', description: 'Issue 1' },
            { severity: 'major', description: 'Issue 2' },
          ],
        }),
        LATER,
      );

      // Agent faithfully submits same verdict and count
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'changes_requested',
        planText: '## Revised plan',
        reviewFindings: {
          overallVerdict: 'changes_requested',
          blockingIssues: [
            { severity: 'critical', description: 'Issue 1' },
            { severity: 'major', description: 'Issue 2' },
          ],
          reviewedBy: { sessionId: 's1' },
        },
      });

      expect(result.allowed).toBe(true);
    });
  });

  // ─── HELPER FUNCTIONS ──────────────────────────────────────
  describe('matchPendingReview', () => {
    it('returns null when no pending reviews exist', () => {
      const state = createSessionState();
      const result = matchPendingReview(state, { prompt: 'anything' });
      expect(result).toBeNull();
    });

    it('returns single pending automatically (unambiguous)', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 0, planVersion: 5 }),
        NOW,
      );

      // Prompt does NOT match contentMeta — but single pending = unambiguous
      const result = matchPendingReview(state, { prompt: 'no matching context' });
      expect(result).not.toBeNull();
      expect(result?.tool).toBe('flowguard_plan');
    });

    it('matches by contentMeta when multiple pending (iteration distinguishes)', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 0, planVersion: 3 }),
        NOW,
      );
      onFlowGuardToolAfter(
        state,
        'flowguard_implement',
        {},
        modeASubagentResponse({ iteration: 1, planVersion: 3, phase: 'IMPLEMENTATION' }),
        NOW,
      );

      const result = matchPendingReview(state, {
        prompt: validSubagentPrompt({ iteration: 1, planVersion: 3 }),
      });
      expect(result).not.toBeNull();
      expect(result?.tool).toBe('flowguard_implement');
    });

    it('returns null when multiple pending and no contentMeta match (fail-closed)', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 0, planVersion: 3 }),
        NOW,
      );
      onFlowGuardToolAfter(
        state,
        'flowguard_implement',
        {},
        modeASubagentResponse({ iteration: 1, planVersion: 3, phase: 'IMPLEMENTATION' }),
        NOW,
      );

      const result = matchPendingReview(state, {
        prompt: validSubagentPrompt({ iteration: 99, planVersion: 99 }),
      });
      expect(result).toBeNull();
    });

    it('skips already-called pending reviews', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 0, planVersion: 3 }),
        NOW,
      );
      onFlowGuardToolAfter(
        state,
        'flowguard_implement',
        {},
        modeASubagentResponse({ iteration: 1, planVersion: 3, phase: 'IMPLEMENTATION' }),
        NOW,
      );

      // First call satisfies plan
      onTaskToolAfter(
        state,
        {
          subagent_type: REVIEWER_SUBAGENT_TYPE,
          prompt: validSubagentPrompt({ iteration: 0, planVersion: 3 }),
        },
        taskResultWithFindings('s1'),
        LATER,
      );

      // Now only implement is uncalled — should match it unambiguously
      const result = matchPendingReview(state, { prompt: 'any prompt' });
      expect(result).not.toBeNull();
      expect(result?.tool).toBe('flowguard_implement');
    });

    it('returns null when multiple pending have null contentMeta (fail-closed)', () => {
      const state = createSessionState();
      // Both pending reviews have null contentMeta (extraction failed)
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        JSON.stringify({
          phase: 'PLAN',
          reviewMode: 'subagent',
          next: `${REVIEW_REQUIRED_PREFIX}: Review the plan.`,
        }),
        NOW,
      );
      onFlowGuardToolAfter(
        state,
        'flowguard_implement',
        {},
        JSON.stringify({
          phase: 'IMPLEMENTATION',
          reviewMode: 'subagent',
          next: `${REVIEW_REQUIRED_PREFIX}: Review the implementation.`,
        }),
        NOW,
      );

      const plan = state.pendingReviews.get('flowguard_plan');
      const impl = state.pendingReviews.get('flowguard_implement');
      expect(plan?.contentMeta).toBeNull();
      expect(impl?.contentMeta).toBeNull();

      const result = matchPendingReview(state, {
        prompt: validSubagentPrompt({ iteration: 0, planVersion: 1 }),
      });
      expect(result).toBeNull();
    });
  });

  describe('extractContentMeta', () => {
    it('extracts iteration and planVersion from standard format', () => {
      const meta = extractContentMeta(
        'INDEPENDENT_REVIEW_REQUIRED: ... iteration=0, (4) planVersion=3.',
      );
      expect(meta).toEqual({ expectedIteration: 0, expectedPlanVersion: 3 });
    });

    it('extracts iteration and planVersion with different separators', () => {
      const meta = extractContentMeta('INDEPENDENT_REVIEW_REQUIRED: iteration: 2, planVersion: 5');
      expect(meta).toEqual({ expectedIteration: 2, expectedPlanVersion: 5 });
    });

    it('returns null planVersion when only iteration present', () => {
      const meta = extractContentMeta('INDEPENDENT_REVIEW_REQUIRED: iteration=1');
      expect(meta).toEqual({ expectedIteration: 1, expectedPlanVersion: null });
    });

    it('returns null when iteration is missing', () => {
      const meta = extractContentMeta(
        'INDEPENDENT_REVIEW_REQUIRED: Review the plan. planVersion=3',
      );
      expect(meta).toBeNull();
    });
  });

  describe('extractCapturedFindings', () => {
    it('extracts from clean JSON', () => {
      const findings = extractCapturedFindings(
        JSON.stringify({
          overallVerdict: 'approve',
          blockingIssues: [],
          reviewedBy: { sessionId: 's1' },
        }),
      );
      expect(findings).toEqual({
        overallVerdict: 'approve',
        blockingIssuesCount: 0,
        sessionId: 's1',
      });
    });

    it('extracts from JSON with blocking issues', () => {
      const findings = extractCapturedFindings(
        JSON.stringify({
          overallVerdict: 'changes_requested',
          blockingIssues: [
            { severity: 'critical', description: 'Issue 1' },
            { severity: 'major', description: 'Issue 2' },
          ],
          reviewedBy: { sessionId: 's2' },
        }),
      );
      expect(findings).toEqual({
        overallVerdict: 'changes_requested',
        blockingIssuesCount: 2,
        sessionId: 's2',
      });
    });

    it('extracts from text with embedded JSON', () => {
      const findings = extractCapturedFindings(
        'Here are my findings:\n' +
          JSON.stringify({
            overallVerdict: 'approve',
            blockingIssues: [],
            reviewedBy: { sessionId: 's3' },
          }) +
          '\nDone.',
      );
      expect(findings).not.toBeNull();
      expect(findings?.overallVerdict).toBe('approve');
    });

    it('returns null for plain text', () => {
      const findings = extractCapturedFindings('The plan looks good. I approve.');
      expect(findings).toBeNull();
    });

    it('returns null for JSON without overallVerdict', () => {
      const findings = extractCapturedFindings(JSON.stringify({ phase: 'PLAN', status: 'ok' }));
      expect(findings).toBeNull();
    });

    it('handles missing reviewedBy gracefully', () => {
      const findings = extractCapturedFindings(
        JSON.stringify({
          overallVerdict: 'approve',
          blockingIssues: [],
        }),
      );
      expect(findings).toEqual({
        overallVerdict: 'approve',
        blockingIssuesCount: 0,
        sessionId: null,
      });
    });
  });

  describe('promptContainsValue', () => {
    it('matches "iteration=0" format', () => {
      expect(promptContainsValue('Review plan. iteration=0, planVersion=1.', 'iteration', 0)).toBe(
        true,
      );
    });

    it('matches "iteration: 2" format', () => {
      expect(promptContainsValue('The iteration: 2 needs review', 'iteration', 2)).toBe(true);
    });

    it('matches "Iteration 3" format (case-insensitive)', () => {
      expect(promptContainsValue('Iteration 3 of the plan', 'iteration', 3)).toBe(true);
    });

    it('matches "version=5" for planVersion', () => {
      expect(promptContainsValue('planVersion=5, review this', 'version', 5)).toBe(true);
    });

    it('does not match number in unrelated context', () => {
      // "0" appears in "2026-04-20" but not near "iteration"
      expect(promptContainsValue('Date: 2026-04-20. Review the plan.', 'iteration', 0)).toBe(false);
    });

    it('does not match partial number (12 should not match 1)', () => {
      // "1" appears as part of "12" but with word boundary should not match
      expect(promptContainsValue('iteration=12 of the plan', 'iteration', 1)).toBe(false);
    });

    it('matches when keyword and number have text between them', () => {
      expect(promptContainsValue('This is iteration number 5 of the review', 'iteration', 5)).toBe(
        true,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // recordPluginReview — Plugin-initiated review recording
  // ═══════════════════════════════════════════════════════════════════════════

  describe('recordPluginReview', () => {
    // HAPPY: records plugin review on pending plan review
    it('satisfies pending plan review and enables L1/L2/L4 pass', () => {
      const state = createSessionState();
      // Register pending review via Mode A response
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);
      expect(state.pendingReviews.get('flowguard_plan')?.subagentCalled).toBe(false);

      // Record plugin-initiated review
      const result = recordPluginReview(
        state,
        'flowguard_plan',
        'child-session-1',
        {
          overallVerdict: 'approve',
          blockingIssuesCount: 0,
          sessionId: 'child-session-1',
        },
        LATER,
      );

      expect(result).toBe(true);
      const pending = state.pendingReviews.get('flowguard_plan');
      expect(pending?.subagentCalled).toBe(true);
      expect(pending?.subagentRecord?.sessionId).toBe('child-session-1');
      expect(pending?.capturedFindings?.overallVerdict).toBe('approve');
      expect(pending?.capturedFindings?.blockingIssuesCount).toBe(0);

      // L1 check should pass now
      const enforcement = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
        reviewFindings: {
          overallVerdict: 'approve',
          blockingIssues: [],
          reviewedBy: { sessionId: 'child-session-1' },
        },
      });
      expect(enforcement.allowed).toBe(true);
    });

    // HAPPY: records plugin review on pending implement review
    it('satisfies pending implement review', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        'flowguard_implement',
        {},
        JSON.stringify({
          phase: 'IMPL_REVIEW',
          reviewMode: 'subagent',
          next: `${REVIEW_REQUIRED_PREFIX}: iteration=1, planVersion=2`,
        }),
        NOW,
      );

      const result = recordPluginReview(
        state,
        'flowguard_implement',
        'child-impl-session',
        {
          overallVerdict: 'changes_requested',
          blockingIssuesCount: 2,
          sessionId: 'child-impl-session',
        },
        LATER,
      );

      expect(result).toBe(true);
      const pending = state.pendingReviews.get('flowguard_implement');
      expect(pending?.subagentCalled).toBe(true);
      expect(pending?.capturedFindings?.blockingIssuesCount).toBe(2);
    });

    // BAD: no pending review for the tool
    it('returns false when no pending review exists', () => {
      const state = createSessionState();
      const result = recordPluginReview(state, 'flowguard_plan', 'child-session', null, NOW);
      expect(result).toBe(false);
    });

    // BAD: pending review already satisfied
    it('returns false when review was already satisfied', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);

      // First call succeeds
      expect(recordPluginReview(state, 'flowguard_plan', 'child-1', null, LATER)).toBe(true);

      // Second call fails — already satisfied
      expect(recordPluginReview(state, 'flowguard_plan', 'child-2', null, LATER)).toBe(false);
    });

    // BAD: invalid tool name
    it('returns false for non-reviewable tool', () => {
      const state = createSessionState();
      const result = recordPluginReview(state, 'flowguard_status', 'child-session', null, NOW);
      expect(result).toBe(false);
    });

    // CORNER: null captured findings (reviewer returned unparseable response)
    it('records with null captured findings', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);

      const result = recordPluginReview(
        state,
        'flowguard_plan',
        'child-session',
        null, // Findings parsing failed
        LATER,
      );

      expect(result).toBe(true);
      const pending = state.pendingReviews.get('flowguard_plan');
      expect(pending?.subagentCalled).toBe(true);
      expect(pending?.capturedFindings).toBeNull();
    });

    // CORNER: L4 catches tampered findings after plugin review
    it('L4 blocks when submitted verdict differs from plugin-captured verdict', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);

      recordPluginReview(
        state,
        'flowguard_plan',
        'child-session-1',
        {
          overallVerdict: 'changes_requested',
          blockingIssuesCount: 3,
          sessionId: 'child-session-1',
        },
        LATER,
      );

      // Try to submit "approve" when reviewer said "changes_requested"
      const enforcement = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
        reviewFindings: {
          overallVerdict: 'approve', // Tampered!
          blockingIssues: [],
          reviewedBy: { sessionId: 'child-session-1' },
        },
      });
      expect(enforcement.allowed).toBe(false);
      expect(enforcement.allowed === false && enforcement.code).toBe(
        'SUBAGENT_FINDINGS_VERDICT_MISMATCH',
      );
    });
  });
});
