import { describe, expect, it, beforeEach } from 'vitest';

import {
  clearUserDecisionIntents,
  consumeImplementationReviewExtensionIntent,
  consumeUserDecisionIntent,
  parseUserDecisionCommand,
  peekUserDecisionIntent,
  recordUserDecisionIntent,
  recordUserDecisionIntentFromCommand,
} from './user-decision-intent.js';

describe('UserDecisionIntent', () => {
  beforeEach(() => clearUserDecisionIntents());

  it('parses explicit user decision slash commands', () => {
    expect(parseUserDecisionCommand({ command: '/approve', arguments: '' })).toEqual({
      command: '/approve',
      expectedVerdict: 'approve',
    });
    expect(parseUserDecisionCommand({ command: 'request-changes', arguments: '' })).toEqual({
      command: '/request-changes',
      expectedVerdict: 'changes_requested',
    });
    expect(parseUserDecisionCommand({ command: '/reject', arguments: '' })).toEqual({
      command: '/reject',
      expectedVerdict: 'reject',
    });
    expect(
      parseUserDecisionCommand({ command: '/review-decision', arguments: 'approve looks good' }),
    ).toEqual({ command: '/review-decision', expectedVerdict: 'approve' });
  });

  it('does not create intent for ambiguous review-decision arguments', () => {
    expect(parseUserDecisionCommand({ command: '/review-decision', arguments: '' })).toBeNull();
    expect(
      parseUserDecisionCommand({ command: '/review-decision', arguments: 'maybe' }),
    ).toBeNull();
    expect(
      recordUserDecisionIntentFromCommand({
        sessionId: 's1',
        command: '/review-decision',
        arguments: '',
      }),
    ).toBeNull();
  });

  it('binds an implementation review extension to the explicit user command iteration count', () => {
    expect(
      recordUserDecisionIntentFromCommand({
        sessionId: 's1',
        command: '/extend-implementation-review',
        arguments: '2',
        nowMs: 1_000,
      }),
    ).toMatchObject({ command: '/extend-implementation-review', additionalIterations: 2 });
    expect(
      consumeImplementationReviewExtensionIntent({
        sessionId: 's1',
        additionalIterations: 1,
        nowMs: 2_000,
      }),
    ).toEqual({ ok: false, reason: 'verdict_mismatch' });
    expect(
      recordUserDecisionIntentFromCommand({
        sessionId: 's1',
        command: '/extend-implementation-review',
        arguments: '2',
        nowMs: 3_000,
      }),
    ).not.toBeNull();
    expect(
      consumeImplementationReviewExtensionIntent({
        sessionId: 's1',
        additionalIterations: 2,
        nowMs: 4_000,
      }),
    ).toMatchObject({ ok: true });
  });

  it('consumes a matching intent exactly once', () => {
    recordUserDecisionIntent({
      sessionId: 's1',
      command: '/approve',
      expectedVerdict: 'approve',
      nowMs: 1_000,
      ttlMs: 30_000,
    });

    expect(
      consumeUserDecisionIntent({ sessionId: 's1', verdict: 'approve', nowMs: 2_000 }),
    ).toMatchObject({
      ok: true,
    });
    expect(
      consumeUserDecisionIntent({ sessionId: 's1', verdict: 'approve', nowMs: 3_000 }),
    ).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('blocks expired or mismatched intents and deletes them', () => {
    recordUserDecisionIntent({
      sessionId: 's1',
      command: '/approve',
      expectedVerdict: 'approve',
      nowMs: 1_000,
      ttlMs: 10,
    });
    expect(
      consumeUserDecisionIntent({ sessionId: 's1', verdict: 'approve', nowMs: 2_000 }),
    ).toEqual({
      ok: false,
      reason: 'expired',
    });

    recordUserDecisionIntent({
      sessionId: 's1',
      command: '/approve',
      expectedVerdict: 'approve',
      nowMs: 3_000,
      ttlMs: 30_000,
    });
    expect(
      consumeUserDecisionIntent({ sessionId: 's1', verdict: 'changes_requested', nowMs: 4_000 }),
    ).toEqual({ ok: false, reason: 'verdict_mismatch' });
    expect(
      consumeUserDecisionIntent({ sessionId: 's1', verdict: 'approve', nowMs: 5_000 }),
    ).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  describe('peekUserDecisionIntent', () => {
    it('does NOT consume a valid intent (survives repeated peeks for retry)', () => {
      recordUserDecisionIntent({
        sessionId: 's1',
        command: '/approve',
        expectedVerdict: 'approve',
        nowMs: 1_000,
        ttlMs: 30_000,
      });

      // First peek observes a valid intent...
      expect(
        peekUserDecisionIntent({ sessionId: 's1', verdict: 'approve', nowMs: 2_000 }),
      ).toMatchObject({
        ok: true,
      });
      // ...and a second peek still finds it (not burned by the first).
      expect(
        peekUserDecisionIntent({ sessionId: 's1', verdict: 'approve', nowMs: 2_500 }),
      ).toMatchObject({
        ok: true,
      });
      // The real consume then burns it exactly once.
      expect(
        consumeUserDecisionIntent({ sessionId: 's1', verdict: 'approve', nowMs: 3_000 }),
      ).toMatchObject({
        ok: true,
      });
      expect(
        consumeUserDecisionIntent({ sessionId: 's1', verdict: 'approve', nowMs: 3_500 }),
      ).toEqual({
        ok: false,
        reason: 'missing',
      });
    });

    it('deletes an expired intent (anti-replay preserved)', () => {
      recordUserDecisionIntent({
        sessionId: 's1',
        command: '/approve',
        expectedVerdict: 'approve',
        nowMs: 1_000,
        ttlMs: 10,
      });
      expect(peekUserDecisionIntent({ sessionId: 's1', verdict: 'approve', nowMs: 2_000 })).toEqual(
        {
          ok: false,
          reason: 'expired',
        },
      );
      // Deleted — a subsequent peek reports missing, never a stale approval.
      expect(peekUserDecisionIntent({ sessionId: 's1', verdict: 'approve', nowMs: 2_100 })).toEqual(
        {
          ok: false,
          reason: 'missing',
        },
      );
    });

    it('deletes a mismatched intent (anti-replay preserved)', () => {
      recordUserDecisionIntent({
        sessionId: 's1',
        command: '/approve',
        expectedVerdict: 'approve',
        nowMs: 1_000,
        ttlMs: 30_000,
      });
      expect(
        peekUserDecisionIntent({ sessionId: 's1', verdict: 'changes_requested', nowMs: 2_000 }),
      ).toEqual({ ok: false, reason: 'verdict_mismatch' });
      // Deleted — the original approve intent cannot be reused after a mismatch.
      expect(peekUserDecisionIntent({ sessionId: 's1', verdict: 'approve', nowMs: 2_100 })).toEqual(
        {
          ok: false,
          reason: 'missing',
        },
      );
    });

    it('reports missing without error when no intent exists', () => {
      expect(
        peekUserDecisionIntent({ sessionId: 'none', verdict: 'approve', nowMs: 1_000 }),
      ).toEqual({
        ok: false,
        reason: 'missing',
      });
    });
  });
});
