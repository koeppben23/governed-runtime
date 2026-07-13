/**
 * @module integration/tools/hydrate-format.test
 * @description Tests for hydrate-format input builders.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, it, expect } from 'vitest';
import {
  buildExistingPolicyInput,
  buildNewPolicyInput,
  buildPolicyInput,
} from './hydrate-format.js';
import type { HydratePolicyResolution } from './hydrate.js';
import type { PolicyMode } from '../../state/policy-mode.js';
import { DEFAULT_CONFIG } from '../../config/flowguard-config.js';

// ─── Minimal Fixtures ─────────────────────────────────────────────────────────

const EXISTING = {
  policySnapshot: {
    mode: 'team' as PolicyMode,
    requestedMode: 'team' as PolicyMode,
    source: 'default' as const,
    effectiveGateBehavior: 'auto_approve' as const,
  },
};

function policyResolution(overrides = {}): HydratePolicyResolution {
  return {
    ...DEFAULT_CONFIG,
    effectiveMode: 'team' as PolicyMode,
    requestedMode: 'team' as PolicyMode,
    effectiveSource: 'default' as const,
    effectiveGateBehavior: 'human_gated',
    degradedReason: undefined,
    resolutionReason: undefined,
    centralEvidence: undefined,
    ...overrides,
  } as unknown as HydratePolicyResolution;
}

function hydrateConfig(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
  };
}

// ─── buildExistingPolicyInput ─────────────────────────────────────────────────

describe('buildExistingPolicyInput', () => {
  it('assembles from existing state without central evidence', () => {
    const result = buildExistingPolicyInput(
      EXISTING as Parameters<typeof buildExistingPolicyInput>[0],
      undefined,
    );
    expect(result.policyMode).toBe('team');
    expect(result.policySource).toBe('default');
    expect(result.effectiveGateBehavior).toBe('auto_approve');
  });
});

// ─── buildNewPolicyInput ──────────────────────────────────────────────────────

describe('buildNewPolicyInput', () => {
  it('maps policy resolution to hydrate policy input', () => {
    const res = policyResolution();
    const result = buildNewPolicyInput(
      res,
      hydrateConfig() as Parameters<typeof buildNewPolicyInput>[1],
    );
    expect(result.policyMode).toBe('team');
    expect(result.policySource).toBe('default');
    expect(result.effectiveGateBehavior).toBe('human_gated');
  });
});

// ─── buildPolicyInput ─────────────────────────────────────────────────────────

describe('buildPolicyInput', () => {
  it('delegates to buildExistingPolicyInput when existing state is present', () => {
    const result = buildPolicyInput(
      EXISTING as Parameters<typeof buildPolicyInput>[0],
      policyResolution(),
      hydrateConfig() as Parameters<typeof buildPolicyInput>[2],
      undefined,
    );
    expect(result.policyMode).toBe('team');
    expect(result.policySource).toBe('default');
  });
});
