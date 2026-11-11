/** Copy-only regression: canonical reasons must not offer authority recreation. */
import { describe, expect, it } from 'vitest';
import { defaultReasonRegistry } from './reasons.js';

describe('activation and authority recovery guidance', () => {
  it('distinguishes verified inactivity from missing bound authority without an unconditional quick fix', () => {
    const reason = defaultReasonRegistry.get('NO_SESSION');
    expect(reason?.recoverySteps.join(' ')).toContain('verifiably inactive');
    expect(reason?.recoverySteps.join(' ')).toContain(
      'host Start operation or an authorized StartGovernance',
    );
    expect(reason?.recoverySteps.join(' ')).toContain('do not recreate it');
    expect(reason?.quickFixCommand).toBeUndefined();
  });

  it.each([
    'SESSION_DIR_NOT_FOUND',
    'SESSION_AUTHORITY_UNAVAILABLE',
    'AUDIT_SESSION_AUTHORITY_UNAVAILABLE',
    'STATE_MISSING',
    'STATE_UNREADABLE',
    'POLICY_SNAPSHOT_MISSING',
    'REVIEW_ASSURANCE_STATE_UNAVAILABLE',
  ])('%s preserves the block instead of offering hydrate/bootstrap repair', (code) => {
    const reason = defaultReasonRegistry.get(code);
    expect(reason).toBeDefined();
    expect(reason?.recoverySteps.join(' ')).toMatch(/restore|Restore|blocked/);
    expect(reason?.quickFixCommand).not.toBe('/hydrate');
    expect(JSON.stringify(reason)).not.toMatch(
      /Run \/hydrate to (?:bootstrap|initialize|recreate)|Re-hydrate the session with/,
    );
  });

  it('keeps terminal workflows terminal and demands separate activation for new work', () => {
    const reason = defaultReasonRegistry.get('ABORTED');
    expect(reason?.recoverySteps.join(' ')).toContain('different host-session id');
    expect(reason?.recoverySteps.join(' ')).toContain('through host Start');
    expect(reason?.recoverySteps.join(' ')).toContain('do not restart the old ACTIVE binding');
  });

  it('does not retain the removed non-emitted iteration reason as a compatibility registry entry', () => {
    expect(defaultReasonRegistry.get('MAX_REVIEW_ITERATIONS_REACHED')).toBeUndefined();
  });
});
