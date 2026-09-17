/**
 * @module config/policy-snapshot.test
 * @description Tests for policy snapshot build and resolve functions:
 *   - createPolicySnapshot (full snapshot from policy)
 *   - freezePolicySnapshot (PolicyResolution → Snapshot with all metadata)
 *   - resolvePolicyFromSnapshot (snapshot → FlowGuardPolicy)
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createPolicySnapshot,
  freezePolicySnapshot,
  resolvePolicyFromSnapshot,
} from './policy-snapshot.js';
import {
  SOLO_POLICY,
  REGULATED_POLICY,
  type PolicyResolution,
  type PolicyDegradedReason,
  type HydratePolicyResolution,
} from './policy.js';
import type { PolicySnapshot } from '../state/evidence.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { POLICY_DIGEST_VERSION } from '../shared/policy-digest.js';
import { PolicyConfigurationError } from './policy-errors.js';
import type { FlowGuardPolicy } from './policy-types.js';

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf-8').digest('hex');
export const NOW = '2026-04-27T10:00:00.000Z';

export function soloResolution(overrides?: Partial<PolicyResolution>): PolicyResolution {
  return {
    requestedMode: 'solo',
    effectiveMode: 'solo',
    effectiveGateBehavior: 'auto_approve',
    policy: SOLO_POLICY,
    ...overrides,
  };
}

export function regulatedHydrateResolution(): HydratePolicyResolution {
  return {
    requestedMode: 'regulated',
    requestedSource: 'explicit',
    effectiveMode: 'regulated',
    effectiveSource: 'explicit',
    effectiveGateBehavior: 'human_gated',
    policy: REGULATED_POLICY,
    resolutionReason: 'default_weaker_than_central',
    centralEvidence: {
      minimumMode: 'team',
      digest: sha256('central-policy-bundle'),
      version: '2.1.0',
      pathHint: 'releases/policy-v2.1.json',
    },
  };
}

// ─── createPolicySnapshot ──────────────────────────────────────────────────────

describe('createPolicySnapshot', () => {
  it('creates a PolicySnapshot from SoloPolicy', () => {
    const snapshot = createPolicySnapshot(SOLO_POLICY, NOW, sha256);
    expect(snapshot.mode).toBe('solo');
    expect(snapshot.hash).toBe(sha256(canonicalJsonStringify(SOLO_POLICY)));
    expect(snapshot.hashVersion).toBe(POLICY_DIGEST_VERSION);
    expect(snapshot.resolvedAt).toBe(NOW);
    expect(snapshot.requireHumanGates).toBe(SOLO_POLICY.requireHumanGates);
    expect(snapshot.reviewBudget).toEqual(SOLO_POLICY.reviewBudget);
    expect(snapshot.maxIncoherentReviewerCaptureRetries).toBe(
      SOLO_POLICY.maxIncoherentReviewerCaptureRetries,
    );
    expect(snapshot.allowSelfApproval).toBe(SOLO_POLICY.allowSelfApproval);
    expect(snapshot.identityProviderMode).toBe(SOLO_POLICY.identityProviderMode);
    expect(snapshot.effectiveGateBehavior).toBe('auto_approve');
  });

  it.each(['', 'abc', 'UNKNOWN_LEGACY', 'A'.repeat(64)])(
    'rejects an invalid v2 policy digest %p',
    (invalidDigest) => {
      expect(() => createPolicySnapshot(SOLO_POLICY, NOW, () => invalidDigest)).toThrow(
        PolicyConfigurationError,
      );
    },
  );

  it('includes resolution metadata in the snapshot', () => {
    const snapshot = createPolicySnapshot(SOLO_POLICY, NOW, sha256, {
      requestedMode: 'solo',
      effectiveGateBehavior: 'human_gated',
      source: 'explicit',
      resolutionReason: 'default_weaker_than_central',
      centralMinimumMode: 'team',
      policyDigest: sha256('central'),
      policyVersion: '1.0.0',
      policyPathHint: '~/.flowguard/policy.json',
    });
    expect(snapshot.source).toBe('explicit');
    expect(snapshot.resolutionReason).toBe('default_weaker_than_central');
    expect(snapshot.centralMinimumMode).toBe('team');
    expect(snapshot.policyDigest).toBe(sha256('central'));
    expect(snapshot.policyVersion).toBe('1.0.0');
    expect(snapshot.policyPathHint).toBe('~/.flowguard/policy.json');
  });

  it('builds audit section from policy audit config', () => {
    const snapshot = createPolicySnapshot(SOLO_POLICY, NOW, sha256);
    expect(snapshot.audit.emitTransitions).toBe(SOLO_POLICY.audit.emitTransitions);
    expect(snapshot.audit.emitToolCalls).toBe(SOLO_POLICY.audit.emitToolCalls);
    expect(snapshot.audit.enableChainHash).toBe(SOLO_POLICY.audit.enableChainHash);
    expect(snapshot.audit.timestampAssurance.enabled).toBe(
      SOLO_POLICY.audit.timestampAssurance.enabled,
    );
  });

  it('preserves configured optional timestamp-assurance fields', () => {
    const policy = {
      ...SOLO_POLICY,
      audit: {
        ...SOLO_POLICY.audit,
        timestampAssurance: {
          ...SOLO_POLICY.audit.timestampAssurance,
          tsaUrl: 'https://tsa.example.test',
          trustAnchors: ['anchor-a'],
          ntpServers: ['ntp.example.test'],
        },
      },
    };

    expect(createPolicySnapshot(policy, NOW, sha256).audit.timestampAssurance).toMatchObject({
      tsaUrl: 'https://tsa.example.test',
      trustAnchors: ['anchor-a'],
      ntpServers: ['ntp.example.test'],
    });
  });

  it('preserves an explicit resolution instead of policy defaults', () => {
    const snapshot = createPolicySnapshot(SOLO_POLICY, NOW, sha256, {
      requestedMode: 'team',
      effectiveGateBehavior: 'human_gated',
    });

    expect(snapshot.requestedMode).toBe('team');
    expect(snapshot.effectiveGateBehavior).toBe('human_gated');
  });

  it('binds governance fields into the policy digest', () => {
    const baseline = createPolicySnapshot(SOLO_POLICY, NOW, sha256).hash;
    const variants: readonly FlowGuardPolicy[] = [
      {
        ...SOLO_POLICY,
        audit: { ...SOLO_POLICY.audit, enableChainHash: !SOLO_POLICY.audit.enableChainHash },
      },
      {
        ...SOLO_POLICY,
        audit: { ...SOLO_POLICY.audit, emitToolCalls: !SOLO_POLICY.audit.emitToolCalls },
      },
      {
        ...SOLO_POLICY,
        validationEvidence: {
          ...SOLO_POLICY.validationEvidence,
          allowNoCommands: !SOLO_POLICY.validationEvidence.allowNoCommands,
        },
      },
      {
        ...SOLO_POLICY,
        minimumActorAssuranceForApproval: 'claim_validated' as const,
      },
      {
        ...SOLO_POLICY,
        reviewProfile: 'full' as const,
      },
      {
        ...SOLO_POLICY,
        challengePolicy: {
          ...SOLO_POLICY.challengePolicy,
          counts: { ...SOLO_POLICY.challengePolicy.counts, STANDARD: 2 },
        } as unknown as FlowGuardPolicy['challengePolicy'],
      },
    ];

    for (const policy of variants) {
      expect(createPolicySnapshot(policy, NOW, sha256).hash).not.toBe(baseline);
    }
  });
});

// ─── freezePolicySnapshot ──────────────────────────────────────────────────────

describe('freezePolicySnapshot', () => {
  describe('HAPPY', () => {
    it('freezes a PolicyResolution into a snapshot', () => {
      const resolution = soloResolution();
      const snapshot = freezePolicySnapshot(resolution, NOW, sha256);
      expect(snapshot.mode).toBe('solo');
      expect(snapshot.source).not.toBeDefined();
    });

    it('freezes a HydratePolicyResolution preserving central metadata', () => {
      const resolution = regulatedHydrateResolution();
      const snapshot = freezePolicySnapshot(resolution, NOW, sha256);
      expect(snapshot.mode).toBe('regulated');
      expect(snapshot.source).toBe('explicit');
      expect(snapshot.resolutionReason).toBe('default_weaker_than_central');
      expect(snapshot.centralMinimumMode).toBe('team');
      expect(snapshot.policyDigest).toBe(sha256('central-policy-bundle'));
      expect(snapshot.policyVersion).toBe('2.1.0');
    });
  });

  describe('CORNER', () => {
    it('freezes a resolution with degraded reason', () => {
      const degraded: PolicyDegradedReason = 'ci_context_missing';
      const snapshot = freezePolicySnapshot(
        { ...soloResolution(), degradedReason: degraded },
        NOW,
        sha256,
      );
      expect(snapshot.degradedReason).toBe('ci_context_missing');
    });
  });
});

// ─── resolvePolicyFromSnapshot ─────────────────────────────────────────────────

describe('resolvePolicyFromSnapshot', () => {
  describe('HAPPY — round-trip', () => {
    it('round-trips SoloPolicy through snapshot', () => {
      const snapshot = createPolicySnapshot(SOLO_POLICY, NOW, sha256);
      const reconstructed = resolvePolicyFromSnapshot(snapshot);
      expect(reconstructed.mode).toBe('solo');
      expect(reconstructed.requireHumanGates).toBe(SOLO_POLICY.requireHumanGates);
    });

    it('round-trips RegulatedPolicy through snapshot', () => {
      const snapshot = createPolicySnapshot(REGULATED_POLICY, NOW, sha256);
      const reconstructed = resolvePolicyFromSnapshot(snapshot);
      expect(reconstructed.mode).toBe('regulated');
      expect(reconstructed.requireHumanGates).toBe(true);
      expect(reconstructed.reviewProfile).toBe('core');
    });

    it('round-trips the mandatory core reviewProfile (Wave 1 — #730)', () => {
      const snapshot = createPolicySnapshot(SOLO_POLICY, NOW, sha256);
      expect(snapshot.reviewProfile).toBe('core');
      expect(resolvePolicyFromSnapshot(snapshot).reviewProfile).toBe('core');
    });

    it('round-trips the versioned challenge policy', () => {
      const snapshot = createPolicySnapshot(SOLO_POLICY, NOW, sha256);
      expect(snapshot.challengePolicy).toEqual(SOLO_POLICY.challengePolicy);
      expect(resolvePolicyFromSnapshot(snapshot).challengePolicy).toEqual(
        SOLO_POLICY.challengePolicy,
      );
    });

    it('preserves an explicit discoveryHealth onDegraded=allow through the runtime rebuild', () => {
      const policy = {
        ...REGULATED_POLICY,
        discoveryHealth: {
          ...REGULATED_POLICY.discoveryHealth,
          onDegraded: 'allow' as const,
        },
      };
      const snapshot = createPolicySnapshot(policy, NOW, sha256);
      expect(snapshot.discoveryHealth.onDegraded).toBe('allow');
      expect(resolvePolicyFromSnapshot(snapshot).discoveryHealth).toEqual({
        ...REGULATED_POLICY.discoveryHealth,
        onDegraded: 'allow',
      });
    });

    it('preserves an explicit discoveryHealth onDrift=allow through the runtime rebuild', () => {
      const policy = {
        ...REGULATED_POLICY,
        discoveryHealth: {
          ...REGULATED_POLICY.discoveryHealth,
          onDrift: 'allow' as const,
        },
      };
      const snapshot = createPolicySnapshot(policy, NOW, sha256);
      expect(snapshot.discoveryHealth.onDrift).toBe('allow');
      expect(resolvePolicyFromSnapshot(snapshot).discoveryHealth).toEqual({
        ...REGULATED_POLICY.discoveryHealth,
        onDrift: 'allow',
      });
    });
  });
});
