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
  enforceReviewerObligation,
} from './enforcement.js';
import {
  REVIEW_REQUIRED_PREFIX,
  REVIEWER_SUBAGENT_TYPE,
  MIN_SUBAGENT_PROMPT_LENGTH,
} from './types.js';
import {
  NOW,
  LATER,
  modeASubagentResponse,
  modeANoReviewRequiredResponse,
  modeBSuccessResponse,
  modeBErrorResponse,
  taskResultWithFindings,
  taskResultWithEmbeddedFindings,
  validSubagentPrompt,
} from './test-helpers.js';
import {
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_REVIEW_IMPLEMENTATION,
  TOOL_FLOWGUARD_RUN_CHECK,
} from '../../tool-names.js';

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
        reviewVerdict: 'accept',
        reviewFindings: {
          overallVerdict: 'accept',
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
        reviewVerdict: 'accept',
        reviewFindings: {
          overallVerdict: 'accept',
          blockingIssues: [],
          reviewedBy: { sessionId: 'sub-session-2' },
        },
      });

      expect(result.allowed).toBe(true);
    });

    it('tracks a post-implementation check review signal under the implementation owner', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        TOOL_FLOWGUARD_RUN_CHECK,
        { kind: 'build' },
        modeASubagentResponse({ iteration: 1, planVersion: 2, phase: 'IMPL_REVIEW' }),
        NOW,
      );

      const prompt = validSubagentPrompt({ iteration: 1, planVersion: 2 });
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt },
        taskResultWithFindings('sub-session-check'),
        LATER,
      );

      expect(state.pendingReviews.get(TOOL_FLOWGUARD_IMPLEMENT)?.subagentCalled).toBe(true);
      expect(
        enforceBeforeVerdict(state, TOOL_FLOWGUARD_REVIEW_IMPLEMENTATION, {
          reviewVerdict: 'accept',
        }),
      ).toEqual({ allowed: true });
    });

    it('no enforcement when independent-review marker is absent', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeANoReviewRequiredResponse(),
        NOW,
      );

      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        reviewVerdict: 'accept',
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
        { reviewVerdict: 'accept', reviewFindings: {} },
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
        reviewVerdict: 'accept',
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
        reviewVerdict: 'changes_requested',
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
        reviewVerdict: 'accept',
        reviewFindings: {
          overallVerdict: 'accept',
          blockingIssues: [],
          reviewedBy: { sessionId: 'tampered-session-456' },
        },
      });

      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_SESSION_MISMATCH');
    });

    // ── Level 2: host_task ignores agent-submitted findings ───
    it('L2: host_task mode does NOT block on mismatched submitted findings session', () => {
      // Regression: in host_task_required mode the findings are host-captured and
      // bound; the agent cannot know the real child session id, and the tool layer
      // ignores submitted findings. A (disobedient) findings payload with a
      // non-matching reviewedBy.sessionId must NOT hard-block the verdict.
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

      const submitted = {
        reviewVerdict: 'accept',
        reviewFindings: {
          overallVerdict: 'accept',
          blockingIssues: [],
          reviewedBy: { sessionId: 'reviewer-self-reported-999' },
        },
      };

      // Non-host_task (default policy): still strictly rejected.
      const sdk = enforceBeforeVerdict(state, 'flowguard_plan', { ...submitted });
      expect(sdk.allowed).toBe(false);
      expect(sdk).toHaveProperty('code', 'SUBAGENT_SESSION_MISMATCH');

      // host_task_required (derived from policySnapshot): integrity of submitted
      // findings is skipped → allowed.
      const hostTask = enforceBeforeVerdict(
        state,
        'flowguard_plan',
        { ...submitted },
        {
          policySnapshot: { reviewInvocationPolicy: 'host_task_required' },
        },
      );
      expect(hostTask.allowed).toBe(true);
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
        reviewVerdict: 'accept',
        reviewFindings: {
          overallVerdict: 'accept',
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
        reviewVerdict: 'changes_requested',
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
        taskResultWithFindings('s1', { verdict: 'accept', blockingIssues: [] }),
        LATER,
      );

      // Agent adds phantom blocking issues
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        reviewVerdict: 'accept',
        reviewFindings: {
          overallVerdict: 'accept',
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
        { reviewVerdict: 'changes_requested' },
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
        reviewVerdict: 'accept',
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
        reviewVerdict: 'accept',
        reviewFindings: {
          overallVerdict: 'accept',
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
        reviewVerdict: 'accept',
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
        reviewVerdict: 'changes_requested',
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
        reviewVerdict: 'accept',
        reviewFindings: {
          overallVerdict: 'accept',
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
          reviewVerdict: 'changes_requested',
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
        reviewVerdict: 'accept',
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
        reviewVerdict: 'accept',
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
        reviewVerdict: 'changes_requested',
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

  // ─── F13: Architecture independent-review parity (slice 2) ──
  describe('F13 architecture tool-name gates', () => {
    it('onFlowGuardToolAfter accepts flowguard_architecture (no early return)', () => {
      const state = createSessionState();

      // Without slice 2, onFlowGuardToolAfter would early-return for architecture
      // and never register a pending review. With slice 2, the gate accepts it.
      onFlowGuardToolAfter(
        state,
        'flowguard_architecture',
        { adrText: '## ADR' },
        modeASubagentResponse({ phase: 'ARCHITECTURE' }),
        NOW,
      );

      // Pending review must be registered for architecture tool key
      expect(state.pendingReviews.has('flowguard_architecture')).toBe(true);
    });

    it('enforceBeforeVerdict accepts flowguard_architecture as ReviewableTool', () => {
      const state = createSessionState();

      // No pending review, no Mode B args → still allowed (gate widening only).
      const result = enforceBeforeVerdict(state, 'flowguard_architecture', {});
      expect(result.allowed).toBe(true);
    });

    it('enforceBeforeVerdict still rejects unrelated tools (negative)', () => {
      const state = createSessionState();
      const result = enforceBeforeVerdict(state, 'flowguard_status', {
        reviewVerdict: 'accept',
      });
      // Unrelated tools bypass review enforcement (no obligation matching).
      expect(result.allowed).toBe(true);
    });
  });

  // ─── MUTATION KILL: targeted gap coverage ───────────────────
  describe('MUTATION: targeted gap coverage', () => {
    // ── L122-126: CONTENT_ANALYSIS_REQUIRED path (NoCoverage) ──
    it('CONTENT_ANALYSIS_REQUIRED from standalone review tool sets pending review', () => {
      const state = createSessionState();
      const output = JSON.stringify({
        error: true,
        code: 'CONTENT_ANALYSIS_REQUIRED',
        requiredReviewAttestation: { required: true },
      });
      onFlowGuardToolAfter(state, 'flowguard_review', {}, output, NOW);

      // Should have registered a pending review for the standalone review tool
      expect(state.pendingReviews.has('flowguard_review')).toBe(true);
      const pending = state.pendingReviews.get('flowguard_review')!;
      expect(pending.subagentCalled).toBe(false);
      expect(pending.tool).toBe('flowguard_review');
    });

    it('CONTENT_ANALYSIS_REQUIRED NOT triggered from non-standalone tools', () => {
      const state = createSessionState();
      const output = JSON.stringify({
        error: true,
        code: 'CONTENT_ANALYSIS_REQUIRED',
        requiredReviewAttestation: { required: true },
      });
      // flowguard_plan is NOT the standalone review tool
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, output, NOW);
      expect(state.pendingReviews.has('flowguard_review')).toBe(false);
    });

    it('CONTENT_ANALYSIS_REQUIRED requires error===true (not just code match)', () => {
      const state = createSessionState();
      const output = JSON.stringify({
        error: false,
        code: 'CONTENT_ANALYSIS_REQUIRED',
        requiredReviewAttestation: { required: true },
      });
      onFlowGuardToolAfter(state, 'flowguard_review', {}, output, NOW);
      // error is not true, so the pending review should NOT be set via this path
      expect(state.pendingReviews.has('flowguard_review')).toBe(false);
    });

    it('CONTENT_ANALYSIS_REQUIRED requires requiredReviewAttestation to be truthy', () => {
      const state = createSessionState();
      const output = JSON.stringify({
        error: true,
        code: 'CONTENT_ANALYSIS_REQUIRED',
        // no requiredReviewAttestation field
      });
      onFlowGuardToolAfter(state, 'flowguard_review', {}, output, NOW);
      expect(state.pendingReviews.has('flowguard_review')).toBe(false);
    });

    // ── L156-157: enforceBeforeSubagentCall subagent type checks ──
    it('enforceBeforeSubagentCall allows non-string subagent_type (no enforcement)', () => {
      const state = createSessionState();
      // Set up pending review to make enforcement active
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );
      // Non-string subagent_type → not a reviewer → allowed
      const result = enforceBeforeSubagentCall(state, { subagent_type: 123, prompt: '' });
      expect(result.allowed).toBe(true);
    });

    it('enforceBeforeSubagentCall allows non-reviewer subagent_type', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );
      const result = enforceBeforeSubagentCall(state, {
        subagent_type: 'some-other-agent',
        prompt: '',
      });
      expect(result.allowed).toBe(true);
    });

    // ── L162: filter already-called pending reviews ──
    it('enforceBeforeSubagentCall ignores already-called pending reviews', () => {
      const state = createSessionState();
      // Register a pending review
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );
      // Complete the subagent call (marks subagentCalled=true)
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithFindings('s1'),
        LATER,
      );
      // Now the pending review is subagentCalled=true
      // A new subagent call should see 0 uncalled pending → allowed (no enforcement)
      const result = enforceBeforeSubagentCall(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt: 'x',
      });
      expect(result.allowed).toBe(true);
    });

    // ── L170: prompt length boundary (MIN_SUBAGENT_PROMPT_LENGTH) ──
    it('enforceBeforeSubagentCall: prompt at exact MIN_SUBAGENT_PROMPT_LENGTH is allowed', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 0, planVersion: 1 }),
        NOW,
      );
      // Prompt at exactly MIN_SUBAGENT_PROMPT_LENGTH with required context
      const prompt = 'iteration=0, planVersion=1. ' + 'x'.repeat(MIN_SUBAGENT_PROMPT_LENGTH - 28);
      expect(prompt.length).toBe(MIN_SUBAGENT_PROMPT_LENGTH);
      const result = enforceBeforeSubagentCall(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt,
      });
      expect(result.allowed).toBe(true);
    });

    it('enforceBeforeSubagentCall: prompt at MIN_SUBAGENT_PROMPT_LENGTH - 1 is blocked', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );
      const prompt = 'x'.repeat(MIN_SUBAGENT_PROMPT_LENGTH - 1);
      const result = enforceBeforeSubagentCall(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt,
      });
      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_PROMPT_EMPTY');
    });

    // ── L212-213: missing iteration/planVersion in prompt ──
    it('enforceBeforeSubagentCall: prompt missing iteration produces MISSING_CONTEXT', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 5, planVersion: 3 }),
        NOW,
      );
      // Long enough prompt but missing iteration=5
      const prompt = 'Review this plan. planVersion=3. ' + 'x'.repeat(MIN_SUBAGENT_PROMPT_LENGTH);
      const result = enforceBeforeSubagentCall(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt,
      });
      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_PROMPT_MISSING_CONTEXT');
      if (!result.allowed) {
        expect(result.reason).toContain('iteration=5');
      }
    });

    it('enforceBeforeSubagentCall: prompt missing planVersion produces MISSING_CONTEXT', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 2, planVersion: 7 }),
        NOW,
      );
      // Has iteration but NOT planVersion
      const prompt = 'Review this plan. iteration=2. ' + 'x'.repeat(MIN_SUBAGENT_PROMPT_LENGTH);
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

    // ── L259: onTaskToolAfter ignores non-reviewer subagent type ──
    it('onTaskToolAfter ignores non-reviewer subagent type (no state mutation)', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );
      // Non-reviewer subagent type → no state change
      onTaskToolAfter(
        state,
        { subagent_type: 'some-other-agent', prompt: 'review' },
        taskResultWithFindings('s1'),
        LATER,
      );
      const pending = state.pendingReviews.get('flowguard_plan')!;
      expect(pending.subagentCalled).toBe(false);
    });

    it('onTaskToolAfter ignores non-string subagent type', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );
      onTaskToolAfter(state, { subagent_type: 42, prompt: 'x' }, 'result', LATER);
      const pending = state.pendingReviews.get('flowguard_plan')!;
      expect(pending.subagentCalled).toBe(false);
    });

    // ── L302: matchPendingReview with 0 uncalled returns null ──
    it('matchPendingReview returns null when all pending reviews already called', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );
      // Complete the review (marks subagentCalled)
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithFindings('s1'),
        LATER,
      );
      // Now matchPendingReview should return null (0 uncalled)
      const result = matchPendingReview(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt: 'another review',
      });
      expect(result).toBeNull();
    });

    // ── L314: matchPendingReview planVersion matching ──
    it('matchPendingReview rejects when planVersion expected but not in prompt', () => {
      const state = createSessionState();
      // Register TWO pending reviews to trigger multi-match path
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan v1' },
        modeASubagentResponse({ iteration: 0, planVersion: 1 }),
        NOW,
      );
      onFlowGuardToolAfter(
        state,
        'flowguard_architecture',
        { adrText: '## ADR' },
        modeASubagentResponse({ iteration: 1, planVersion: 5 }),
        LATER,
      );
      // Prompt has iteration=0 but WRONG planVersion → no match
      const prompt = 'iteration=0 planVersion=99 ' + 'x'.repeat(MIN_SUBAGENT_PROMPT_LENGTH);
      const result = matchPendingReview(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt,
      });
      expect(result).toBeNull();
    });

    // ── L360: obligations.length === 0 recovery path ──
    it('enforceBeforeVerdict allows when sessionState has no obligations', () => {
      const state = createSessionState();
      // No pending review in enforcement state, but session state IS readable
      const sessionState = { reviewAssurance: { obligations: [] } };
      const result = enforceBeforeVerdict(
        state,
        'flowguard_plan',
        { reviewVerdict: 'accept' },
        sessionState as never,
      );
      expect(result.allowed).toBe(true);
    });

    it('enforceBeforeVerdict allows when sessionState obligations is null', () => {
      const state = createSessionState();
      const sessionState = { reviewAssurance: { obligations: null } };
      const result = enforceBeforeVerdict(
        state,
        'flowguard_plan',
        { reviewVerdict: 'accept' },
        sessionState as never,
      );
      expect(result.allowed).toBe(true);
    });

    // ── L436+L442: Level 4 findings integrity specifics ──
    it('L4: blocks when submitted verdict differs from captured (approve vs changes_requested)', () => {
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
        taskResultWithFindings('s1', { verdict: 'changes_requested', blockingIssues: [] }),
        LATER,
      );
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        reviewVerdict: 'accept',
        reviewFindings: {
          overallVerdict: 'accept', // MISMATCH: submitted approve but captured changes_requested
          blockingIssues: [],
          reviewedBy: { sessionId: 's1' },
        },
      });
      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_FINDINGS_VERDICT_MISMATCH');
    });

    it('L4: blocks when blocking issues count differs from captured', () => {
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
        taskResultWithFindings('s1', {
          verdict: 'changes_requested',
          blockingIssues: [{ severity: 'critical', description: 'A' }],
        }),
        LATER,
      );
      // Submit with ZERO issues but captured had 1
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        reviewVerdict: 'changes_requested',
        reviewFindings: {
          overallVerdict: 'changes_requested',
          blockingIssues: [], // MISMATCH: 0 vs 1 captured
          reviewedBy: { sessionId: 's1' },
        },
      });
      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_FINDINGS_ISSUES_MISMATCH');
    });
  });

  // ─── Pre-execution reviewer obligation check ─────────────────────
  describe('enforceReviewerObligation', () => {
    const PENDING = { status: 'pending' } as const;
    const CONSUMED = { status: 'consumed' } as const;
    const FULFILLED = { status: 'fulfilled' } as const;
    const BLOCKED = { status: 'blocked' } as const;

    it('allows when host_task_required and pending obligation exists', () => {
      const result = enforceReviewerObligation({
        obligations: [PENDING],
        reviewInvocationPolicy: 'host_task_required',
        strictEnforcement: true,
        stateAvailable: true,
      });
      expect(result.allowed).toBe(true);
    });

    it('blocks when host_task_required and no obligations at all', () => {
      const result = enforceReviewerObligation({
        obligations: [],
        reviewInvocationPolicy: 'host_task_required',
        strictEnforcement: true,
        stateAvailable: true,
      });
      expect(result.allowed).toBe(false);
      expect((result as { code: string }).code).toBe('REVIEWER_TASK_REQUIRES_PENDING_OBLIGATION');
    });

    it('blocks when host_task_required and only non-pending obligations', () => {
      const nonPendingCases = [[CONSUMED], [FULFILLED], [BLOCKED], [CONSUMED, FULFILLED]];
      for (const obligations of nonPendingCases) {
        const result = enforceReviewerObligation({
          obligations,
          reviewInvocationPolicy: 'host_task_required',
          strictEnforcement: true,
          stateAvailable: true,
        });
        expect(result.allowed).toBe(false);
      }
    });

    it('allows when host_task_preferred and no pending obligation', () => {
      const result = enforceReviewerObligation({
        obligations: [],
        reviewInvocationPolicy: 'host_task_preferred',
        strictEnforcement: true,
        stateAvailable: true,
      });
      expect(result.allowed).toBe(true);
    });

    it('allows when policy is undefined and no pending obligation', () => {
      const result = enforceReviewerObligation({
        obligations: [],
        reviewInvocationPolicy: undefined,
        strictEnforcement: true,
        stateAvailable: true,
      });
      expect(result.allowed).toBe(true);
    });

    it('allows when sdk_allowed policy and no pending obligation', () => {
      const result = enforceReviewerObligation({
        obligations: [],
        reviewInvocationPolicy: 'sdk_allowed',
        strictEnforcement: false,
        stateAvailable: true,
      });
      expect(result.allowed).toBe(true);
    });

    it('blocks when state unavailable and strict enforcement', () => {
      const result = enforceReviewerObligation({
        obligations: [],
        reviewInvocationPolicy: 'host_task_required',
        strictEnforcement: true,
        stateAvailable: false,
      });
      expect(result.allowed).toBe(false);
      expect((result as { code: string }).code).toBe('STATE_UNAVAILABLE_FOR_REVIEWER_TASK');
    });

    it('allows when state unavailable and non-strict enforcement', () => {
      const result = enforceReviewerObligation({
        obligations: [],
        reviewInvocationPolicy: 'host_task_required',
        strictEnforcement: false,
        stateAvailable: false,
      });
      expect(result.allowed).toBe(true);
    });

    it('allows when host_task_required with mixed obligations including one pending', () => {
      const result = enforceReviewerObligation({
        obligations: [CONSUMED, PENDING, BLOCKED],
        reviewInvocationPolicy: 'host_task_required',
        strictEnforcement: true,
        stateAvailable: true,
      });
      expect(result.allowed).toBe(true);
    });
  });
});
