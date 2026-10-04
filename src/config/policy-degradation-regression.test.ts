import { describe, expect, it } from 'vitest';
import { TEAM_POLICY } from './policy-presets.js';
import { resolvePolicyWithContext } from './policy-resolver.js';

describe('team-ci degradation regression', () => {
  it('uses canonical team policy outside CI while preserving requested-mode provenance', () => {
    const result = resolvePolicyWithContext('team-ci', false);

    expect(result.requestedMode).toBe('team-ci');
    expect(result.effectiveMode).toBe('team');
    expect(result.degradedReason).toBe('ci_context_missing');
    expect(result.effectiveGateBehavior).toBe('human_gated');
    expect(result.policy).toBe(TEAM_POLICY);
    expect(result.policy.mode).toBe('team');
  });
});
