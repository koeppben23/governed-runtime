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
import { extractContentMeta, extractCapturedFindings, promptContainsValue } from './extraction.js';
import { REVIEWER_SUBAGENT_TYPE } from './types.js';
import {
  NOW,
  LATER,
  modeASubagentResponse,
  taskResultWithFindings,
  taskResultWithMalformedFindings,
  validSubagentPrompt,
  FIXTURE_OBLIGATION_ID,
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

    it('re-arms a pending review with schema-invalid captured findings', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({
          iteration: 0,
          planVersion: 1,
          obligationId: FIXTURE_OBLIGATION_ID,
        }),
        NOW,
      );

      // This legacy capture is schema-invalid at the ReviewerFindingsInput
      // boundary, so a canonical repair attempt remains eligible.
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithFindings('s1'),
        LATER,
      );

      const result = matchPendingReview(state, {
        prompt: validSubagentPrompt({ iteration: 0, planVersion: 1 }),
      });
      expect(result).not.toBeNull();
    });

    // ─── Structural re-arm (host-task deadlock recovery) ───────────
    // A reviewer run that produces an UNPARSEABLE capture must not lock the
    // obligation. Reproduces the live-demo deadlock where a single mistyped
    // field (`majorRiskes`) poisoned the review and every re-run was rejected
    // as duplicate_evidence against the corrupt capture.
    it('re-arms a called review whose captured findings are unparseable (reviewer typo)', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 0, planVersion: 1 }),
        NOW,
      );
      // First reviewer run: valid JSON, overallVerdict present, but `majorRisks`
      // mistyped → capturedFindings is non-null yet fails ReviewFindings.safeParse.
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithMalformedFindings('child-corrupt'),
        LATER,
      );
      // The obligation must remain matchable so a re-run can replace the capture.
      const result = matchPendingReview(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt: validSubagentPrompt({ iteration: 0, planVersion: 1 }),
      });
      expect(result).not.toBeNull();
      expect(result!.tool).toBe('flowguard_plan');
    });

    it('re-arms a called review whose reviewer produced no parseable findings', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 0, planVersion: 1 }),
        NOW,
      );
      // Non-JSON reviewer output → capturedFindings is null → still re-armable.
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        'This is not JSON at all — the reviewer failed to emit findings.',
        LATER,
      );
      const result = matchPendingReview(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt: validSubagentPrompt({ iteration: 0, planVersion: 1 }),
      });
      expect(result).not.toBeNull();
      expect(result!.tool).toBe('flowguard_plan');
    });

    it('stops re-arming once a valid re-capture replaces the corrupt one', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(
        state,
        'flowguard_plan',
        { planText: '## Plan' },
        modeASubagentResponse({ iteration: 0, planVersion: 1 }),
        NOW,
      );
      // Corrupt first capture...
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithMalformedFindings('child-corrupt'),
        LATER,
      );
      // ...replaced by a valid re-run capture (re-arm path overwrites it).
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review' },
        taskResultWithFindings('child-valid'),
        LATER,
      );
      // Good capture now present → obligation is satisfied, no further re-arm.
      const result = matchPendingReview(state, {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
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
          overallVerdict: 'accept',
          blockingIssues: [],
          reviewedBy: { sessionId: 's1' },
        }),
      );
      expect(findings).not.toBeNull();
      expect(findings!.overallVerdict).toBe('accept');
      expect(findings!.blockingIssuesCount).toBe(0);
      expect(findings!.sessionId).toBe('s1');
    });

    // Provenance is authority: extractionMethod drives the downstream assurance
    // downgrade (evidence-binding.ts: recovered_block → structured_recovered,
    // otherwise structured_high). These pin that contract.
    it('marks bare JSON as clean_json (high assurance)', () => {
      const findings = extractCapturedFindings(
        JSON.stringify({ overallVerdict: 'accept', blockingIssues: [] }),
      );
      expect(findings!.extractionMethod).toBe('clean_json');
    });

    it('marks bare JSON with surrounding whitespace as clean_json', () => {
      const findings = extractCapturedFindings(
        '  \n' + JSON.stringify({ overallVerdict: 'accept', blockingIssues: [] }) + '\n  ',
      );
      expect(findings!.extractionMethod).toBe('clean_json');
    });

    it('marks prose-wrapped JSON as recovered_block (downgraded assurance)', () => {
      const findings = extractCapturedFindings(
        'Reasoning first.\n' + JSON.stringify({ overallVerdict: 'accept', blockingIssues: [] }),
      );
      expect(findings!.extractionMethod).toBe('recovered_block');
    });

    it('marks fenced JSON as recovered_block (not clean, matches prior behavior)', () => {
      const findings = extractCapturedFindings(
        '```json\n' + JSON.stringify({ overallVerdict: 'accept', blockingIssues: [] }) + '\n```',
      );
      expect(findings!.extractionMethod).toBe('recovered_block');
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

    // ─── Brittleness regressions (host-task no_matched_record) ──────────────
    // The canonical reviewerTaskPrompt invites prose/reasoning and quoted
    // artifact content (ADR/diff) around the ReviewFindings JSON. These are the
    // exact shapes that produced `no_matched_record` in the wild and must now
    // extract cleanly.

    it('extracts when nested { precedes overallVerdict (field ordering)', () => {
      // blockingIssues/reviewedBy objects appear BEFORE overallVerdict — the
      // old verdict-anchored regex (\{[^{}]*"overallVerdict") cannot recover
      // this because a nested `{` occurs before the verdict token.
      const text =
        'Now I have all the evidence. Let me compile the findings.\n\n' +
        JSON.stringify({
          blockingIssues: [{ severity: 'critical', message: 'x' }],
          reviewedBy: { sessionId: 's-ordered' },
          overallVerdict: 'changes_requested',
        }) +
        '\n';
      const findings = extractCapturedFindings(text);
      expect(findings).not.toBeNull();
      expect(findings!.overallVerdict).toBe('changes_requested');
      expect(findings!.blockingIssuesCount).toBe(1);
      expect(findings!.sessionId).toBe('s-ordered');
    });

    it('extracts JSON wrapped in a ```json code fence', () => {
      const text =
        'Here is my review:\n```json\n' +
        JSON.stringify({
          overallVerdict: 'accept',
          blockingIssues: [],
          reviewedBy: { sessionId: 's-fence' },
        }) +
        '\n```\n';
      const findings = extractCapturedFindings(text);
      expect(findings).not.toBeNull();
      expect(findings!.overallVerdict).toBe('accept');
      expect(findings!.sessionId).toBe('s-fence');
    });

    it('selects the reviewer JSON even when quoted artifact braces precede it', () => {
      // The reviewer quotes an ADR/diff (which contains `{`) BEFORE emitting its
      // own ReviewFindings JSON at the end. A naive first-object scan would grab
      // the quoted artifact block; the reviewer verdict is the LAST valid
      // overallVerdict-bearing object.
      const quotedArtifact =
        'Reviewed ADR body:\n```java\npublic Task get(String id) { return repo.findById(id); }\n```\n' +
        'Example config: { "spring": { "datasource": { "url": "x" } } }\n';
      const reviewJson = JSON.stringify({
        overallVerdict: 'accept',
        blockingIssues: [],
        reviewedBy: { sessionId: 's-last' },
      });
      const findings = extractCapturedFindings(quotedArtifact + '\n' + reviewJson);
      expect(findings).not.toBeNull();
      expect(findings!.overallVerdict).toBe('accept');
      expect(findings!.sessionId).toBe('s-last');
    });

    it('selects the LAST overallVerdict object when two are present', () => {
      // A quoted example ReviewFindings (e.g. from the prompt skeleton) precedes
      // the real verdict. The real verdict is last.
      const exampleSkeleton = JSON.stringify({
        overallVerdict: 'accept',
        blockingIssues: [],
        reviewedBy: { sessionId: 'example' },
      });
      const realVerdict = JSON.stringify({
        overallVerdict: 'changes_requested',
        blockingIssues: [{ severity: 'major', message: 'y' }],
        reviewedBy: { sessionId: 's-real' },
      });
      const findings = extractCapturedFindings(
        'For reference, return this shape:\n' +
          exampleSkeleton +
          '\n\nMy actual review:\n' +
          realVerdict,
      );
      expect(findings).not.toBeNull();
      expect(findings!.overallVerdict).toBe('changes_requested');
      expect(findings!.blockingIssuesCount).toBe(1);
      expect(findings!.sessionId).toBe('s-real');
    });

    it('does not mistake a { inside a string value for structure', () => {
      const text =
        'Prose before.\n' +
        JSON.stringify({
          overallVerdict: 'accept',
          blockingIssues: [],
          reviewedBy: { sessionId: 's-str' },
          note: 'the diff had a `{` brace in it',
        });
      const findings = extractCapturedFindings(text);
      expect(findings).not.toBeNull();
      expect(findings!.overallVerdict).toBe('accept');
      expect(findings!.sessionId).toBe('s-str');
    });

    it('still returns null when no overallVerdict object exists (fail-closed)', () => {
      const text = 'Config: { "a": { "b": 1 } } and prose, but no verdict object.';
      expect(extractCapturedFindings(text)).toBeNull();
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
