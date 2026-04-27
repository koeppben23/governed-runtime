/**
 * @module config/policy-snapshot.test
 * @description Tests for policy snapshot authority functions:
 *   - normalizePolicySnapshot (legacy/incomplete enrichment)
 *   - freezePolicySnapshot (PolicyResolution → PolicySnapshot)
 *   - policyFromSnapshot (Snapshot → FlowGuardPolicy round-trip)
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  normalizePolicySnapshot,
  freezePolicySnapshot,
  policyFromSnapshot,
  createPolicySnapshot,
  SOLO_POLICY,
  REGULATED_POLICY,
  type PolicyResolution,
  type PolicyMode,
  type PolicyDegradedReason,
} from './policy.js';
import type { PolicySnapshot } from '../state/evidence.js';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf-8').digest('hex');
const NOW = '2026-04-27T10:00:00.000Z';

function soloResolution(overrides?: Partial<PolicyResolution>): PolicyResolution {
  return {
    requestedMode: 'solo',
    effectiveMode: 'solo',
    effectiveGateBehavior: 'auto_approve',
    policy: SOLO_POLICY,
    ...overrides,
  };
}

function regulatedResolution(overrides?: Partial<PolicyResolution>): PolicyResolution {
  return {
    requestedMode: 'regulated',
    effectiveMode: 'regulated',
    effectiveGateBehavior: 'human_gated',
    policy: REGULATED_POLICY,
    ...overrides,
  };
}

// ─── freezePolicySnapshot ──────────────────────────────────────────────────────

describe('freezePolicySnapshot', () => {
  describe('HAPPY', () => {
    it('freezes a solo resolution with correct mode', () => {
      const snapshot = freezePolicySnapshot(soloResolution(), NOW, sha256);
      expect(snapshot.mode).toBe('solo');
      expect(snapshot.hash.length).toBe(64);
      expect(snapshot.resolvedAt).toBe(NOW);
      expect(snapshot.requestedMode).toBe('solo');
    });

    it('freezes a regulated resolution with correct mode', () => {
      const snapshot = freezePolicySnapshot(regulatedResolution(), NOW, sha256);
      expect(snapshot.mode).toBe('regulated');
      expect(snapshot.requireHumanGates).toBe(true);
    });

    it('preserves policy governance-critical fields', () => {
      const snapshot = freezePolicySnapshot(regulatedResolution(), NOW, sha256);
      expect(snapshot.minimumActorAssuranceForApproval).toBe(
        REGULATED_POLICY.minimumActorAssuranceForApproval,
      );
      expect(snapshot.identityProvider).toBe(REGULATED_POLICY.identityProvider);
      expect(snapshot.identityProviderMode).toBe(REGULATED_POLICY.identityProviderMode);
      expect(snapshot.actorClassification).toEqual(REGULATED_POLICY.actorClassification);
      expect(snapshot.selfReview).toEqual(REGULATED_POLICY.selfReview);
      expect(snapshot.allowSelfApproval).toBe(REGULATED_POLICY.allowSelfApproval);
    });

    it('produces deterministic hash for same policy', () => {
      const a = freezePolicySnapshot(soloResolution(), NOW, sha256);
      const b = freezePolicySnapshot(soloResolution(), NOW, sha256);
      expect(a.hash).toBe(b.hash);
    });

    it('produces different hash for different policy', () => {
      const a = freezePolicySnapshot(soloResolution(), NOW, sha256);
      const b = freezePolicySnapshot(regulatedResolution(), NOW, sha256);
      expect(a.hash).not.toBe(b.hash);
    });
  });

  describe('CORNER', () => {
    it('handles degraded resolution', () => {
      const res = soloResolution({
        effectiveMode: 'team',
        effectiveGateBehavior: 'human_gated',
        degradedReason: 'ci_context_missing' as PolicyDegradedReason,
      });
      const snapshot = freezePolicySnapshot(res, NOW, sha256);
      expect(snapshot.effectiveGateBehavior).toBe('human_gated');
      expect(snapshot.degradedReason).toBe('ci_context_missing');
    });
  });

  describe('EDGE', () => {
    it('hash depends only on policy, not on timestamp', () => {
      const a = freezePolicySnapshot(soloResolution(), '2026-01-01T00:00:00Z', sha256);
      const b = freezePolicySnapshot(soloResolution(), '2026-01-02T00:00:00Z', sha256);
      // Hash is derived from policy content, not resolvedAt — same policy, same hash
      expect(a.hash).toBe(b.hash);
      expect(a.resolvedAt).not.toBe(b.resolvedAt);
    });
  });
});

// ─── normalizePolicySnapshot ───────────────────────────────────────────────────

describe('normalizePolicySnapshot', () => {
  describe('HAPPY', () => {
    it('passes through complete snapshot unchanged except for sort order', () => {
      const original = freezePolicySnapshot(soloResolution(), NOW, sha256);
      const normalized = normalizePolicySnapshot(original);
      expect(normalized.mode).toBe(original.mode);
      expect(normalized.hash).toBe(original.hash);
      expect(normalized.minimumActorAssuranceForApproval).toBe(
        original.minimumActorAssuranceForApproval,
      );
    });

    it('preserves identityProvider when present', () => {
      const original = freezePolicySnapshot(regulatedResolution(), NOW, sha256);
      const normalized = normalizePolicySnapshot(original);
      expect(normalized.identityProvider).toBe(original.identityProvider);
      expect(normalized.identityProviderMode).toBe(original.identityProviderMode);
    });
  });

  describe('BAD — incomplete snapshots', () => {
    it('fills missing mode with solo', () => {
      const normalized = normalizePolicySnapshot({});
      expect(normalized.mode).toBe('solo');
    });

    it('fills missing hash with legacy marker', () => {
      const normalized = normalizePolicySnapshot({});
      expect(normalized.hash).toBe('UNKNOWN_LEGACY');
    });

    it('fills missing resolvedAt with fallback date', () => {
      const normalized = normalizePolicySnapshot({});
      expect(normalized.resolvedAt).toBeTruthy();
    });

    it('fills missing actorClassification with empty object', () => {
      const normalized = normalizePolicySnapshot({});
      expect(normalized.actorClassification).toEqual({});
    });

    it('fills missing minimumActorAssuranceForApproval with best_effort', () => {
      const normalized = normalizePolicySnapshot({});
      expect(normalized.minimumActorAssuranceForApproval).toBe('best_effort');
    });

    it('derives minimumActorAssuranceForApproval from requireVerifiedActorsForApproval', () => {
      const normalized = normalizePolicySnapshot({
        requireVerifiedActorsForApproval: true,
      });
      expect(normalized.minimumActorAssuranceForApproval).toBe('claim_validated');
    });

    it('fills missing identityProviderMode with optional', () => {
      const normalized = normalizePolicySnapshot({});
      expect(normalized.identityProviderMode).toBe('optional');
    });

    it('fills missing requireHumanGates with true (safe default)', () => {
      const normalized = normalizePolicySnapshot({});
      expect(normalized.requireHumanGates).toBe(true);
    });

    it('fills missing maxSelfReviewIterations with 3', () => {
      const normalized = normalizePolicySnapshot({});
      expect(normalized.maxSelfReviewIterations).toBe(3);
    });

    it('fills missing audit with safe defaults', () => {
      const normalized = normalizePolicySnapshot({});
      expect(normalized.audit.emitTransitions).toBe(true);
      expect(normalized.audit.enableChainHash).toBe(true);
    });
  });

  describe('CORNER — partial snapshots', () => {
    it('preserves set identityProvider and fills missing other fields', () => {
      const normalized = normalizePolicySnapshot({
        mode: 'regulated',
        identityProvider: {
          mode: 'static' as const,
          issuer: 'https://idp.example.com',
          audience: ['flowguard'],
          claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
          signingKeys: [{ kty: 'RSA', n: 'abc', e: 'AQAB', kid: 'key-1' }],
        },
        identityProviderMode: 'required' as const,
      });
      expect(normalized.identityProvider).toBeDefined();
      expect(normalized.identityProviderMode).toBe('required');
      expect(normalized.minimumActorAssuranceForApproval).toBe('best_effort');
      expect(normalized.maxSelfReviewIterations).toBe(3);
    });
  });

  describe('EDGE', () => {
    it('does not throw on null/undefined snapshot', () => {
      expect(() =>
        normalizePolicySnapshot(null as unknown as Record<string, unknown>),
      ).not.toThrow();
      expect(() =>
        normalizePolicySnapshot(undefined as unknown as Record<string, unknown>),
      ).not.toThrow();
    });

    it('does not throw on empty object', () => {
      expect(() => normalizePolicySnapshot({})).not.toThrow();
    });
  });
});

// ─── policyFromSnapshot round-trip ─────────────────────────────────────────────

describe('policyFromSnapshot / freezePolicySnapshot round-trip', () => {
  describe('HAPPY', () => {
    it('round-trip: freeze → fromSnapshot preserves all governance fields', () => {
      const resolution = regulatedResolution();
      const snapshot = freezePolicySnapshot(resolution, NOW, sha256);
      const policy = policyFromSnapshot(snapshot);

      expect(policy.mode).toBe(resolution.policy.mode);
      expect(policy.requireHumanGates).toBe(resolution.policy.requireHumanGates);
      expect(policy.minimumActorAssuranceForApproval).toBe(
        resolution.policy.minimumActorAssuranceForApproval,
      );
      expect(policy.identityProvider).toBe(resolution.policy.identityProvider);
      expect(policy.identityProviderMode).toBe(resolution.policy.identityProviderMode);
      expect(policy.allowSelfApproval).toBe(resolution.policy.allowSelfApproval);
    });

    it('round-trip: solo policy preserves all fields', () => {
      const snapshot = freezePolicySnapshot(soloResolution(), NOW, sha256);
      const policy = policyFromSnapshot(snapshot);

      expect(policy.mode).toBe('solo');
      expect(policy.requireHumanGates).toBe(false);
      expect(policy.allowSelfApproval).toBe(true);
      expect(policy.minimumActorAssuranceForApproval).toBe('best_effort');
    });
  });

  describe('CORNER', () => {
    it('normalize → fromSnapshot produces a valid policy from empty input', () => {
      const normalized = normalizePolicySnapshot({});
      const policy = policyFromSnapshot(normalized);

      expect(policy.mode).toBe('solo');
      expect(policy.requireHumanGates).toBe(true);
      expect(policy.minimumActorAssuranceForApproval).toBe('best_effort');
      expect(policy.identityProviderMode).toBe('optional');
    });
  });

  describe('EDGE', () => {
    it('snapshots with different hashes produce policies with correct modes', () => {
      const snapA = freezePolicySnapshot(soloResolution(), NOW, sha256);
      const snapB = freezePolicySnapshot(regulatedResolution(), NOW, sha256);

      const policyA = policyFromSnapshot(snapA);
      const policyB = policyFromSnapshot(snapB);

      expect(policyA.mode).toBe('solo');
      expect(policyB.mode).toBe('regulated');
      expect(policyA.requireHumanGates).not.toBe(policyB.requireHumanGates);
    });
  });
});

// ─── createPolicySnapshot direct ───────────────────────────────────────────────

describe('createPolicySnapshot', () => {
  it('creates snapshot with all governance fields from policy alone', () => {
    const snapshot = createPolicySnapshot(SOLO_POLICY, NOW, sha256);
    expect(snapshot.mode).toBe('solo');
    expect(snapshot.actorClassification).toEqual(SOLO_POLICY.actorClassification);
    expect(snapshot.minimumActorAssuranceForApproval).toBe(
      SOLO_POLICY.minimumActorAssuranceForApproval,
    );
    expect(snapshot.identityProviderMode).toBe('optional');
    expect(snapshot.hash.length).toBe(64);
  });
});
