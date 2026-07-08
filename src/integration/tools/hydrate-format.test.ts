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
    idp: null,
    trustAnchors: [],
    tsaUrl: '',
    profile: { defaultId: '', activeChecks: [] },
    policy: {
      maxSelfReviewIterations: 3,
      maxImplReviewIterations: 5,
      requireVerifiedActorsForApproval: false,
      identityProvider: null,
      identityProviderMode: 'optional' as const,
      minimumActorAssuranceForApproval: null,
      enforceRiskClassification: false,
      allowRiskDowngradeOverride: false,
      allowReducedCeremony: false,
    },
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
