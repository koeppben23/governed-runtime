/**
 * @module integration/review-enforcement-session.test
 * @description Tests for session ID resolution (BUG-14) and null-verdict tolerance (BUG-21).
 * Covers: resolveSessionIdFromMetadata, injectSessionIdIntoOutput,
 * onTaskToolAfter tiered session ID resolution, and BUG-21 null-verdict tolerance.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, E2E SMOKE — all categories present.
 */

import { describe, it, expect } from 'vitest';
import {
  createSessionState,
  onFlowGuardToolAfter,
  onTaskToolAfter,
  enforceBeforeVerdict,
} from './enforcement.js';
import {
  extractCapturedFindings,
  resolveSessionIdFromMetadata,
  injectSessionIdIntoOutput,
} from './extraction.js';
import {
  REVIEW_REQUIRED_PREFIX,
  REVIEWER_SUBAGENT_TYPE,
  type SessionEnforcementState,
} from './types.js';
import {
  NOW,
  LATER,
  modeASubagentResponse,
  taskResultWithFindings,
} from './test-helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// BUG-14: resolveSessionIdFromMetadata
// ═══════════════════════════════════════════════════════════════════════════════

describe('resolveSessionIdFromMetadata (BUG-14)', () => {
  it('HAPPY: extracts sessionID (SDK convention, PascalCase D)', () => {
    expect(resolveSessionIdFromMetadata({ sessionID: 'ses_abc123' })).toBe('ses_abc123');
  });

  it('HAPPY: extracts sessionId (camelCase)', () => {
    expect(resolveSessionIdFromMetadata({ sessionId: 'ses_xyz789' })).toBe('ses_xyz789');
  });

  it('HAPPY: extracts id (generic)', () => {
    expect(resolveSessionIdFromMetadata({ id: 'ses_id_only' })).toBe('ses_id_only');
  });

  it('HAPPY: prefers sessionID over sessionId over id (priority order)', () => {
    expect(
      resolveSessionIdFromMetadata({
        sessionID: 'first',
        sessionId: 'second',
        id: 'third',
      }),
    ).toBe('first');
  });

  it('HAPPY: falls through to sessionId when sessionID absent', () => {
    expect(
      resolveSessionIdFromMetadata({
        sessionId: 'second',
        id: 'third',
      }),
    ).toBe('second');
  });

  it('BAD: returns null for undefined metadata', () => {
    expect(resolveSessionIdFromMetadata(undefined)).toBeNull();
  });

  it('BAD: returns null for empty metadata', () => {
    expect(resolveSessionIdFromMetadata({})).toBeNull();
  });

  it('BAD: returns null when all fields are non-string', () => {
    expect(resolveSessionIdFromMetadata({ sessionID: 42, sessionId: true, id: null })).toBeNull();
  });

  it('CORNER: returns null for empty string sessionID', () => {
    expect(resolveSessionIdFromMetadata({ sessionID: '' })).toBeNull();
  });

  it('CORNER: returns null for empty string sessionId', () => {
    expect(resolveSessionIdFromMetadata({ sessionID: '', sessionId: '' })).toBeNull();
  });

  it('CORNER: skips empty sessionID but finds valid sessionId', () => {
    expect(resolveSessionIdFromMetadata({ sessionID: '', sessionId: 'ses_valid' })).toBe(
      'ses_valid',
    );
  });

  it('EDGE: handles metadata with many unrelated fields', () => {
    expect(
      resolveSessionIdFromMetadata({
        model: 'gpt-4',
        tokens: 1500,
        sessionID: 'ses_deep',
        latency: 234,
      }),
    ).toBe('ses_deep');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUG-14: injectSessionIdIntoOutput
// ═══════════════════════════════════════════════════════════════════════════════

describe('injectSessionIdIntoOutput (BUG-14)', () => {
  it('HAPPY: injects into clean JSON with existing reviewedBy object', () => {
    const input = JSON.stringify({
      overallVerdict: 'approve',
      reviewedBy: { sessionId: 'unknown' },
    });
    const result = injectSessionIdIntoOutput(input, 'ses_real_123');
    const parsed = JSON.parse(result);
    expect(parsed.reviewedBy.sessionId).toBe('ses_real_123');
    expect(parsed.overallVerdict).toBe('approve');
  });

  it('HAPPY: injects into clean JSON with missing reviewedBy', () => {
    const input = JSON.stringify({ overallVerdict: 'approve' });
    const result = injectSessionIdIntoOutput(input, 'ses_injected');
    const parsed = JSON.parse(result);
    expect(parsed.reviewedBy).toEqual({ sessionId: 'ses_injected' });
  });

  it('HAPPY: injects into clean JSON with string reviewedBy (replaced with object)', () => {
    const input = JSON.stringify({
      overallVerdict: 'approve',
      reviewedBy: 'flowguard-reviewer',
    });
    const result = injectSessionIdIntoOutput(input, 'ses_obj');
    const parsed = JSON.parse(result);
    expect(parsed.reviewedBy).toEqual({ sessionId: 'ses_obj' });
  });

  it('HAPPY: injects into embedded JSON in text', () => {
    const json = JSON.stringify({
      overallVerdict: 'changes_requested',
      reviewedBy: { sessionId: 'placeholder' },
      blockingIssues: [{ message: 'test' }],
    });
    const input = `Here is my review:\n${json}\n\nPlease fix these issues.`;
    const result = injectSessionIdIntoOutput(input, 'ses_embedded');
    expect(result).toContain('"ses_embedded"');
    expect(result).toContain('Here is my review:');
    expect(result).toContain('Please fix these issues.');
    // Verify the JSON block itself is valid
    const jsonStart = result.indexOf('{');
    const jsonEnd = result.lastIndexOf('}');
    const parsed = JSON.parse(result.slice(jsonStart, jsonEnd + 1));
    expect(parsed.reviewedBy.sessionId).toBe('ses_embedded');
  });

  it('HAPPY: injects synthetic derived:call: ID', () => {
    const input = JSON.stringify({
      overallVerdict: 'approve',
      reviewedBy: { sessionId: '' },
    });
    const result = injectSessionIdIntoOutput(input, 'derived:call:abc123');
    const parsed = JSON.parse(result);
    expect(parsed.reviewedBy.sessionId).toBe('derived:call:abc123');
  });

  it('BAD: returns unchanged for non-JSON text', () => {
    const input = 'This is not JSON at all. No braces here.';
    expect(injectSessionIdIntoOutput(input, 'ses_x')).toBe(input);
  });

  it('BAD: returns unchanged for empty string', () => {
    expect(injectSessionIdIntoOutput('', 'ses_x')).toBe('');
  });

  it('BAD: returns unchanged for JSON without reviewedBy marker', () => {
    const input = JSON.stringify({ verdict: 'approve', score: 42 });
    // No "reviewedBy" string in the output, but it IS clean JSON.
    // The function will parse it, find no reviewedBy, and create one.
    const result = injectSessionIdIntoOutput(input, 'ses_new');
    const parsed = JSON.parse(result);
    expect(parsed.reviewedBy).toEqual({ sessionId: 'ses_new' });
  });

  it('CORNER: preserves other reviewedBy fields', () => {
    const input = JSON.stringify({
      overallVerdict: 'approve',
      reviewedBy: { sessionId: 'old', actorId: 'user@example.com', actorSource: 'git' },
    });
    const result = injectSessionIdIntoOutput(input, 'ses_new');
    const parsed = JSON.parse(result);
    expect(parsed.reviewedBy.sessionId).toBe('ses_new');
    expect(parsed.reviewedBy.actorId).toBe('user@example.com');
    expect(parsed.reviewedBy.actorSource).toBe('git');
  });

  it('CORNER: handles reviewedBy as array (replaced with object)', () => {
    const input = JSON.stringify({
      overallVerdict: 'approve',
      reviewedBy: ['invalid', 'array'],
    });
    const result = injectSessionIdIntoOutput(input, 'ses_fix');
    const parsed = JSON.parse(result);
    expect(parsed.reviewedBy).toEqual({ sessionId: 'ses_fix' });
  });

  it('CORNER: handles reviewedBy as null (replaced with object)', () => {
    const input = JSON.stringify({
      overallVerdict: 'approve',
      reviewedBy: null,
    });
    const result = injectSessionIdIntoOutput(input, 'ses_null_fix');
    const parsed = JSON.parse(result);
    expect(parsed.reviewedBy).toEqual({ sessionId: 'ses_null_fix' });
  });

  it('EDGE: handles JSON with escaped quotes', () => {
    const input = JSON.stringify({
      overallVerdict: 'approve',
      reviewedBy: { sessionId: 'old' },
      notes: 'The code says "hello" and it\'s fine',
    });
    const result = injectSessionIdIntoOutput(input, 'ses_escaped');
    const parsed = JSON.parse(result);
    expect(parsed.reviewedBy.sessionId).toBe('ses_escaped');
    expect(parsed.notes).toContain('"hello"');
  });

  it('EDGE: handles JSON array at top level (returns unchanged)', () => {
    const input = JSON.stringify([{ reviewedBy: { sessionId: 'old' } }]);
    // Clean JSON parse succeeds but it's an array → not an object → fall through
    // Path 2 will find "reviewedBy" and try embedded extraction
    const result = injectSessionIdIntoOutput(input, 'ses_arr');
    // Should find the embedded block and inject
    expect(result).toContain('"ses_arr"');
  });

  it('SMOKE: round-trip — inject then extract matches', () => {
    const input = JSON.stringify({
      overallVerdict: 'approve',
      reviewedBy: { sessionId: 'unknown' },
      blockingIssues: [],
    });
    const injected = injectSessionIdIntoOutput(input, 'ses_round_trip');
    const findings = extractCapturedFindings(injected);
    expect(findings).not.toBeNull();
    expect(findings!.sessionId).toBe('ses_round_trip');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUG-14: onTaskToolAfter tiered session ID resolution
// ═══════════════════════════════════════════════════════════════════════════════

describe('onTaskToolAfter tiered session ID resolution (BUG-14)', () => {
  const REVIEW_FINDINGS_JSON = JSON.stringify({
    overallVerdict: 'approve',
    reviewedBy: { sessionId: 'text_ses_id' },
    blockingIssues: [],
  });

  const REVIEW_FINDINGS_NO_SESSION = JSON.stringify({
    overallVerdict: 'approve',
    reviewedBy: {},
    blockingIssues: [],
  });

  function setupPendingReview(): SessionEnforcementState {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);
    return state;
  }

  it('HAPPY: Tier 1 — metadata.sessionID used as authoritative session ID', () => {
    const state = setupPendingReview();
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review plan' },
      REVIEW_FINDINGS_JSON,
      LATER,
      { metadata: { sessionID: 'ses_from_metadata' }, callID: 'call_001' },
    );
    const pending = state.pendingReviews.get('flowguard_plan');
    expect(pending?.subagentRecord?.sessionId).toBe('ses_from_metadata');
  });

  it('HAPPY: Tier 1 — metadata.sessionId (camelCase) also works', () => {
    const state = setupPendingReview();
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review plan' },
      REVIEW_FINDINGS_JSON,
      LATER,
      { metadata: { sessionId: 'ses_camel' } },
    );
    const pending = state.pendingReviews.get('flowguard_plan');
    expect(pending?.subagentRecord?.sessionId).toBe('ses_camel');
  });

  it('HAPPY: Tier 2 — falls through to text extraction when metadata absent', () => {
    const state = setupPendingReview();
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review plan' },
      REVIEW_FINDINGS_JSON,
      LATER,
      { metadata: {}, callID: 'call_002' },
    );
    const pending = state.pendingReviews.get('flowguard_plan');
    // Tier 2: extracted from REVIEW_FINDINGS_JSON reviewedBy.sessionId
    expect(pending?.subagentRecord?.sessionId).toBe('text_ses_id');
  });

  it('HAPPY: Tier 3 — synthetic callID when both metadata and text fail', () => {
    const state = setupPendingReview();
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review plan' },
      REVIEW_FINDINGS_NO_SESSION,
      LATER,
      { metadata: {}, callID: 'call_fallback' },
    );
    const pending = state.pendingReviews.get('flowguard_plan');
    expect(pending?.subagentRecord?.sessionId).toBe('derived:call:call_fallback');
  });

  it('BAD: all sources empty — sessionId is null (fail-closed)', () => {
    const state = setupPendingReview();
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review plan' },
      REVIEW_FINDINGS_NO_SESSION,
      LATER,
      { metadata: {}, callID: '' },
    );
    const pending = state.pendingReviews.get('flowguard_plan');
    expect(pending?.subagentRecord?.sessionId).toBeNull();
  });

  it('BAD: no context (backward compat) — falls to Tier 2 only', () => {
    const state = setupPendingReview();
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review plan' },
      REVIEW_FINDINGS_JSON,
      LATER,
    );
    const pending = state.pendingReviews.get('flowguard_plan');
    // No context → Tier 1 skipped, Tier 2 extracts from text
    expect(pending?.subagentRecord?.sessionId).toBe('text_ses_id');
  });

  it('BAD: no context + no text session ID — null (backward compat)', () => {
    const state = setupPendingReview();
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review plan' },
      'Plain text with no JSON at all',
      LATER,
    );
    const pending = state.pendingReviews.get('flowguard_plan');
    // No context → no Tier 3, Tier 2 fails → null
    expect(pending?.subagentRecord?.sessionId).toBeNull();
  });

  it('CORNER: Tier 1 with empty string sessionID — skips to Tier 2', () => {
    const state = setupPendingReview();
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review plan' },
      REVIEW_FINDINGS_JSON,
      LATER,
      { metadata: { sessionID: '' }, callID: 'call_003' },
    );
    const pending = state.pendingReviews.get('flowguard_plan');
    // Empty string → Tier 1 returns null → falls to Tier 2
    expect(pending?.subagentRecord?.sessionId).toBe('text_ses_id');
  });

  it('CORNER: Tier 1 takes priority over Tier 2 even when both available', () => {
    const state = setupPendingReview();
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review plan' },
      REVIEW_FINDINGS_JSON,
      LATER,
      { metadata: { sessionID: 'ses_authoritative' }, callID: 'call_004' },
    );
    const pending = state.pendingReviews.get('flowguard_plan');
    // Tier 1 wins over Tier 2's "text_ses_id"
    expect(pending?.subagentRecord?.sessionId).toBe('ses_authoritative');
  });

  it('EDGE: non-reviewer subagent type is ignored (no session ID resolution)', () => {
    const state = createSessionState();
    onTaskToolAfter(
      state,
      { subagent_type: 'explore', prompt: 'Look at code' },
      REVIEW_FINDINGS_JSON,
      LATER,
      { metadata: { sessionID: 'ses_explore' }, callID: 'call_005' },
    );
    // No pending review registered → nothing to update
    expect(state.pendingReviews.size).toBe(0);
  });

  it('E2E: full cycle with metadata sessionID produces non-null session in pending', () => {
    const state = createSessionState();

    // Step 1: Mode A response
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);

    // Step 2: Task call with metadata
    const findings = JSON.stringify({
      overallVerdict: 'approve',
      reviewedBy: { sessionId: 'will_be_overridden' },
      blockingIssues: [],
    });
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review plan' },
      findings,
      LATER,
      { metadata: { sessionID: 'ses_e2e_real' }, callID: 'call_e2e' },
    );

    const pending = state.pendingReviews.get('flowguard_plan');
    expect(pending).toBeDefined();
    expect(pending!.subagentCalled).toBe(true);
    expect(pending!.subagentRecord).not.toBeNull();
    expect(pending!.subagentRecord!.sessionId).toBe('ses_e2e_real');
    expect(pending!.capturedFindings).not.toBeNull();
    expect(pending!.capturedFindings!.overallVerdict).toBe('approve');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUG-21: Null-verdict tolerance and sessionState fallback
// ═══════════════════════════════════════════════════════════════════════════════
//
// DeepSeek R1 sends explicit null for absent optional fields:
//   { planText: "...", selfReviewVerdict: null, reviewFindings: null }
//
// The `in` operator returns true for keys with null values, causing:
//   - enforceBeforeVerdict to enter Mode B enforcement path spuriously
//   - onFlowGuardToolAfter to clear pending reviews spuriously
//
// Additionally, after /ticket (before first /plan), reviewAssurance is
// undefined in sessionState. The old code treated this as "state unreadable"
// and returned REVIEW_ASSURANCE_STATE_UNAVAILABLE in strict mode.
// ═══════════════════════════════════════════════════════════════════════════════

describe('BUG-21: null-verdict tolerance (enforceBeforeVerdict)', () => {
  // ── Fix A: Value-based hasSelfReviewVerdict ────────────────────────────

  it('HAPPY: selfReviewVerdict=null is treated as Mode A → allowed immediately', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: 'my plan', selfReviewVerdict: null },
      { reviewAssurance: undefined },
      true, // strict
    );
    expect(result.allowed).toBe(true);
  });

  it('HAPPY: reviewVerdict=null is treated as Mode A → allowed immediately', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_implement',
      { reviewVerdict: null },
      { reviewAssurance: undefined },
      true,
    );
    expect(result.allowed).toBe(true);
  });

  it('HAPPY: both verdict keys null → allowed (Mode A)', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: 'plan', selfReviewVerdict: null, reviewVerdict: null },
      { reviewAssurance: undefined },
      true,
    );
    expect(result.allowed).toBe(true);
  });

  it('BAD: selfReviewVerdict="" (empty string) is treated as Mode A → allowed', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: 'plan', selfReviewVerdict: '' },
      { reviewAssurance: undefined },
      true,
    );
    expect(result.allowed).toBe(true);
  });

  it('CORNER: selfReviewVerdict=undefined (key absent) is treated as Mode A', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: 'plan' },
      { reviewAssurance: undefined },
      true,
    );
    expect(result.allowed).toBe(true);
  });

  it('EDGE: selfReviewVerdict=0 (falsy non-string) is treated as Mode A', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: 'plan', selfReviewVerdict: 0 },
      { reviewAssurance: undefined },
      true,
    );
    expect(result.allowed).toBe(true);
  });

  it('EDGE: selfReviewVerdict=false (boolean) is treated as Mode A', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: 'plan', selfReviewVerdict: false },
      { reviewAssurance: undefined },
      true,
    );
    expect(result.allowed).toBe(true);
  });

  it('HAPPY: selfReviewVerdict="approve" enters enforcement (Mode B positive)', () => {
    const state = createSessionState();
    // Set up pending with subagent called
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review iteration=0 planVersion=1' },
      JSON.stringify({ overallVerdict: 'approve', blockingIssues: [] }),
      LATER,
    );

    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { selfReviewVerdict: 'approve' },
      {
        reviewAssurance: { obligations: [], invocations: [] },
      },
    );
    expect(result.allowed).toBe(true);
  });

  it('BAD: selfReviewVerdict="approve" but no subagent called → blocked', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);
    // No Task call

    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { selfReviewVerdict: 'approve' },
      {
        reviewAssurance: { obligations: [], invocations: [] },
      },
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('SUBAGENT_REVIEW_NOT_INVOKED');
  });

  // ── Fix B: SessionState fallback ──────────────────────────────────────

  it('HAPPY: sessionState readable, reviewAssurance=undefined → allowed', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { selfReviewVerdict: 'approve' },
      { reviewAssurance: undefined },
      true, // strict
    );
    expect(result.allowed).toBe(true);
  });

  it('HAPPY: sessionState readable, reviewAssurance=null → allowed', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { selfReviewVerdict: 'approve' },
      { reviewAssurance: null },
      true,
    );
    expect(result.allowed).toBe(true);
  });

  it('HAPPY: sessionState readable, obligations=[] → allowed', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { selfReviewVerdict: 'approve' },
      { reviewAssurance: { obligations: [], invocations: [] } },
      true,
    );
    expect(result.allowed).toBe(true);
  });

  it('BAD: sessionState=null, strict=true → REVIEW_ASSURANCE_STATE_UNAVAILABLE', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { selfReviewVerdict: 'approve' },
      null,
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('REVIEW_ASSURANCE_STATE_UNAVAILABLE');
  });

  it('CORNER: sessionState=undefined, strict=true → BLOCKED', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { selfReviewVerdict: 'approve' },
      undefined,
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('REVIEW_ASSURANCE_STATE_UNAVAILABLE');
  });

  it('HAPPY: sessionState=null, strict=false → allowed', () => {
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

  it('EDGE: sessionState readable, pending obligation → SUBAGENT_REVIEW_NOT_INVOKED', () => {
    const state = createSessionState();
    const sessionState = {
      reviewAssurance: {
        obligations: [
          {
            obligationId: '00000000-0000-4000-8000-bug21pending01',
            obligationType: 'plan' as const,
            iteration: 0,
            planVersion: 1,
            criteriaVersion: 'v1',
            mandateDigest: 'digest',
            createdAt: NOW,
            pluginHandshakeAt: null,
            status: 'pending' as const,
            invocationId: null,
            blockedCode: null,
            fulfilledAt: null,
            consumedAt: null,
          },
        ],
        invocations: [],
      },
    };
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { selfReviewVerdict: 'approve' },
      sessionState,
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('SUBAGENT_REVIEW_NOT_INVOKED');
    expect(result.reason).toContain('bug21pending01');
  });

  it('EDGE: sessionState readable, obligation for DIFFERENT tool → allowed', () => {
    const state = createSessionState();
    const sessionState = {
      reviewAssurance: {
        obligations: [
          {
            obligationId: '00000000-0000-4000-8000-bug21impl0001',
            obligationType: 'implement' as const,
            iteration: 0,
            planVersion: 1,
            criteriaVersion: 'v1',
            mandateDigest: 'digest',
            createdAt: NOW,
            pluginHandshakeAt: null,
            status: 'pending' as const,
            invocationId: null,
            blockedCode: null,
            fulfilledAt: null,
            consumedAt: null,
          },
        ],
        invocations: [],
      },
    };
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { selfReviewVerdict: 'approve' },
      sessionState,
      true,
    );
    // Plan tool has no pending obligation → allowed
    expect(result.allowed).toBe(true);
  });

  // ── Combined Fix A+B: DeepSeek R1 exact scenario ──────────────────────

  it('E2E SMOKE: DeepSeek R1 sends { planText, selfReviewVerdict: null } after /ticket → allowed', () => {
    const state = createSessionState();
    // After /ticket: sessionState exists, reviewAssurance undefined
    const sessionState = { reviewAssurance: undefined };
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: 'My detailed plan', selfReviewVerdict: null, reviewFindings: null },
      sessionState,
      true,
    );
    expect(result.allowed).toBe(true);
  });

  it('E2E SMOKE: DeepSeek R1 sends { planText, selfReviewVerdict: "approve" } after /ticket → allowed (proceeds to tool for PLAN_APPROVE_WITH_TEXT)', () => {
    const state = createSessionState();
    const sessionState = { reviewAssurance: undefined };
    // This should NOT be blocked by enforcement — the PLAN_APPROVE_WITH_TEXT
    // error comes from the tool's own mode detection, not from enforcement.
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: 'My plan', selfReviewVerdict: 'approve', reviewFindings: {} },
      sessionState,
      true,
    );
    expect(result.allowed).toBe(true);
  });

  it('E2E: verdict after reviewer completes with null reviewFindings → enforcement passes (Levels 2/4 skipped)', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review iteration=0 planVersion=1' },
      JSON.stringify({ overallVerdict: 'approve', blockingIssues: [] }),
      LATER,
    );

    // DeepSeek R1 sends verdict with reviewFindings: null (stripped by Fix G
    // before reaching here, so args would have no reviewFindings key).
    // But even if raw null reaches enforcement, Levels 2/4 skip gracefully.
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { selfReviewVerdict: 'approve', reviewFindings: null },
      { reviewAssurance: { obligations: [], invocations: [] } },
    );
    expect(result.allowed).toBe(true);
  });
});

describe('BUG-21: null-verdict tolerance (onFlowGuardToolAfter)', () => {
  // ── Fix C: Value-based check in After-Hook ────────────────────────────

  it('HAPPY: Mode A output with null verdict key → pendingReview created (not cleared)', () => {
    const state = createSessionState();
    // Simulates: args have selfReviewVerdict: null (After-Hook may see raw args)
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      { planText: 'plan', selfReviewVerdict: null },
      modeASubagentResponse(),
      NOW,
    );
    const pending = state.pendingReviews.get('flowguard_plan');
    expect(pending).toBeDefined();
    expect(pending!.subagentCalled).toBe(false);
  });

  it('HAPPY: Mode A output with no verdict key → pendingReview created', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      { planText: 'plan' },
      modeASubagentResponse(),
      NOW,
    );
    const pending = state.pendingReviews.get('flowguard_plan');
    expect(pending).toBeDefined();
  });

  it('HAPPY: Mode B output with valid verdict → pendingReview cleared', () => {
    const state = createSessionState();
    // Set up pending
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);
    expect(state.pendingReviews.has('flowguard_plan')).toBe(true);

    // Simulate Mode B success output (no REVIEW_REQUIRED in next)
    const modeBOutput = JSON.stringify({
      phase: 'PLAN_REVIEW',
      status: 'Verdict recorded.',
      next: 'Proceed to implementation.',
    });
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      { selfReviewVerdict: 'approve' },
      modeBOutput,
      LATER,
    );
    expect(state.pendingReviews.has('flowguard_plan')).toBe(false);
  });

  it('BAD: Mode B output with verdict but error=true → pendingReview NOT cleared', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);

    const errorOutput = JSON.stringify({
      error: true,
      code: 'PLAN_APPROVE_WITH_TEXT',
      next: 'Fix your call.',
    });
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      { selfReviewVerdict: 'approve' },
      errorOutput,
      LATER,
    );
    // Not cleared because output had error=true
    expect(state.pendingReviews.has('flowguard_plan')).toBe(true);
  });

  it('CORNER: reviewVerdict=null with Mode A output → pendingReview created (implement tool)', () => {
    const state = createSessionState();
    const implResponse = JSON.stringify({
      phase: 'IMPL_REVIEW',
      next: `${REVIEW_REQUIRED_PREFIX}: Review the implementation. iteration=0 planVersion=1`,
    });
    onFlowGuardToolAfter(state, 'flowguard_implement', { reviewVerdict: null }, implResponse, NOW);
    expect(state.pendingReviews.has('flowguard_implement')).toBe(true);
  });

  it('EDGE: selfReviewVerdict="" (empty string) → not treated as verdict → no clear', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);

    const successOutput = JSON.stringify({ phase: 'PLAN_REVIEW', status: 'ok' });
    onFlowGuardToolAfter(state, 'flowguard_plan', { selfReviewVerdict: '' }, successOutput, NOW);
    // Empty string is not a valid verdict → pending NOT cleared
    expect(state.pendingReviews.has('flowguard_plan')).toBe(true);
  });

  it('E2E SMOKE: full cycle — Mode A (null verdict) → Task → Mode B (real verdict) → cleared', () => {
    const state = createSessionState();

    // Step 1: Mode A with null verdict in args (DeepSeek R1 behavior)
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      { planText: 'plan', selfReviewVerdict: null, reviewFindings: null },
      modeASubagentResponse(),
      NOW,
    );
    expect(state.pendingReviews.has('flowguard_plan')).toBe(true);
    expect(state.pendingReviews.get('flowguard_plan')!.subagentCalled).toBe(false);

    // Step 2: Reviewer Task
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review iteration=0 planVersion=1' },
      JSON.stringify({ overallVerdict: 'approve', blockingIssues: [] }),
      LATER,
    );
    expect(state.pendingReviews.get('flowguard_plan')!.subagentCalled).toBe(true);

    // Step 3: Mode B with real verdict
    const modeBOutput = JSON.stringify({ phase: 'PLAN_REVIEW', status: 'approved' });
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      { selfReviewVerdict: 'approve' },
      modeBOutput,
      LATER,
    );
    expect(state.pendingReviews.has('flowguard_plan')).toBe(false);
  });
});
