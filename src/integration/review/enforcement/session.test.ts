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
  resolveSubagentSessionId,
  injectSessionIdIntoOutput,
} from './extraction.js';
import { REVIEW_REQUIRED_PREFIX, type SessionEnforcementState } from './types.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import { NOW, LATER, modeASubagentResponse, taskResultWithFindings } from './test-helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// B (hardening): canonical 3-tier resolveSubagentSessionId — single source of truth
// shared by the output-injection path and the persisted-evidence path.
// ═══════════════════════════════════════════════════════════════════════════════

describe('resolveSubagentSessionId (unified 3-tier)', () => {
  it('Tier 1: metadata wins over text and callID', () => {
    const text = JSON.stringify({ reviewedBy: { sessionId: 'ses_text' } });
    expect(resolveSubagentSessionId({ sessionID: 'ses_meta' }, text, 'call_1')).toBe('ses_meta');
  });

  it('Tier 2: text-extracted sessionId when metadata absent', () => {
    const text = JSON.stringify({ reviewedBy: { sessionId: 'ses_text' } });
    expect(resolveSubagentSessionId(undefined, text, 'call_1')).toBe('ses_text');
  });

  it('Tier 3: synthetic derived:call when metadata and text absent', () => {
    expect(resolveSubagentSessionId({}, 'not json', 'call_1')).toBe('derived:call:call_1');
  });

  it('null when all tiers unavailable (no metadata, no text, no callID)', () => {
    expect(resolveSubagentSessionId(undefined, 'not json', undefined)).toBeNull();
  });
});

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
      overallVerdict: 'accept',
      reviewedBy: { sessionId: 'unknown' },
    });
    const result = injectSessionIdIntoOutput(input, 'ses_real_123');
    const parsed = JSON.parse(result);
    expect(parsed.reviewedBy.sessionId).toBe('ses_real_123');
    expect(parsed.overallVerdict).toBe('accept');
  });

  it('HAPPY: injects into clean JSON with missing reviewedBy', () => {
    const input = JSON.stringify({ overallVerdict: 'accept' });
    const result = injectSessionIdIntoOutput(input, 'ses_injected');
    const parsed = JSON.parse(result);
    expect(parsed.reviewedBy).toEqual({ sessionId: 'ses_injected' });
  });

  it('HAPPY: injects into clean JSON with string reviewedBy (replaced with object)', () => {
    const input = JSON.stringify({
      overallVerdict: 'accept',
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
    const jsonStart = result.indexOf('{');
    const jsonEnd = result.lastIndexOf('}');
    const parsed = JSON.parse(result.slice(jsonStart, jsonEnd + 1));
    expect(parsed.reviewedBy.sessionId).toBe('ses_embedded');
  });

  it('HAPPY: injects synthetic derived:call: ID', () => {
    const input = JSON.stringify({
      overallVerdict: 'accept',
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

  it('BAD: creates reviewedBy for clean JSON without it', () => {
    const input = JSON.stringify({ verdict: 'approve', score: 42 });
    const result = injectSessionIdIntoOutput(input, 'ses_new');
    const parsed = JSON.parse(result);
    expect(parsed.reviewedBy).toEqual({ sessionId: 'ses_new' });
  });

  it('CORNER: preserves other reviewedBy fields', () => {
    const input = JSON.stringify({
      overallVerdict: 'accept',
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
      overallVerdict: 'accept',
      reviewedBy: ['invalid', 'array'],
    });
    const result = injectSessionIdIntoOutput(input, 'ses_fix');
    const parsed = JSON.parse(result);
    expect(parsed.reviewedBy).toEqual({ sessionId: 'ses_fix' });
  });

  it('CORNER: handles reviewedBy as null (replaced with object)', () => {
    const input = JSON.stringify({
      overallVerdict: 'accept',
      reviewedBy: null,
    });
    const result = injectSessionIdIntoOutput(input, 'ses_null_fix');
    const parsed = JSON.parse(result);
    expect(parsed.reviewedBy).toEqual({ sessionId: 'ses_null_fix' });
  });

  it('EDGE: handles JSON with escaped quotes', () => {
    const input = JSON.stringify({
      overallVerdict: 'accept',
      reviewedBy: { sessionId: 'old' },
      notes: 'The code says "hello" and it\'s fine',
    });
    const result = injectSessionIdIntoOutput(input, 'ses_escaped');
    const parsed = JSON.parse(result);
    expect(parsed.reviewedBy.sessionId).toBe('ses_escaped');
    expect(parsed.notes).toContain('"hello"');
  });

  it('EDGE: handles JSON array at top level', () => {
    const input = JSON.stringify([{ reviewedBy: { sessionId: 'old' } }]);
    const result = injectSessionIdIntoOutput(input, 'ses_arr');
    expect(result).toContain('"ses_arr"');
  });

  it('SMOKE: round-trip — inject then extract matches', () => {
    const input = JSON.stringify({
      overallVerdict: 'accept',
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
    overallVerdict: 'accept',
    reviewedBy: { sessionId: 'text_ses_id' },
    blockingIssues: [],
  });

  const REVIEW_FINDINGS_NO_SESSION = JSON.stringify({
    overallVerdict: 'accept',
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

  it('BAD: no host context falls to Tier 2', () => {
    const state = setupPendingReview();
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review plan' },
      REVIEW_FINDINGS_JSON,
      LATER,
    );
    const pending = state.pendingReviews.get('flowguard_plan');
    expect(pending?.subagentRecord?.sessionId).toBe('text_ses_id');
  });

  it('BAD: no host context and no text session ID yields null', () => {
    const state = setupPendingReview();
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review plan' },
      'Plain text with no JSON at all',
      LATER,
    );
    const pending = state.pendingReviews.get('flowguard_plan');
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
    expect(state.pendingReviews.size).toBe(0);
  });

  it('E2E: full cycle with metadata sessionID produces non-null session in pending', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);

    const findings = JSON.stringify({
      overallVerdict: 'accept',
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
    expect(pending!.capturedFindings!.overallVerdict).toBe('accept');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUG-21: Null-verdict tolerance and authoritative session-state recovery
// ═══════════════════════════════════════════════════════════════════════════════
//
// Explicit null for an absent optional verdict must not be mistaken for a
// verdict submission. Once a real verdict is present, unavailable authoritative
// state fails closed; there is no non-strict fallback mode.
// ═══════════════════════════════════════════════════════════════════════════════

describe('BUG-21: null-verdict tolerance (enforceBeforeVerdict)', () => {
  it('HAPPY: reviewVerdict=null is treated as Mode A → allowed immediately', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: 'my plan', reviewVerdict: null },
      { reviewAssurance: undefined },
    );
    expect(result.allowed).toBe(true);
  });

  it('HAPPY: implement reviewVerdict=null is treated as Mode A → allowed immediately', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_implement',
      { reviewVerdict: null },
      { reviewAssurance: undefined },
    );
    expect(result.allowed).toBe(true);
  });

  it('HAPPY: reviewVerdict=null is treated as Mode A → allowed', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: 'plan', reviewVerdict: null },
      { reviewAssurance: undefined },
    );
    expect(result.allowed).toBe(true);
  });

  it('BAD: reviewVerdict="" (empty string) is treated as Mode A → allowed', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: 'plan', reviewVerdict: '' },
      { reviewAssurance: undefined },
    );
    expect(result.allowed).toBe(true);
  });

  it('CORNER: reviewVerdict=undefined (key absent) is treated as Mode A', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: 'plan' },
      { reviewAssurance: undefined },
    );
    expect(result.allowed).toBe(true);
  });

  it('EDGE: reviewVerdict=0 (falsy non-string) is treated as Mode A', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: 'plan', reviewVerdict: 0 },
      { reviewAssurance: undefined },
    );
    expect(result.allowed).toBe(true);
  });

  it('EDGE: reviewVerdict=false (boolean) is treated as Mode A', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: 'plan', reviewVerdict: false },
      { reviewAssurance: undefined },
    );
    expect(result.allowed).toBe(true);
  });

  it('HAPPY: reviewVerdict="accept" enters enforcement when reviewer evidence exists', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review iteration=0 planVersion=1' },
      JSON.stringify({ overallVerdict: 'accept', blockingIssues: [] }),
      LATER,
    );

    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { reviewVerdict: 'accept' },
      {
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v6' as const,
          obligations: [],
          invocations: [],
          attempts: [],
          dispatches: [],
        },
      },
    );
    expect(result.allowed).toBe(true);
  });

  it('BAD: reviewVerdict="accept" but no subagent called → blocked', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);

    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { reviewVerdict: 'accept' },
      {
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v6' as const,
          obligations: [],
          invocations: [],
          attempts: [],
          dispatches: [],
        },
      },
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('SUBAGENT_REVIEW_NOT_INVOKED');
  });

  it('HAPPY: sessionState readable, reviewAssurance=undefined → allowed', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { reviewVerdict: 'accept' },
      { reviewAssurance: undefined },
    );
    expect(result.allowed).toBe(true);
  });

  it('HAPPY: sessionState readable, reviewAssurance=null → allowed', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { reviewVerdict: 'accept' },
      { reviewAssurance: null },
    );
    expect(result.allowed).toBe(true);
  });

  it('HAPPY: sessionState readable, obligations=[] → allowed', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { reviewVerdict: 'accept' },
      {
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v6' as const,
          obligations: [],
          invocations: [],
          attempts: [],
          dispatches: [],
        },
      },
    );
    expect(result.allowed).toBe(true);
  });

  it('BAD: sessionState=null → REVIEW_ASSURANCE_STATE_UNAVAILABLE', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(state, 'flowguard_plan', { reviewVerdict: 'accept' }, null);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('REVIEW_ASSURANCE_STATE_UNAVAILABLE');
  });

  it('CORNER: sessionState=undefined → BLOCKED', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { reviewVerdict: 'accept' },
      undefined,
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('REVIEW_ASSURANCE_STATE_UNAVAILABLE');
  });

  it('EDGE: sessionState readable, pending obligation → SUBAGENT_REVIEW_NOT_INVOKED', () => {
    const state = createSessionState();
    const sessionState = {
      reviewAssurance: {
        assuranceSchemaVersion: 'review-assurance.v6' as const,
        obligations: [
          {
            obligationId: '00000000-0000-4000-8000-bug21pending01',
            obligationType: 'plan' as const,
            requiredChallengeCount: 0,
            requiredChallengeKind: 'design_challenge' as const,
            challengePolicyVersion: 'challenge-policy.v1' as const,
            subjectDigest: 'test-subject-digest',
            iteration: 0,
            planVersion: 1,
            criteriaVersion: 'v1',
            mandateDigest: 'digest',
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
      expect(result.reason).toContain('bug21pending01');
    }
  });

  it('EDGE: sessionState readable, obligation for DIFFERENT tool → allowed', () => {
    const state = createSessionState();
    const sessionState = {
      reviewAssurance: {
        assuranceSchemaVersion: 'review-assurance.v6' as const,
        obligations: [
          {
            obligationId: '00000000-0000-4000-8000-bug21impl0001',
            obligationType: 'implement' as const,
            requiredChallengeCount: 0,
            requiredChallengeKind: 'implementation_challenge' as const,
            challengePolicyVersion: 'challenge-policy.v1' as const,
            subjectDigest: 'test-subject-digest',
            iteration: 0,
            planVersion: 1,
            criteriaVersion: 'v1',
            mandateDigest: 'digest',
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
    expect(result.allowed).toBe(true);
  });

  it('E2E SMOKE: explicit null verdict after /ticket is treated as Mode A', () => {
    const state = createSessionState();
    const sessionState = { reviewAssurance: undefined };
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: 'My detailed plan', reviewVerdict: null, reviewFindings: null },
      sessionState,
    );
    expect(result.allowed).toBe(true);
  });

  it('E2E SMOKE: mixed initial approval payload remains a tool-normalization concern', () => {
    const state = createSessionState();
    const sessionState = { reviewAssurance: undefined };
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: 'My plan', reviewVerdict: 'accept', reviewFindings: {} },
      sessionState,
    );
    expect(result.allowed).toBe(true);
  });

  it('E2E SMOKE: preemptive reviewerUnavailable on initial /plan is allowed for tool normalization', () => {
    const state = createSessionState();
    const sessionState = { reviewAssurance: undefined };
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: 'My plan', reviewerUnavailable: true },
      sessionState,
    );
    expect(result.allowed).toBe(true);
  });

  it('E2E SMOKE: mid-loop mixed approval payload passes enforcement after reviewer evidence so plan tool can hardblock it', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review iteration=0 planVersion=1' },
      taskResultWithFindings('ses_review', { verdict: 'approve' }),
      LATER,
    );

    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: '## Revised Plan', reviewVerdict: 'accept' },
      {
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v6' as const,
          obligations: [],
          invocations: [],
          attempts: [],
          dispatches: [],
        },
      },
    );
    expect(result.allowed).toBe(true);
  });

  it('E2E SMOKE: mid-loop planText plus reviewFindings remains a tool-layer shape concern', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: '## Revised Plan', reviewFindings: {} },
      {
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v6' as const,
          obligations: [],
          invocations: [],
          attempts: [],
          dispatches: [],
        },
      },
    );
    expect(result.allowed).toBe(true);
  });

  it('E2E SMOKE: mid-loop planText plus reviewerUnavailable remains a tool-layer shape concern', () => {
    const state = createSessionState();
    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { planText: '## Revised Plan', reviewerUnavailable: true },
      {
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v6' as const,
          obligations: [],
          invocations: [],
          attempts: [],
          dispatches: [],
        },
      },
    );
    expect(result.allowed).toBe(true);
  });

  it('E2E: verdict after reviewer completes with null reviewFindings → enforcement passes', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review iteration=0 planVersion=1' },
      JSON.stringify({ overallVerdict: 'accept', blockingIssues: [] }),
      LATER,
    );

    const result = enforceBeforeVerdict(
      state,
      'flowguard_plan',
      { reviewVerdict: 'accept', reviewFindings: null },
      {
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v6' as const,
          obligations: [],
          invocations: [],
          attempts: [],
          dispatches: [],
        },
      },
    );
    expect(result.allowed).toBe(true);
  });
});

describe('BUG-21: null-verdict tolerance (onFlowGuardToolAfter)', () => {
  it('HAPPY: Mode A output with null verdict key → pendingReview created (not cleared)', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      { planText: 'plan', reviewVerdict: null },
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
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);
    expect(state.pendingReviews.has('flowguard_plan')).toBe(true);

    const modeBOutput = JSON.stringify({
      phase: 'PLAN_REVIEW',
      status: 'Verdict recorded.',
      next: 'Proceed to implementation.',
    });
    onFlowGuardToolAfter(state, 'flowguard_plan', { reviewVerdict: 'accept' }, modeBOutput, LATER);
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
    onFlowGuardToolAfter(state, 'flowguard_plan', { reviewVerdict: 'accept' }, errorOutput, LATER);
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

  it('EDGE: reviewVerdict="" (empty string) → not treated as verdict → no clear', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeASubagentResponse(), NOW);

    const successOutput = JSON.stringify({ phase: 'PLAN_REVIEW', status: 'ok' });
    onFlowGuardToolAfter(state, 'flowguard_plan', { reviewVerdict: '' }, successOutput, NOW);
    expect(state.pendingReviews.has('flowguard_plan')).toBe(true);
  });

  it('E2E SMOKE: full cycle — Mode A (null verdict) → Task → Mode B (real verdict) → cleared', () => {
    const state = createSessionState();

    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      { planText: 'plan', reviewVerdict: null, reviewFindings: null },
      modeASubagentResponse(),
      NOW,
    );
    expect(state.pendingReviews.has('flowguard_plan')).toBe(true);
    expect(state.pendingReviews.get('flowguard_plan')!.subagentCalled).toBe(false);

    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: 'Review iteration=0 planVersion=1' },
      JSON.stringify({ overallVerdict: 'accept', blockingIssues: [] }),
      LATER,
    );
    expect(state.pendingReviews.get('flowguard_plan')!.subagentCalled).toBe(true);

    const modeBOutput = JSON.stringify({ phase: 'PLAN_REVIEW', status: 'approved' });
    onFlowGuardToolAfter(state, 'flowguard_plan', { reviewVerdict: 'accept' }, modeBOutput, LATER);
    expect(state.pendingReviews.has('flowguard_plan')).toBe(false);
  });
});
