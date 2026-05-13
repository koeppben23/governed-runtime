/**
 * @module integration/review-enforcement-mutation.test
 * @description Mutation-kill tests for review enforcement module.
 * Covers: recordPluginReview, MUTATION_KILL blocks for enforceBeforeSubagentCall,
 * onFlowGuardToolAfter, enforceBeforeVerdict P35 recovery, extractCapturedFindings
 * embedded extraction, and promptContainsValue boundary cases.
 *
 * @test-policy MUTATION_KILL — all tests target survivor kills.
 */

import { describe, it, expect } from 'vitest';
import {
  createSessionState,
  onFlowGuardToolAfter,
  enforceBeforeVerdict,
  enforceBeforeSubagentCall,
  recordPluginReview,
} from './enforcement.js';
import { extractCapturedFindings, promptContainsValue } from './extraction.js';
import {
  REVIEW_REQUIRED_PREFIX,
  REVIEWER_SUBAGENT_TYPE,
  MIN_SUBAGENT_PROMPT_LENGTH,
} from './types.js';
import { NOW, LATER, modeASubagentResponse } from './test-helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('review-enforcement mutation kills', () => {
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

    // CORNER: null captured findings (defensive — plugin gate prevents this path)
    it('accepts null captured findings defensively but plugin never calls this path', () => {
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

    // P1.3 slice 5: L4 enforcement parity for the third LoopVerdict.
    it('L4 allows when both submitted and captured verdicts are unable_to_review (HAPPY: third-verdict parity)', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);

      recordPluginReview(
        state,
        'flowguard_plan',
        'child-session-1',
        {
          overallVerdict: 'unable_to_review',
          blockingIssuesCount: 0,
          sessionId: 'child-session-1',
        },
        LATER,
      );

      const enforcement = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve', // submitter-side stays 2-valued
        reviewFindings: {
          overallVerdict: 'unable_to_review', // matches captured
          blockingIssues: [],
          reviewedBy: { sessionId: 'child-session-1' },
        },
      });
      if (!enforcement.allowed) {
        expect(enforcement.code).not.toBe('SUBAGENT_FINDINGS_VERDICT_MISMATCH');
      }
    });

    it('L4 blocks when submitted=approve but captured=unable_to_review (CORNER: convergence-fabrication bypass)', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);

      recordPluginReview(
        state,
        'flowguard_plan',
        'child-session-1',
        {
          overallVerdict: 'unable_to_review',
          blockingIssuesCount: 0,
          sessionId: 'child-session-1',
        },
        LATER,
      );

      const enforcement = enforceBeforeVerdict(state, 'flowguard_plan', {
        selfReviewVerdict: 'approve',
        reviewFindings: {
          overallVerdict: 'approve', // Tampered: real reviewer said unable_to_review
          blockingIssues: [],
          reviewedBy: { sessionId: 'child-session-1' },
        },
      });
      expect(enforcement.allowed).toBe(false);
      expect(enforcement.allowed === false && enforcement.code).toBe(
        'SUBAGENT_FINDINGS_VERDICT_MISMATCH',
      );
    });

    // ─── MUTATION KILL: enforceBeforeSubagentCall (lines 208-287) ────────────

    describe('MUTATION_KILL: enforceBeforeSubagentCall', () => {
      it('allows task call for non-reviewer subagent type', () => {
        const state = createSessionState();
        const result = enforceBeforeSubagentCall(state, { subagent_type: 'other-agent' });
        expect(result.allowed).toBe(true);
      });

      it('allows when no pending reviews exist (survivor kill)', () => {
        const state = createSessionState();
        const result = enforceBeforeSubagentCall(state, {
          subagent_type: REVIEWER_SUBAGENT_TYPE,
          prompt: 'Some prompt text here',
        });
        expect(result.allowed).toBe(true);
      });

      it('blocks when prompt is too short (survivor kill)', () => {
        const state = createSessionState();
        // Register a pending review
        state.pendingReviews.set('flowguard_plan', {
          tool: 'flowguard_plan',
          requestedAt: NOW,
          subagentCalled: false,
          subagentRecord: null,
          contentMeta: { expectedIteration: 0, expectedPlanVersion: 1 },
          capturedFindings: null,
        });

        const shortPrompt = 'Short';
        const result = enforceBeforeSubagentCall(state, {
          subagent_type: REVIEWER_SUBAGENT_TYPE,
          prompt: shortPrompt,
        });
        expect(result.allowed).toBe(false);
        expect(result.allowed === false && result.code).toBe('SUBAGENT_PROMPT_EMPTY');
      });

      it('blocks when contentMeta is null in strict mode (survivor kill)', () => {
        const state = createSessionState();
        state.pendingReviews.set('flowguard_plan', {
          tool: 'flowguard_plan',
          requestedAt: NOW,
          subagentCalled: false,
          subagentRecord: null,
          contentMeta: null, // Content meta extraction failed
          capturedFindings: null,
        });

        const result = enforceBeforeSubagentCall(
          state,
          {
            subagent_type: REVIEWER_SUBAGENT_TYPE,
            prompt: 'A'.repeat(MIN_SUBAGENT_PROMPT_LENGTH + 10),
          },
          true, // strictEnforcement
        );
        expect(result.allowed).toBe(false);
        expect(result.allowed === false && result.code).toBe('SUBAGENT_CONTEXT_UNVERIFIABLE');
      });

      it('allows when contentMeta is null in non-strict mode (survivor kill)', () => {
        const state = createSessionState();
        state.pendingReviews.set('flowguard_plan', {
          tool: 'flowguard_plan',
          requestedAt: NOW,
          subagentCalled: false,
          subagentRecord: null,
          contentMeta: null,
          capturedFindings: null,
        });

        const result = enforceBeforeSubagentCall(state, {
          subagent_type: REVIEWER_SUBAGENT_TYPE,
          prompt: 'A'.repeat(MIN_SUBAGENT_PROMPT_LENGTH + 10),
        });
        expect(result.allowed).toBe(true);
      });

      it('blocks when prompt missing iteration (survivor kill)', () => {
        const state = createSessionState();
        state.pendingReviews.set('flowguard_plan', {
          tool: 'flowguard_plan',
          requestedAt: NOW,
          subagentCalled: false,
          subagentRecord: null,
          contentMeta: { expectedIteration: 2, expectedPlanVersion: 1 },
          capturedFindings: null,
        });

        const prompt = 'A'.repeat(100) + ' version=1 ' + 'B'.repeat(150);
        const result = enforceBeforeSubagentCall(state, {
          subagent_type: REVIEWER_SUBAGENT_TYPE,
          prompt,
        });
        expect(result.allowed).toBe(false);
        expect(result.allowed === false && result.code).toBe('SUBAGENT_PROMPT_MISSING_CONTEXT');
      });

      it('blocks when prompt missing planVersion (survivor kill)', () => {
        const state = createSessionState();
        state.pendingReviews.set('flowguard_plan', {
          tool: 'flowguard_plan',
          requestedAt: NOW,
          subagentCalled: false,
          subagentRecord: null,
          contentMeta: { expectedIteration: 0, expectedPlanVersion: 3 },
          capturedFindings: null,
        });

        const prompt = 'A'.repeat(100) + ' iteration=0 ' + 'B'.repeat(150);
        const result = enforceBeforeSubagentCall(state, {
          subagent_type: REVIEWER_SUBAGENT_TYPE,
          prompt,
        });
        expect(result.allowed).toBe(false);
        expect(result.allowed === false && result.code).toBe('SUBAGENT_PROMPT_MISSING_CONTEXT');
      });

      it('allows when prompt contains both iteration and planVersion (survivor kill)', () => {
        const state = createSessionState();
        state.pendingReviews.set('flowguard_plan', {
          tool: 'flowguard_plan',
          requestedAt: NOW,
          subagentCalled: false,
          subagentRecord: null,
          contentMeta: { expectedIteration: 1, expectedPlanVersion: 2 },
          capturedFindings: null,
        });

        const prompt = 'A'.repeat(50) + ' iteration=1 ' + ' planVersion=2 ' + 'B'.repeat(200);
        const result = enforceBeforeSubagentCall(state, {
          subagent_type: REVIEWER_SUBAGENT_TYPE,
          prompt,
        });
        expect(result.allowed).toBe(true);
      });
    });

    // ─── MUTATION KILL: onFlowGuardToolAfter (lines 160-193) ─────────────────

    describe('MUTATION_KILL: onFlowGuardToolAfter', () => {
      it('ignores non-FlowGuard tools (survivor kill)', () => {
        const state = createSessionState();
        onFlowGuardToolAfter(state, 'other_tool', {}, 'Some output', NOW);
        expect(state.pendingReviews.size).toBe(0);
      });

      it('clears pending review on Mode B success (survivor kill)', () => {
        const state = createSessionState();
        // First register a pending review
        state.pendingReviews.set('flowguard_plan', {
          tool: 'flowguard_plan',
          requestedAt: NOW,
          subagentCalled: false,
          subagentRecord: null,
          contentMeta: null,
          capturedFindings: null,
        });

        // Mode B: submit verdict with success
        onFlowGuardToolAfter(
          state,
          'flowguard_plan',
          { selfReviewVerdict: 'approve' },
          JSON.stringify({ status: 'Plan approved' }),
          LATER,
        );
        expect(state.pendingReviews.has('flowguard_plan')).toBe(false);
      });

      it('does NOT clear pending review on Mode B error (survivor kill)', () => {
        const state = createSessionState();
        state.pendingReviews.set('flowguard_plan', {
          tool: 'flowguard_plan',
          requestedAt: NOW,
          subagentCalled: false,
          subagentRecord: null,
          contentMeta: null,
          capturedFindings: null,
        });

        // Mode B: submit verdict with error
        onFlowGuardToolAfter(
          state,
          'flowguard_plan',
          { selfReviewVerdict: 'approve' },
          JSON.stringify({ error: true, code: 'SOME_ERROR' }),
          LATER,
        );
        expect(state.pendingReviews.has('flowguard_plan')).toBe(true);
      });

      it('registers pending review when next starts with REVIEW_REQUIRED_PREFIX (survivor kill)', () => {
        const state = createSessionState();
        onFlowGuardToolAfter(
          state,
          'flowguard_plan',
          {},
          JSON.stringify({
            next: `${REVIEW_REQUIRED_PREFIX}: Call reviewer with iteration=0 and planVersion=1`,
            reviewMode: 'subagent',
          }),
          NOW,
        );
        expect(state.pendingReviews.has('flowguard_plan')).toBe(true);
        // The exact contentMeta depends on extractContentMeta implementation
        // Just verify the pending review was registered
      });

      it('does NOT register pending review when next does not start with prefix (survivor kill)', () => {
        const state = createSessionState();
        onFlowGuardToolAfter(
          state,
          'flowguard_plan',
          {},
          JSON.stringify({
            next: 'Just some regular message',
            reviewMode: 'subagent',
          }),
          NOW,
        );
        expect(state.pendingReviews.has('flowguard_plan')).toBe(false);
      });

      it('handles unparseable output gracefully (survivor kill)', () => {
        const state = createSessionState();
        onFlowGuardToolAfter(state, 'flowguard_plan', {}, 'Not valid JSON{', NOW);
        expect(state.pendingReviews.size).toBe(0);
      });
    });
  });

  // ─── MUTATION KILL: P35 recovery and strict enforcement paths ────────────
  describe('MUTATION_KILL: enforceBeforeVerdict P35 recovery path', () => {
    it('P35: blocks when sessionState has pending obligation but no transient state', () => {
      const state = createSessionState();
      // No pending review in transient state
      const sessionState = {
        reviewAssurance: {
          obligations: [
            {
              obligationId: '00000000-0000-4000-8000-000000000001',
              obligationType: 'plan' as const,
              iteration: 0,
              planVersion: 1,
              criteriaVersion: 'v1',
              mandateDigest: 'digest-abc',
              createdAt: NOW,
              pluginHandshakeAt: null,
              status: 'pending' as const,
              invocationId: null,
              blockedCode: null,
              fulfilledAt: null,
              consumedAt: null,
            },
          ],
        },
      };
      const result = enforceBeforeVerdict(
        state,
        'flowguard_plan',
        { selfReviewVerdict: 'approve' },
        sessionState,
      );
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.code).toBe('SUBAGENT_REVIEW_NOT_INVOKED');
        expect(result.reason).toContain('recovered from session state');
        expect(result.reason).toContain('00000000-0000-4000-8000-000000000001');
      }
    });

    it('P35: allows when sessionState has no pending obligations', () => {
      const state = createSessionState();
      const sessionState = {
        reviewAssurance: {
          obligations: [
            {
              obligationId: '00000000-0000-4000-8000-000000000002',
              obligationType: 'plan' as const,
              iteration: 0,
              planVersion: 1,
              criteriaVersion: 'v1',
              mandateDigest: 'digest-abc',
              createdAt: NOW,
              pluginHandshakeAt: null,
              status: 'fulfilled' as const,
              invocationId: '00000000-0000-4000-8000-000000000003',
              blockedCode: null,
              fulfilledAt: NOW,
              consumedAt: null,
            },
          ],
        },
      };
      const result = enforceBeforeVerdict(
        state,
        'flowguard_plan',
        { selfReviewVerdict: 'approve' },
        sessionState,
      );
      expect(result.allowed).toBe(true);
    });

    it('P35: strict enforcement blocks when no transient state and no sessionState', () => {
      const state = createSessionState();
      const result = enforceBeforeVerdict(
        state,
        'flowguard_plan',
        { selfReviewVerdict: 'approve' },
        null,
        true, // strictEnforcement
      );
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.code).toBe('REVIEW_ASSURANCE_STATE_UNAVAILABLE');
        expect(result.reason).toContain('strict mode');
      }
    });

    it('P35: non-strict allows when no transient state and no sessionState', () => {
      const state = createSessionState();
      const result = enforceBeforeVerdict(
        state,
        'flowguard_plan',
        { selfReviewVerdict: 'approve' },
        null,
        false,
      );
      expect(result.allowed).toBe(true);
    });
  });

  // ─── MUTATION KILL: extractCapturedFindings with embedded JSON ───────────
  describe('MUTATION_KILL: extractCapturedFindings embedded JSON extraction', () => {
    it('extracts findings from text with embedded JSON containing reviewedBy', () => {
      const embedded =
        'Some prefix text\n' +
        JSON.stringify({
          overallVerdict: 'approve',
          blockingIssues: [],
          reviewedBy: { sessionId: 'ses_abc123' },
        }) +
        '\nSome suffix text';
      const findings = extractCapturedFindings(embedded);
      expect(findings).not.toBeNull();
      expect(findings!.overallVerdict).toBe('approve');
      expect(findings!.sessionId).toBe('ses_abc123');
    });

    it('handles nested braces in embedded JSON correctly', () => {
      const embedded = JSON.stringify({
        overallVerdict: 'changes_requested',
        blockingIssues: [{ title: 'Missing {test} coverage', severity: 'error' }],
        reviewedBy: { sessionId: 'ses_nested' },
      });
      const findings = extractCapturedFindings(embedded);
      expect(findings).not.toBeNull();
      expect(findings!.overallVerdict).toBe('changes_requested');
      expect(findings!.blockingIssuesCount).toBe(1);
    });

    it('handles escaped quotes in embedded JSON', () => {
      const obj = {
        overallVerdict: 'approve',
        blockingIssues: [],
        summary: 'Code looks "fine"',
        reviewedBy: { sessionId: 'ses_escaped' },
      };
      const findings = extractCapturedFindings(JSON.stringify(obj));
      expect(findings).not.toBeNull();
      expect(findings!.overallVerdict).toBe('approve');
    });

    it('returns null for text without valid JSON structure', () => {
      const findings = extractCapturedFindings('Not JSON at all { broken }');
      expect(findings).toBeNull();
    });
  });

  // ─── MUTATION KILL: promptContainsValue regex edge cases ─────────────────
  describe('MUTATION_KILL: promptContainsValue boundary cases', () => {
    it('multi-digit iteration values match correctly', () => {
      expect(promptContainsValue('iteration=10 is here', 'iteration', 10)).toBe(true);
      expect(promptContainsValue('iteration=10 is here', 'iteration', 1)).toBe(false);
    });

    it('multi-digit planVersion values match correctly', () => {
      expect(promptContainsValue('planVersion=12 version', 'planVersion', 12)).toBe(true);
      expect(promptContainsValue('planVersion=12 version', 'planVersion', 1)).toBe(false);
    });

    it('does not match partial number at boundary', () => {
      expect(promptContainsValue('iteration=123', 'iteration', 12)).toBe(false);
    });
  });
});
