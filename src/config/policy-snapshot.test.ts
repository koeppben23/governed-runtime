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
import {
  normalizeSelfReviewConfig,
  modeConsistentDefaults,
  normalizeDiscoveryHealthField,
  normalizeValidationEvidenceField,
} from './policy-snapshot-normalize.js';

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
    expect(snapshot.hash).toBe(
      sha256(JSON.stringify(SOLO_POLICY, Object.keys(SOLO_POLICY).sort())),
    );
    expect(snapshot.resolvedAt).toBe(NOW);
    expect(snapshot.requireHumanGates).toBe(SOLO_POLICY.requireHumanGates);
    expect(snapshot.maxSelfReviewIterations).toBe(SOLO_POLICY.maxSelfReviewIterations);
    expect(snapshot.maxImplReviewIterations).toBe(SOLO_POLICY.maxImplReviewIterations);
    expect(snapshot.maxIncoherentReviewerCaptureRetries).toBe(
      SOLO_POLICY.maxIncoherentReviewerCaptureRetries,
    );
    expect(snapshot.allowSelfApproval).toBe(SOLO_POLICY.allowSelfApproval);
    expect(snapshot.requireVerifiedActorsForApproval).toBe(
      SOLO_POLICY.requireVerifiedActorsForApproval,
    );
    expect(snapshot.identityProviderMode).toBe(SOLO_POLICY.identityProviderMode);
    expect(snapshot.reviewOutputPolicy).toBe(SOLO_POLICY.reviewOutputPolicy);
    expect(snapshot.reviewInvocationPolicy).toBe(SOLO_POLICY.reviewInvocationPolicy);
    expect(snapshot.effectiveGateBehavior).toBe('auto_approve');
  });

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
      expect(reconstructed.reviewOutputPolicy).toBe('structured_required');
    });

    it('round-trips the mandatory core reviewProfile (Wave 1 — #730)', () => {
      const snapshot = createPolicySnapshot(SOLO_POLICY, NOW, sha256);
      expect(snapshot.reviewProfile).toBe('core');
      expect(resolvePolicyFromSnapshot(snapshot).reviewProfile).toBe('core');
    });
  });

  describe('LEGACY — missing fields', () => {
    it('reconstructs policy with safe defaults for legacy fields', () => {
      const snapshot = createPolicySnapshot(SOLO_POLICY, NOW, sha256);
      const reconstructed = resolvePolicyFromSnapshot({
        ...snapshot,
        identityProviderMode: undefined as unknown as 'optional' | 'required',
      });
      expect(reconstructed.identityProviderMode).toBe('optional');
    });

    it('legacy snapshot without reviewProfile resolves fail-closed to core (Wave 1 — #730)', () => {
      const snapshot = createPolicySnapshot(REGULATED_POLICY, NOW, sha256);
      const legacy = { ...snapshot };
      delete (legacy as { reviewProfile?: unknown }).reviewProfile;
      const reconstructed = resolvePolicyFromSnapshot(legacy);
      expect(reconstructed.reviewProfile).toBe('core');
    });
  });
});
