/**
 * @module integration/review-enforcement.test
 * @description Tests for the review enforcement module.
 *
 * Validates that the plugin-level enforcement correctly:
 * - Detects INDEPENDENT_REVIEW_REQUIRED signals from FlowGuard tools
 * - Tracks Task calls to the flowguard-reviewer subagent
 * - Blocks self-review verdicts when no subagent call was made
 * - Validates sessionId matching between subagent and submitted findings
 * - Clears enforcement state after successful verdict
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all categories present.
 */

import { describe, it, expect } from 'vitest';
import {
  createSessionState,
  onFlowGuardToolAfter,
  onTaskToolAfter,
  enforceBeforeVerdict,
  REVIEW_REQUIRED_PREFIX,
  REVIEWER_SUBAGENT_TYPE,
  type SessionEnforcementState,
} from './review-enforcement.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOW = '2026-04-24T12:00:00.000Z';
const LATER = '2026-04-24T12:01:00.000Z';

/** Build a Mode A response with INDEPENDENT_REVIEW_REQUIRED in next. */
function modeASubagentResponse(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'PLAN',
    status: 'Plan submitted (v1).',
    reviewMode: 'subagent',
    next: `${REVIEW_REQUIRED_PREFIX}: Call the flowguard-reviewer subagent via Task tool.`,
    ...extra,
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
function taskResultWithFindings(sessionId: string): string {
  return JSON.stringify({
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'approve',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId },
    reviewedAt: NOW,
  });
}

/** Build a Task tool result with embedded text around JSON. */
function taskResultWithEmbeddedFindings(sessionId: string): string {
  return `Here are my review findings:\n${taskResultWithFindings(sessionId)}\nEnd of review.`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('review-enforcement', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('allows verdict when subagent was called (plan)', () => {
      const state = createSessionState();

      // Mode A: plan returns INDEPENDENT_REVIEW_REQUIRED
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      // Task call to flowguard-reviewer
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review plan' },
        taskResultWithFindings('sub-session-1'),
        LATER,
      );

      // Mode B: verdict should be allowed
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
        reviewFindings: {
          reviewedBy: { sessionId: 'sub-session-1' },
        },
      });

      expect(result.allowed).toBe(true);
    });

    it('allows verdict when subagent was called (implement)', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_implement',
        { changedFiles: [] },
        modeASubagentResponse({ phase: 'IMPLEMENTATION' }),
        NOW,
      );

      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review impl' },
        taskResultWithFindings('sub-session-2'),
        LATER,
      );

      const result = enforceBeforeVerdict(state, 'flowguard_implement', {
        reviewVerdict: 'approve',
        reviewFindings: {
          reviewedBy: { sessionId: 'sub-session-2' },
        },
      });

      expect(result.allowed).toBe(true);
    });

    it('does not enforce when self-review mode (no INDEPENDENT_REVIEW_REQUIRED)', () => {
      const state = createSessionState();

      // Mode A: self-review response (subagentEnabled=false)
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASelfReviewResponse(),
        NOW,
      );

      // Mode B: verdict without subagent call should be allowed
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
      });

      expect(result.allowed).toBe(true);
    });

    it('clears pending review after successful Mode B', () => {
      const state = createSessionState();

      // Mode A → pending review
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );
      expect(state.pendingReviews.size).toBe(1);

      // Task call
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithFindings('s1'),
        LATER,
      );

      // Mode B success → clears pending
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { selfReviewVerdict: 'approve', reviewFindings: {} },
        modeBSuccessResponse(),
        LATER,
      );

      expect(state.pendingReviews.size).toBe(0);
    });

    it('allows Mode A calls (initial submission) without enforcement', () => {
      const state = createSessionState();

      // Mode A call should always be allowed (no verdict being submitted)
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        planText: '## Plan',
      });

      expect(result.allowed).toBe(true);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('blocks verdict when subagent was NOT called', () => {
      const state = createSessionState();

      // Mode A: INDEPENDENT_REVIEW_REQUIRED
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      // NO Task call — primary agent tries to submit verdict directly
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

    it('blocks implement verdict when subagent was NOT called', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_implement',
        { changedFiles: [] },
        modeASubagentResponse({ phase: 'IMPLEMENTATION' }),
        NOW,
      );

      const result = enforceBeforeVerdict(state, 'flowguard_implement', {
        reviewVerdict: 'changes_requested',
      });

      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_REVIEW_NOT_INVOKED');
    });

    it('blocks verdict with fabricated findings (no subagent call)', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      // Agent fabricates full ReviewFindings without calling subagent
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
        reviewFindings: {
          iteration: 0,
          planVersion: 1,
          reviewMode: 'subagent',
          overallVerdict: 'approve',
          blockingIssues: [],
          reviewedBy: { sessionId: 'fake-session' },
        },
      });

      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_REVIEW_NOT_INVOKED');
    });

    it('blocks verdict with mismatched sessionId', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      // Real subagent call with known sessionId
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithFindings('real-session-123'),
        LATER,
      );

      // Agent submits findings with different sessionId
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
        reviewFindings: {
          reviewedBy: { sessionId: 'tampered-session-456' },
        },
      });

      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('code', 'SUBAGENT_SESSION_MISMATCH');
    });

    it('blocks changes_requested verdict too (not just approve)', () => {
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
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('does not enforce for non-FlowGuard tools', () => {
      const state = createSessionState();

      const result = enforceBeforeVerdict(state, 'bash', {
        command: 'npm test',
      });

      expect(result.allowed).toBe(true);
    });

    it('does not enforce for flowguard_status', () => {
      const state = createSessionState();

      const result = enforceBeforeVerdict(state, 'flowguard_status', {});
      expect(result.allowed).toBe(true);
    });

    it('handles non-JSON tool output gracefully', () => {
      const state = createSessionState();

      // Non-JSON output should not crash
      onFlowGuardToolAfter(state, 'flowguard_plan', { planText: '## Plan' }, 'not json', NOW);

      // No pending review created
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

      // Mode B returns error (e.g. REVISED_PLAN_REQUIRED) — should NOT clear pending
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

      // Task call to a DIFFERENT subagent (not flowguard-reviewer)
      onTaskToolAfter(
        state,
        { subagent_type: 'explore', prompt: 'Find files' },
        'some result',
        LATER,
      );

      // Still pending — wrong subagent type
      const pending = state.pendingReviews.get('flowguard_plan');
      expect(pending?.subagentCalled).toBe(false);
    });

    it('plan and implement have independent pending reviews', () => {
      const state = createSessionState();

      // Both tools signal INDEPENDENT_REVIEW_REQUIRED
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
        { changedFiles: [] },
        modeASubagentResponse({ phase: 'IMPLEMENTATION' }),
        NOW,
      );

      expect(state.pendingReviews.size).toBe(2);
      expect(state.pendingReviews.has('flowguard_plan')).toBe(true);
      expect(state.pendingReviews.has('flowguard_implement')).toBe(true);
    });

    it('single subagent call satisfies all pending reviews', () => {
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
        { changedFiles: [] },
        modeASubagentResponse({ phase: 'IMPLEMENTATION' }),
        NOW,
      );

      // One subagent call satisfies both
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithFindings('shared-session'),
        LATER,
      );

      const planPending = state.pendingReviews.get('flowguard_plan');
      const implPending = state.pendingReviews.get('flowguard_implement');
      expect(planPending?.subagentCalled).toBe(true);
      expect(implPending?.subagentCalled).toBe(true);
    });

    it('fresh session state has no pending reviews', () => {
      const state = createSessionState();
      expect(state.pendingReviews.size).toBe(0);
    });

    it('allows verdict when no pending review exists (enforcement inactive)', () => {
      const state = createSessionState();

      // No Mode A call happened, agent submits verdict directly
      // (e.g. session was restored, or enforcement was not active during Mode A)
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
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

      // Task returns text with embedded JSON (subagent wraps in prose)
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithEmbeddedFindings('embedded-session-id'),
        LATER,
      );

      const pending = state.pendingReviews.get('flowguard_plan');
      expect(pending?.subagentRecord?.sessionId).toBe('embedded-session-id');
    });

    it('falls back to timestamp-based sessionId when extraction fails', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      // Task returns non-JSON (subagent output is plain text)
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        'The plan looks good. I approve.',
        LATER,
      );

      const pending = state.pendingReviews.get('flowguard_plan');
      expect(pending?.subagentCalled).toBe(true);
      expect(pending?.subagentRecord?.sessionId).toBe(`task-${LATER}`);
    });

    it('handles empty args gracefully in onFlowGuardToolAfter', () => {
      const state = createSessionState();
      // Should not crash with empty args
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);
      expect(state.pendingReviews.size).toBe(1);
    });

    it('handles empty args gracefully in onTaskToolAfter', () => {
      const state = createSessionState();
      // Should not crash with empty args
      onTaskToolAfter(state, {}, 'result', NOW);
      // No pending reviews affected (wrong subagent type)
      expect(state.pendingReviews.size).toBe(0);
    });

    it('handles empty args gracefully in enforceBeforeVerdict', () => {
      const state = createSessionState();
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {});
      expect(result.allowed).toBe(true); // No verdict = no enforcement
    });

    it('multiple iterations: re-signals review after changes_requested cycle', () => {
      const state = createSessionState();

      // Iteration 1: Mode A → pending
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan v1' },
        modeASubagentResponse(),
        NOW,
      );
      expect(state.pendingReviews.size).toBe(1);

      // Iteration 1: Task call
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithFindings('iter1-session'),
        LATER,
      );

      // Iteration 1: Mode B success → clears pending
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { selfReviewVerdict: 'changes_requested', planText: '## Plan v2' },
        modeBSuccessResponse(),
        LATER,
      );
      expect(state.pendingReviews.size).toBe(0);

      // Iteration 2: Mode B response with new INDEPENDENT_REVIEW_REQUIRED
      const iter2Response = JSON.stringify({
        phase: 'PLAN',
        status: 'Self-review iteration 1/3. Verdict: changes_requested.',
        reviewMode: 'subagent',
        next: `${REVIEW_REQUIRED_PREFIX}: Review the revised plan.`,
      });
      // This would come from a non-converged response that re-signals review
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan v2' },
        iter2Response,
        LATER,
      );
      expect(state.pendingReviews.size).toBe(1);

      // Iteration 2: verdict WITHOUT subagent → blocked
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
      });
      expect(result.allowed).toBe(false);
    });

    it('sessionId mismatch only enforced when real sessionId was extracted', () => {
      const state = createSessionState();

      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse(),
        NOW,
      );

      // Task call with non-parseable response (fallback sessionId)
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        'Plain text response without JSON',
        LATER,
      );

      // Verdict with any sessionId should pass (fallback = no strict match)
      const result = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
        reviewFindings: {
          reviewedBy: { sessionId: 'any-id' },
        },
      });

      expect(result.allowed).toBe(true);
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
  });
});
