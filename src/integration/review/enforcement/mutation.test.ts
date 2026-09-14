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
  enforceBeforeSubagentCall as enforceBeforeSubagentCallRaw,
  recordPluginReview,
} from './enforcement.js';
import { extractCapturedFindings, promptContainsValue } from './extraction.js';
import { REVIEW_REQUIRED_PREFIX, MIN_SUBAGENT_PROMPT_LENGTH } from './types.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import { NOW, LATER, modeASubagentResponse, currentAttemptAssuranceFor } from './test-helpers.js';

function enforceBeforeSubagentCall(
  state: ReturnType<typeof createSessionState>,
  taskArgs: Record<string, unknown>,
) {
  return enforceBeforeSubagentCallRaw(state, taskArgs, currentAttemptAssuranceFor(state));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('review-enforcement mutation kills', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // recordPluginReview — Plugin-initiated review recording
  // ═══════════════════════════════════════════════════════════════════════════

  describe('recordPluginReview', () => {
    it('satisfies pending plan review and enables L1/L2/L4 pass', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);
      expect(state.pendingReviews.get('flowguard_plan')?.subagentCalled).toBe(false);

      const result = recordPluginReview(
        state,
        'flowguard_plan',
        'child-session-1',
        {
          overallVerdict: 'accept',
          blockingIssuesCount: 0,
          sessionId: 'child-session-1',
        },
        LATER,
      );

      expect(result).toBe(true);
      const pending = state.pendingReviews.get('flowguard_plan');
      expect(pending?.subagentCalled).toBe(true);
      expect(pending?.subagentRecord?.sessionId).toBe('child-session-1');
      expect(pending?.capturedFindings?.overallVerdict).toBe('accept');
      expect(pending?.capturedFindings?.blockingIssuesCount).toBe(0);

      const enforcement = enforceBeforeVerdict(state, 'flowguard_plan', {
        reviewVerdict: 'accept',
        reviewFindings: {
          overallVerdict: 'accept',
          blockingIssues: [],
          reviewedBy: { sessionId: 'child-session-1' },
        },
      });
      expect(enforcement.allowed).toBe(true);
    });

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

    it('returns false when no pending review exists', () => {
      const state = createSessionState();
      const result = recordPluginReview(state, 'flowguard_plan', 'child-session', null, NOW);
      expect(result).toBe(false);
    });

    it('returns false when review was already satisfied', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);

      expect(recordPluginReview(state, 'flowguard_plan', 'child-1', null, LATER)).toBe(true);
      expect(recordPluginReview(state, 'flowguard_plan', 'child-2', null, LATER)).toBe(false);
    });

    it('returns false for non-reviewable tool', () => {
      const state = createSessionState();
      const result = recordPluginReview(state, 'flowguard_status', 'child-session', null, NOW);
      expect(result).toBe(false);
    });

    it('accepts null captured findings defensively but plugin never calls this path', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);

      const result = recordPluginReview(state, 'flowguard_plan', 'child-session', null, LATER);

      expect(result).toBe(true);
      const pending = state.pendingReviews.get('flowguard_plan');
      expect(pending?.subagentCalled).toBe(true);
      expect(pending?.capturedFindings).toBeNull();
    });

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

      const enforcement = enforceBeforeVerdict(state, 'flowguard_plan', {
        reviewVerdict: 'accept',
        reviewFindings: {
          overallVerdict: 'accept',
          blockingIssues: [],
          reviewedBy: { sessionId: 'child-session-1' },
        },
      });
      expect(enforcement.allowed).toBe(false);
      expect(enforcement.allowed === false && enforcement.code).toBe(
        'SUBAGENT_FINDINGS_VERDICT_MISMATCH',
      );
    });

    it('L4 allows when both submitted and captured verdicts are unable_to_review', () => {
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
        reviewVerdict: 'accept',
        reviewFindings: {
          overallVerdict: 'unable_to_review',
          blockingIssues: [],
          reviewedBy: { sessionId: 'child-session-1' },
        },
      });
      if (!enforcement.allowed) {
        expect(enforcement.code).not.toBe('SUBAGENT_FINDINGS_VERDICT_MISMATCH');
      }
    });

    it('L4 blocks when submitted=approve but captured=unable_to_review', () => {
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
        reviewVerdict: 'accept',
        reviewFindings: {
          overallVerdict: 'accept',
          blockingIssues: [],
          reviewedBy: { sessionId: 'child-session-1' },
        },
      });
      expect(enforcement.allowed).toBe(false);
      expect(enforcement.allowed === false && enforcement.code).toBe(
        'SUBAGENT_FINDINGS_VERDICT_MISMATCH',
      );
    });

    describe('MUTATION_KILL: enforceBeforeSubagentCall', () => {
      it('allows task call for non-reviewer subagent type', () => {
        const state = createSessionState();
        const result = enforceBeforeSubagentCall(state, { subagent_type: 'other-agent' });
        expect(result.allowed).toBe(true);
      });

      it('allows when no pending reviews exist', () => {
        const state = createSessionState();
        const result = enforceBeforeSubagentCall(state, {
          subagent_type: REVIEWER_SUBAGENT_TYPE,
          prompt: 'Some prompt text here',
        });
        expect(result.allowed).toBe(true);
      });

      it('blocks when prompt is too short', () => {
        const state = createSessionState();
        state.pendingReviews.set('flowguard_plan', {
          tool: 'flowguard_plan',
          requestedAt: NOW,
          attemptId: 'test-attempt-short',
          obligationId: 'test-obligation-short',
          subagentCalled: false,
          subagentRecord: null,
          contentMeta: { expectedIteration: 0, expectedPlanVersion: 1 },
          canonicalPromptAnchor: null,
          capturedFindings: null,
          retryCount: 0,
          lastSchemaErrors: null,
          repairPromptRequired: false,
          expectedPromptDigest: null,
          expectedRepairPromptDigest: null,
        });

        const shortPrompt = 'Short';
        const result = enforceBeforeSubagentCall(state, {
          subagent_type: REVIEWER_SUBAGENT_TYPE,
          prompt: shortPrompt,
        });
        expect(result.allowed).toBe(false);
        expect(result.allowed === false && result.code).toBe('SUBAGENT_PROMPT_EMPTY');
      });

      it('blocks when contentMeta is unavailable', () => {
        const state = createSessionState();
        state.pendingReviews.set('flowguard_plan', {
          tool: 'flowguard_plan',
          requestedAt: NOW,
          attemptId: 'test-attempt-context',
          obligationId: 'test-obligation-context',
          subagentCalled: false,
          subagentRecord: null,
          contentMeta: null,
          canonicalPromptAnchor: null,
          capturedFindings: null,
          retryCount: 0,
          lastSchemaErrors: null,
          repairPromptRequired: false,
          expectedPromptDigest: null,
          expectedRepairPromptDigest: null,
        });

        const result = enforceBeforeSubagentCall(state, {
          subagent_type: REVIEWER_SUBAGENT_TYPE,
          prompt: 'A'.repeat(MIN_SUBAGENT_PROMPT_LENGTH + 10),
        });
        expect(result.allowed).toBe(false);
        expect(result.allowed === false && result.code).toBe('SUBAGENT_CONTEXT_UNVERIFIABLE');
      });

      it('blocks when prompt missing iteration', () => {
        const state = createSessionState();
        state.pendingReviews.set('flowguard_plan', {
          tool: 'flowguard_plan',
          requestedAt: NOW,
          attemptId: 'test-attempt-iteration',
          obligationId: 'test-obligation-iteration',
          subagentCalled: false,
          subagentRecord: null,
          contentMeta: { expectedIteration: 2, expectedPlanVersion: 1 },
          canonicalPromptAnchor: null,
          capturedFindings: null,
          retryCount: 0,
          lastSchemaErrors: null,
          repairPromptRequired: false,
          expectedPromptDigest: null,
          expectedRepairPromptDigest: null,
        });

        const prompt = 'A'.repeat(100) + ' version=1 ' + 'B'.repeat(150);
        const result = enforceBeforeSubagentCall(state, {
          subagent_type: REVIEWER_SUBAGENT_TYPE,
          prompt,
        });
        expect(result.allowed).toBe(false);
        expect(result.allowed === false && result.code).toBe('SUBAGENT_PROMPT_MISSING_CONTEXT');
      });

      it('blocks when prompt missing planVersion', () => {
        const state = createSessionState();
        state.pendingReviews.set('flowguard_plan', {
          tool: 'flowguard_plan',
          requestedAt: NOW,
          attemptId: 'test-attempt-version',
          obligationId: 'test-obligation-version',
          subagentCalled: false,
          subagentRecord: null,
          contentMeta: { expectedIteration: 0, expectedPlanVersion: 3 },
          canonicalPromptAnchor: null,
          capturedFindings: null,
          retryCount: 0,
          lastSchemaErrors: null,
          repairPromptRequired: false,
          expectedPromptDigest: null,
          expectedRepairPromptDigest: null,
        });

        const prompt = 'A'.repeat(100) + ' iteration=0 ' + 'B'.repeat(150);
        const result = enforceBeforeSubagentCall(state, {
          subagent_type: REVIEWER_SUBAGENT_TYPE,
          prompt,
        });
        expect(result.allowed).toBe(false);
        expect(result.allowed === false && result.code).toBe('SUBAGENT_PROMPT_MISSING_CONTEXT');
      });

      it('allows when prompt contains both iteration and planVersion', () => {
        const state = createSessionState();
        state.pendingReviews.set('flowguard_plan', {
          tool: 'flowguard_plan',
          requestedAt: NOW,
          attemptId: 'test-attempt-valid',
          obligationId: 'test-obligation-valid',
          subagentCalled: false,
          subagentRecord: null,
          contentMeta: { expectedIteration: 1, expectedPlanVersion: 2 },
          canonicalPromptAnchor: null,
          capturedFindings: null,
          retryCount: 0,
          lastSchemaErrors: null,
          repairPromptRequired: false,
          expectedPromptDigest: null,
          expectedRepairPromptDigest: null,
        });

        const prompt = 'A'.repeat(50) + ' iteration=1 ' + ' planVersion=2 ' + 'B'.repeat(200);
        const result = enforceBeforeSubagentCall(state, {
          subagent_type: REVIEWER_SUBAGENT_TYPE,
          prompt,
        });
        expect(result.allowed).toBe(true);
      });
    });

    describe('MUTATION_KILL: onFlowGuardToolAfter', () => {
      it('ignores non-FlowGuard tools', () => {
        const state = createSessionState();
        onFlowGuardToolAfter(state, 'other_tool', {}, 'Some output', NOW);
        expect(state.pendingReviews.size).toBe(0);
      });

      it('clears pending review on Mode B success', () => {
        const state = createSessionState();
        state.pendingReviews.set('flowguard_plan', {
          tool: 'flowguard_plan',
          requestedAt: NOW,
          attemptId: null,
          obligationId: null,
          subagentCalled: false,
          subagentRecord: null,
          contentMeta: null,
          canonicalPromptAnchor: null,
          capturedFindings: null,
          retryCount: 0,
          lastSchemaErrors: null,
          repairPromptRequired: false,
          expectedPromptDigest: null,
          expectedRepairPromptDigest: null,
        });

        onFlowGuardToolAfter(
          state,
          'flowguard_plan',
          { reviewVerdict: 'accept' },
          JSON.stringify({ status: 'Plan approved' }),
          LATER,
        );
        expect(state.pendingReviews.has('flowguard_plan')).toBe(false);
      });

      it('does NOT clear pending review on Mode B error', () => {
        const state = createSessionState();
        state.pendingReviews.set('flowguard_plan', {
          tool: 'flowguard_plan',
          requestedAt: NOW,
          attemptId: null,
          obligationId: null,
          subagentCalled: false,
          subagentRecord: null,
          contentMeta: null,
          canonicalPromptAnchor: null,
          capturedFindings: null,
          retryCount: 0,
          lastSchemaErrors: null,
          repairPromptRequired: false,
          expectedPromptDigest: null,
          expectedRepairPromptDigest: null,
        });

        onFlowGuardToolAfter(
          state,
          'flowguard_plan',
          { reviewVerdict: 'accept' },
          JSON.stringify({ error: true, code: 'SOME_ERROR' }),
          LATER,
        );
        expect(state.pendingReviews.has('flowguard_plan')).toBe(true);
      });

      it('registers pending review when next starts with REVIEW_REQUIRED_PREFIX', () => {
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
      });

      it('does NOT register pending review when next does not start with prefix', () => {
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

      it('handles unparseable output gracefully', () => {
        const state = createSessionState();
        onFlowGuardToolAfter(state, 'flowguard_plan', {}, 'Not valid JSON{', NOW);
        expect(state.pendingReviews.size).toBe(0);
      });
    });
  });

  // ─── MUTATION KILL: P35 recovery and fail-closed enforcement paths ──────
  describe('MUTATION_KILL: enforceBeforeVerdict P35 recovery path', () => {
    it('P35: blocks when sessionState has pending obligation but no transient state', () => {
      const state = createSessionState();
      const sessionState = {
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v6' as const,
          obligations: [
            {
              obligationId: '00000000-0000-4000-8000-000000000001',
              obligationType: 'plan' as const,
              requiredChallengeCount: 0,
              requiredChallengeKind: 'design_challenge' as const,
              challengePolicyVersion: 'challenge-policy.v1' as const,
              subjectDigest: 'test-subject-digest',
              iteration: 0,
              planVersion: 1,
              criteriaVersion: 'v1',
              mandateDigest: 'digest-abc',
              maxReviewerAttempts: 1,
              reviewProfile: 'core' as const,
              profileSource: 'policy_default' as const,
              reviewMaterial: {
                content: 'frozen review material',
                materialDigest: 'a'.repeat(64),
                subjectDigest: 'test-subject-digest',
              },
              createdAt: NOW,
              pluginHandshakeAt: null,
              status: 'pending' as const,
              invocationId: null,
              blockedCode: null,
              fulfilledAt: null,
              consumedAt: null,
              reviewSubjectScope: {
                kind: 'repository_change' as const,
                paths: ['src/foo.ts'],
                revisions: ['base', 'head'] as const,
              },
            },
          ],
          invocations: [],
          attempts: [],
          dispatches: [],
        },
      };
      const result = enforceBeforeVerdict(
        state,
        'flowguard_plan',
        { reviewVerdict: 'accept' },
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
          assuranceSchemaVersion: 'review-assurance.v6' as const,
          obligations: [
            {
              obligationId: '00000000-0000-4000-8000-000000000002',
              obligationType: 'plan' as const,
              requiredChallengeCount: 0,
              requiredChallengeKind: 'design_challenge' as const,
              challengePolicyVersion: 'challenge-policy.v1' as const,
              subjectDigest: 'test-subject-digest',
              iteration: 0,
              planVersion: 1,
              criteriaVersion: 'v1',
              mandateDigest: 'digest-abc',
              maxReviewerAttempts: 1,
              reviewProfile: 'core' as const,
              profileSource: 'policy_default' as const,
              reviewMaterial: {
                content: 'frozen review material',
                materialDigest: 'a'.repeat(64),
                subjectDigest: 'test-subject-digest',
              },
              createdAt: NOW,
              pluginHandshakeAt: null,
              status: 'fulfilled' as const,
              invocationId: '00000000-0000-4000-8000-000000000003',
              blockedCode: null,
              fulfilledAt: NOW,
              consumedAt: null,
              reviewSubjectScope: {
                kind: 'repository_change' as const,
                paths: ['src/foo.ts'],
                revisions: ['base', 'head'] as const,
              },
            },
          ],
          invocations: [],
          attempts: [],
          dispatches: [],
        },
      };
      const result = enforceBeforeVerdict(
        state,
        'flowguard_plan',
        { reviewVerdict: 'accept' },
        sessionState,
      );
      expect(result.allowed).toBe(true);
    });

    it('P35: blocks when no transient state and no sessionState', () => {
      const state = createSessionState();
      const result = enforceBeforeVerdict(
        state,
        'flowguard_plan',
        { reviewVerdict: 'accept' },
        null,
      );
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.code).toBe('REVIEW_ASSURANCE_STATE_UNAVAILABLE');
        expect(result.reason).toContain('Cannot verify review obligation fulfillment');
      }
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
