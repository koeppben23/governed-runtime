import { describe, expect, it, beforeEach } from 'vitest';

import {
  clearUserDecisionIntents,
  consumeUserDecisionIntent,
  parseUserDecisionCommand,
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
});
