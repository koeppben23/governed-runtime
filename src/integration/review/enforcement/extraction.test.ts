/**
 * @module integration/review-enforcement-extraction.test
 * @description Tests for review-enforcement extraction/helper functions:
 * matchPendingReview, extractContentMeta, extractCapturedFindings, promptContainsValue.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all categories present.
 */

import { describe, it, expect } from 'vitest';
import {
  createSessionState,
  onFlowGuardToolAfter,
  onTaskToolAfter,
  matchPendingReview,
} from './enforcement.js';
import {
  extractContentMeta,
  extractCapturedFindings,
  promptContainsValue,
} from './extraction.js';
import { REVIEWER_SUBAGENT_TYPE } from './types.js';
import {
  NOW,
  LATER,
  modeASubagentResponse,
  taskResultWithFindings,
  validSubagentPrompt,
} from './test-helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('review-enforcement extraction helpers', () => {
  // ─── matchPendingReview ─────────────────────────────────────
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
        modeASubagentResponse({ iteration: 0, planVersion: 1 }),
        NOW,
      );

      const result = matchPendingReview(state, {
        prompt: 'Minimal prompt',
      });
      expect(result).not.toBeNull();
      expect(result!.tool).toBe('flowguard_plan');
    });

    it('returns null when multiple pending and prompt matches none', () => {
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

    it('returns matching pending when multiple pending and prompt matches one', () => {
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
      expect(result!.tool).toBe('flowguard_implement');
    });

    it('skips already-satisfied pending reviews', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 0, planVersion: 1 }),
        NOW,
      );

      // Mark as satisfied
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithFindings('s1'),
        LATER,
      );

      const result = matchPendingReview(state, {
        prompt: validSubagentPrompt({ iteration: 0, planVersion: 1 }),
      });
      expect(result).toBeNull();
    });
  });

  // ─── extractContentMeta ────────────────────────────────────
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

  // ─── extractCapturedFindings ───────────────────────────────
  describe('extractCapturedFindings', () => {
    it('extracts from clean JSON', () => {
      const findings = extractCapturedFindings(
        JSON.stringify({
          overallVerdict: 'approve',
          blockingIssues: [],
          reviewedBy: { sessionId: 's1' },
        }),
      );
      expect(findings).not.toBeNull();
      expect(findings!.overallVerdict).toBe('approve');
      expect(findings!.blockingIssuesCount).toBe(0);
      expect(findings!.sessionId).toBe('s1');
    });

    it('extracts from embedded JSON in text', () => {
      const text =
        'Here are the findings:\n' +
        JSON.stringify({
          overallVerdict: 'changes_requested',
          blockingIssues: [{ severity: 'critical', description: 'Missing tests' }],
          reviewedBy: { sessionId: 's2' },
        }) +
        '\nEnd of review.';
      const findings = extractCapturedFindings(text);
      expect(findings).not.toBeNull();
      expect(findings!.overallVerdict).toBe('changes_requested');
      expect(findings!.blockingIssuesCount).toBe(1);
      expect(findings!.sessionId).toBe('s2');
    });

    it('returns null for non-JSON text', () => {
      const findings = extractCapturedFindings('This is not JSON at all');
      expect(findings).toBeNull();
    });

    it('returns null for JSON without overallVerdict', () => {
      const findings = extractCapturedFindings(JSON.stringify({ status: 'ok' }));
      expect(findings).toBeNull();
    });

    it('handles unable_to_review verdict', () => {
      const findings = extractCapturedFindings(
        JSON.stringify({
          overallVerdict: 'unable_to_review',
          blockingIssues: [],
          reviewedBy: { sessionId: 's-unable' },
        }),
      );
      expect(findings).not.toBeNull();
      expect(findings!.overallVerdict).toBe('unable_to_review');
      expect(findings!.sessionId).toBe('s-unable');
    });
  });

  // ─── promptContainsValue ───────────────────────────────────
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

    // ─── EDGE: real-world mandate prompt formats ─────────────────────────────

    it('EDGE: matches XML-wrapped values (<iteration>0</iteration>)', () => {
      // P1.3 future templates may wrap context in XML. The `>` and whitespace
      // between tag and number are <30 non-digit chars.
      expect(promptContainsValue('<iteration>0</iteration>', 'iteration', 0)).toBe(true);
      expect(promptContainsValue('<iteration>\n  3\n</iteration>', 'iteration', 3)).toBe(true);
    });

    it('EDGE: matches JSON-embedded values ("iteration": 0)', () => {
      expect(promptContainsValue('{"iteration": 0, "planVersion": 1}', 'iteration', 0)).toBe(true);
    });

    it('EDGE: matches YAML-style values (iteration: 0)', () => {
      expect(promptContainsValue('iteration: 0\nplanVersion: 1', 'iteration', 0)).toBe(true);
    });

    it('EDGE: zero is a valid expected value (not falsy-tripped)', () => {
      expect(promptContainsValue('iteration=0', 'iteration', 0)).toBe(true);
      expect(promptContainsValue('iteration=1', 'iteration', 0)).toBe(false);
    });
  });
});
