/** Copy-only regression: canonical reasons must not offer authority recreation. */
import { describe, expect, it } from 'vitest';
import { defaultReasonRegistry } from './reasons.js';

describe('activation and authority recovery guidance', () => {
  it('defers fresh-session preparation to the host contract without imposing native activation on MCP', () => {
    const reason = defaultReasonRegistry.get('NO_SESSION');
    expect(reason?.messageTemplate).toContain('documented session-start procedure');
    expect(reason?.recoverySteps.join(' ')).toContain(
      'may call flowguard_hydrate to prepare workflow state where supported',
    );
    expect(reason?.recoverySteps.join(' ')).toContain('do not recreate it');
    expect(JSON.stringify(reason)).not.toMatch(
      /Explicit activation is required|hydrate cannot activate|StartGovernance|host Start operation/,
    );
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

  it('keeps terminal workflows terminal and requires the documented host start for new work', () => {
    const reason = defaultReasonRegistry.get('ABORTED');
    expect(reason?.recoverySteps.join(' ')).toContain('different host-session id');
    expect(reason?.recoverySteps.join(' ')).toContain('documented host session-start procedure');
    expect(reason?.recoverySteps.join(' ')).toContain('does not restart the old terminal workflow');
  });

  it('CONFIG_INVALID requires targeted manual repair, never deleting the entire configuration', () => {
    const reason = defaultReasonRegistry.get('CONFIG_INVALID');
    expect(reason).toBeDefined();
    const recovery = reason?.recoverySteps.join(' ');
    expect(recovery).toContain('Back up');
    expect(recovery).toContain('preserve unrelated supported settings');
    expect(recovery).toContain('Manually correct the reported invalid fields');
    expect(recovery).toContain(
      'docs/configuration.md#breaking-change-manual-configuration-recovery',
    );
    expect(recovery).toContain('install --force does not migrate unsupported keys');
    expect(recovery).toContain('Do not delete the configuration');
    expect(recovery).not.toMatch(/remove flowguard\.json|create defaults/);
    expect(reason?.quickFixCommand).toBeUndefined();
  });

  it.each([
    'NO_SESSION',
    'EXPLICIT_WEAKER_THAN_CENTRAL',
    'SESSION_OVERRIDE_UNRESOLVABLE',
    'WORKTREE_MISMATCH',
    'ABORTED',
    'MUTATION_EPISODE_CONTROL_PLANE_MUTATED',
    'INVALID_POLICY_MODE',
    'HYDRATE_DISCOVERY_CONTRACT_FAILED',
    'VALIDATION_EVIDENCE_REQUIRED',
    'INVALID_POLICY_DIGEST_VERSION',
  ])('%s does not impose the native activation protocol on all hosts', (code) => {
    const reason = defaultReasonRegistry.get(code);
    expect(reason).toBeDefined();
    expect(JSON.stringify(reason)).not.toMatch(
      /explicit host Start|through host Start|authorized Start|StartGovernance|Explicit activation is required|hydrate cannot activate/,
    );
  });

  it('does not retain the removed non-emitted iteration reason as a compatibility registry entry', () => {
    expect(defaultReasonRegistry.get('MAX_REVIEW_ITERATIONS_REACHED')).toBeUndefined();
  });
});
