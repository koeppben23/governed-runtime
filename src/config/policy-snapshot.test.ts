/**
 * @module config/policy-snapshot.test
 * @description Tests for policy snapshot authority functions:
 *   - createPolicySnapshot (full snapshot from policy)
 *   - freezePolicySnapshot (PolicyResolution → Snapshot with all metadata)
 *   - normalizePolicySnapshot / normalizePolicySnapshotWithMeta (legacy enrichment)
 *   - resolvePolicyFromSnapshot / policyFromSnapshot (snapshot → FlowGuardPolicy)
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createPolicySnapshot,
  freezePolicySnapshot,
  normalizePolicySnapshot,
  normalizePolicySnapshotWithMeta,
  resolvePolicyFromSnapshot,
  policyFromSnapshot,
} from './policy-snapshot.js';
import {
  SOLO_POLICY,
  REGULATED_POLICY,
  type PolicyResolution,
  type PolicyDegradedReason,
  type HydratePolicyResolution,
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

function regulatedHydrateResolution(): HydratePolicyResolution {
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
  it('creates snapshot with mode and hash from solo policy', () => {
    const snapshot = createPolicySnapshot(SOLO_POLICY, NOW, sha256);
    expect(snapshot.mode).toBe('solo');
    expect(snapshot.hash.length).toBe(64);
    expect(snapshot.resolvedAt).toBe(NOW);
  });

  it('preserves all governance-critical fields', () => {
    const snapshot = createPolicySnapshot(REGULATED_POLICY, NOW, sha256);
    expect(snapshot.minimumActorAssuranceForApproval).toBe(
      REGULATED_POLICY.minimumActorAssuranceForApproval,
    );
    expect(snapshot.identityProviderMode).toBe('optional');
    expect(snapshot.actorClassification).toEqual(REGULATED_POLICY.actorClassification);
    expect(snapshot.allowSelfApproval).toBe(false);
    expect(snapshot.requireHumanGates).toBe(true);
  });

  it('includes resolution metadata when provided', () => {
    const snapshot = createPolicySnapshot(SOLO_POLICY, NOW, sha256, {
      requestedMode: 'team',
      effectiveGateBehavior: 'human_gated',
      degradedReason: 'ci_context_missing',
      source: 'central',
      resolutionReason: 'repo_weaker_than_central',
      centralMinimumMode: 'team',
      policyDigest: 'abc123',
      policyVersion: '1.0.0',
      policyPathHint: 'central-policy.json',
    });
    expect(snapshot.source).toBe('central');
    expect(snapshot.resolutionReason).toBe('repo_weaker_than_central');
    expect(snapshot.centralMinimumMode).toBe('team');
    expect(snapshot.policyDigest).toBe('abc123');
    expect(snapshot.policyVersion).toBe('1.0.0');
    expect(snapshot.policyPathHint).toBe('central-policy.json');
  });
});

// ─── freezePolicySnapshot ──────────────────────────────────────────────────────

describe('freezePolicySnapshot', () => {
  describe('HAPPY', () => {
    it('freezes PolicyResolution with correct mode and hash', () => {
      const snapshot = freezePolicySnapshot(soloResolution(), NOW, sha256);
      expect(snapshot.mode).toBe('solo');
      expect(snapshot.hash.length).toBe(64);
    });

    it('freezes HydratePolicyResolution with all central evidence metadata', () => {
      const resolution = regulatedHydrateResolution();
      const snapshot = freezePolicySnapshot(resolution, NOW, sha256);

      expect(snapshot.source).toBe('explicit');
      expect(snapshot.resolutionReason).toBe('default_weaker_than_central');
      expect(snapshot.centralMinimumMode).toBe('team');
      expect(snapshot.policyDigest).toBe(sha256('central-policy-bundle'));
      expect(snapshot.policyVersion).toBe('2.1.0');
      expect(snapshot.policyPathHint).toBe('releases/policy-v2.1.json');
    });

    it('policy snapshot preserves identityProvider from FlowGuardPolicy', () => {
      const resolution = regulatedHydrateResolution();
      const snapshot = freezePolicySnapshot(resolution, NOW, sha256);
      expect(snapshot.identityProvider).toBe(REGULATED_POLICY.identityProvider);
      expect(snapshot.identityProviderMode).toBe(REGULATED_POLICY.identityProviderMode);
    });
  });

  describe('CORNER', () => {
    it('handles HydratePolicyResolution without central evidence', () => {
      const resolution: HydratePolicyResolution = {
        requestedMode: 'team',
        requestedSource: 'default',
        effectiveMode: 'team',
        effectiveSource: 'default',
        effectiveGateBehavior: 'human_gated',
        policy: SOLO_POLICY,
      };
      const snapshot = freezePolicySnapshot(resolution, NOW, sha256);
      expect(snapshot.centralMinimumMode).toBeUndefined();
      expect(snapshot.policyDigest).toBeUndefined();
    });
  });
});

// ─── normalizePolicySnapshot / normalizePolicySnapshotWithMeta ──────────────────

describe('normalizePolicySnapshot', () => {
  describe('HAPPY — complete snapshots pass through', () => {
    it('passes through complete snapshot unchanged', () => {
      const original = freezePolicySnapshot(soloResolution(), NOW, sha256);
      const normalized = normalizePolicySnapshot(original);
      expect(normalized.mode).toBe('solo');
      expect(normalized.hash).toBe(original.hash);
    });
  });

  describe('BAD — mode-consistent defaults', () => {
    it('empty snapshot defaults to team mode (safe), not solo', () => {
      const normalized = normalizePolicySnapshot({});
      expect(normalized.mode).toBe('team');
    });

    it('solo mode: human gates false, auto_approve', () => {
      const normalized = normalizePolicySnapshot({ mode: 'solo' });
      expect(normalized.requireHumanGates).toBe(false);
      expect(normalized.effectiveGateBehavior).toBe('auto_approve');
      expect(normalized.allowSelfApproval).toBe(true);
    });

    it('team mode: human gates true, human_gated', () => {
      const normalized = normalizePolicySnapshot({ mode: 'team' });
      expect(normalized.requireHumanGates).toBe(true);
      expect(normalized.effectiveGateBehavior).toBe('human_gated');
      expect(normalized.allowSelfApproval).toBe(true);
    });

    it('regulated mode: human gates true, allowSelfApproval false', () => {
      const normalized = normalizePolicySnapshot({ mode: 'regulated' });
      expect(normalized.requireHumanGates).toBe(true);
      expect(normalized.allowSelfApproval).toBe(false);
      expect(normalized.effectiveGateBehavior).toBe('human_gated');
    });

    it('invalid mode defaults to team (safe fallback)', () => {
      const normalized = normalizePolicySnapshot({ mode: 'broken' });
      expect(normalized.mode).toBe('team');
      expect(normalized.requireHumanGates).toBe(true);
    });
  });

  describe('BAD — field validation', () => {
    it('rejects invalid effectiveGateBehavior, defaults to mode-consistent value', () => {
      const normalized = normalizePolicySnapshot({
        mode: 'solo',
        effectiveGateBehavior: 'invalid_gate',
      });
      expect(normalized.effectiveGateBehavior).toBe('auto_approve');
    });

    it('rejects invalid identityProviderMode, defaults to optional', () => {
      const normalized = normalizePolicySnapshot({ identityProviderMode: 'broken' });
      expect(normalized.identityProviderMode).toBe('optional');
    });

    it('rejects invalid minimumActorAssuranceForApproval, defaults to best_effort', () => {
      const normalized = normalizePolicySnapshot({
        minimumActorAssuranceForApproval: 'super_strong',
      });
      expect(normalized.minimumActorAssuranceForApproval).toBe('best_effort');
    });

    it('rejects non-object audit, defaults to all-true', () => {
      const normalized = normalizePolicySnapshot({ audit: 'not-an-object' });
      expect(normalized.audit.emitTransitions).toBe(true);
      expect(normalized.audit.enableChainHash).toBe(true);
    });
  });

  describe('CORNER — identity preservation', () => {
    it('preserves valid identityProvider across normalization', () => {
      const provider = {
        mode: 'static' as const,
        issuer: 'https://idp.example.com',
        audience: ['flowguard'],
        claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
        signingKeys: [{ kty: 'RSA', n: 'abc', e: 'AQAB', kid: 'key-1' }],
      };
      const normalized = normalizePolicySnapshot({
        mode: 'regulated',
        identityProvider: provider,
        identityProviderMode: 'required',
      });
      expect(normalized.identityProvider).toEqual(provider);
      expect(normalized.identityProviderMode).toBe('required');
    });

    it('null identityProvider becomes undefined', () => {
      const normalized = normalizePolicySnapshot({ identityProvider: null });
      expect(normalized.identityProvider).toBeUndefined();
    });
  });

  describe('EDGE', () => {
    it('handles null input gracefully', () => {
      expect(() =>
        normalizePolicySnapshot(null as unknown as Record<string, unknown>),
      ).not.toThrow();
    });

    it('handles undefined input gracefully', () => {
      expect(() =>
        normalizePolicySnapshot(undefined as unknown as Record<string, unknown>),
      ).not.toThrow();
    });
  });
});

// ─── normalizePolicySnapshotWithMeta ────────────────────────────────────────────

describe('normalizePolicySnapshotWithMeta', () => {
  it('returns normalized=false for complete snapshot', () => {
    const complete = freezePolicySnapshot(soloResolution(), NOW, sha256);
    const result = normalizePolicySnapshotWithMeta(complete);
    expect(result.normalized).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it('returns normalized=true for empty snapshot', () => {
    const result = normalizePolicySnapshotWithMeta({});
    expect(result.normalized).toBe(true);
    expect(result.reason).toBe('incomplete_snapshot_normalized');
  });

  it('returns normalized=true for incomplete snapshot missing key fields', () => {
    const result = normalizePolicySnapshotWithMeta({
      mode: 'regulated',
      // Missing: hash, identityProviderMode, actorClassification, etc.
    });
    expect(result.normalized).toBe(true);
  });

  it('returns normalized=true for snapshot with invalid fields', () => {
    const result = normalizePolicySnapshotWithMeta({
      mode: 'invalid_mode',
      identityProviderMode: 'broken',
    });
    expect(result.normalized).toBe(true);
    expect(result.snapshot.mode).toBe('team');
    expect(result.snapshot.identityProviderMode).toBe('optional');
  });
});

// ─── resolvePolicyFromSnapshot / policyFromSnapshot ─────────────────────────────

describe('resolvePolicyFromSnapshot', () => {
  describe('HAPPY — round-trip', () => {
    it('freeze → resolve preserves all governance fields', () => {
      const resolution = regulatedHydrateResolution();
      const snapshot = freezePolicySnapshot(resolution, NOW, sha256);
      const policy = resolvePolicyFromSnapshot(snapshot);

      expect(policy.mode).toBe('regulated');
      expect(policy.requireHumanGates).toBe(true);
      expect(policy.minimumActorAssuranceForApproval).toBe(
        REGULATED_POLICY.minimumActorAssuranceForApproval,
      );
      expect(policy.identityProvider).toBe(REGULATED_POLICY.identityProvider);
      expect(policy.identityProviderMode).toBe('optional');
      expect(policy.allowSelfApproval).toBe(false);
    });

    it('resolve from normalized empty snapshot produces team policy', () => {
      const normalized = normalizePolicySnapshot({});
      const policy = resolvePolicyFromSnapshot(normalized);
      expect(policy.mode).toBe('team');
      expect(policy.requireHumanGates).toBe(true);
      expect(policy.minimumActorAssuranceForApproval).toBe('best_effort');
    });
  });
});

describe('policyFromSnapshot (alias)', () => {
  it('returns same result as resolvePolicyFromSnapshot', () => {
    const snapshot = freezePolicySnapshot(soloResolution(), NOW, sha256);
    expect(policyFromSnapshot(snapshot)).toEqual(resolvePolicyFromSnapshot(snapshot));
  });
});
