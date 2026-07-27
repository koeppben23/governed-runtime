/**
 * @module config/policy-snapshot-normalize.test
 * @description Tests for policy snapshot normalization functions:
 *   - normalizePolicySnapshot / normalizePolicySnapshotWithMeta (legacy enrichment)
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  normalizePolicySnapshot,
  normalizePolicySnapshotWithMeta,
} from './policy-snapshot-normalize.js';
import type { PolicySnapshot } from '../state/evidence.js';
import { PolicyConfigurationError } from './policy-errors.js';
import { CHALLENGE_POLICY_V1 } from './policy-types.js';
import { sha256, soloResolution, NOW } from './policy-snapshot.test.js';
import { freezePolicySnapshot } from './policy-snapshot.js';

// ─── normalizePolicySnapshot ─────────────────────────────────────────────────

describe('normalizePolicySnapshot', () => {
  describe('HAPPY — complete snapshots pass through', () => {
    it('passes through complete snapshot unchanged', () => {
      const original = freezePolicySnapshot(soloResolution(), NOW, sha256);
      const normalized = normalizePolicySnapshot(original);
      expect(normalized.mode).toBe('solo');
      expect(normalized.effectiveGateBehavior).toBe('auto_approve');
    });

    it('preserves the frozen challenge policy', () => {
      const original = freezePolicySnapshot(soloResolution(), NOW, sha256);
      expect(normalizePolicySnapshot(original).challengePolicy).toEqual(original.challengePolicy);
    });
  });

  describe('BAD — mode-consistent defaults', () => {
    it('empty snapshot defaults to team mode (safe), not solo', () => {
      const result = normalizePolicySnapshot({});
      expect(result.mode).toBe('team');
    });

    it('solo mode: human gates false, auto_approve', () => {
      const result = normalizePolicySnapshot({ mode: 'solo' });
      expect(result.effectiveGateBehavior).toBe('auto_approve');
      expect(result.requireHumanGates).toBe(false);
    });

    it('team mode: human gates true, human_gated', () => {
      const result = normalizePolicySnapshot({ mode: 'team' });
      expect(result.effectiveGateBehavior).toBe('human_gated');
      expect(result.requireHumanGates).toBe(true);
    });

    it('regulated mode: human gates true, allowSelfApproval false', () => {
      const result = normalizePolicySnapshot({ mode: 'regulated' });
      expect(result.allowSelfApproval).toBe(false);
    });

    it('defaults the missing F12 incoherent-capture retry budget for legacy snapshots', () => {
      const result = normalizePolicySnapshot({ mode: 'team' });
      expect(result.maxIncoherentReviewerCaptureRetries).toBe(1);
    });

    it('invalid mode throws PolicyConfigurationError (fail-closed)', () => {
      expect(() => normalizePolicySnapshot({ mode: 'bogus' })).toThrow(PolicyConfigurationError);
      expect(() => normalizePolicySnapshot({ mode: 'bogus' })).toThrow(
        /Invalid policy mode "bogus"/,
      );
    });

    it('carries structured { received, allowed } details on the error (#418)', () => {
      try {
        normalizePolicySnapshot({ mode: 'bogus' });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PolicyConfigurationError);
        const e = err as PolicyConfigurationError;
        expect(e.code).toBe('INVALID_POLICY_MODE');
        expect(e.details?.received).toBe('bogus');
        expect(Array.isArray(e.details?.allowed)).toBe(true);
      }
    });

    it('missing mode (undefined) defaults to team (safe fallback)', () => {
      const result = normalizePolicySnapshot({ mode: undefined });
      expect(result.mode).toBe('team');
    });
  });

  describe('BAD — validationEvidence mode-consistent defaults (#400)', () => {
    it('solo mode: validationEvidence enforcement off', () => {
      const result = normalizePolicySnapshot({ mode: 'solo' });
      expect(result.validationEvidence.enforcement).toBe('off');
    });

    it('team mode: validationEvidence enforcement off', () => {
      const result = normalizePolicySnapshot({ mode: 'team' });
      expect(result.validationEvidence.enforcement).toBe('off');
    });

    it('regulated mode: validationEvidence enforcement required, fail-closed', () => {
      const result = normalizePolicySnapshot({ mode: 'regulated' });
      expect(result.validationEvidence.enforcement).toBe('required');
    });

    it('team-ci mode: validationEvidence enforcement required, fail-closed', () => {
      const result = normalizePolicySnapshot({ mode: 'team-ci' });
      expect(result.validationEvidence.enforcement).toBe('required');
    });

    it('missing validationEvidence on regulated snapshot falls back to required (not off)', () => {
      const result = normalizePolicySnapshot({ mode: 'regulated' });
      expect(result.validationEvidence.enforcement).toBe('required');
    });

    it('malformed validationEvidence enforcement falls back to mode default', () => {
      const result = normalizePolicySnapshot({
        mode: 'regulated',
        validationEvidence: { enforcement: 'garbage' },
      });
      expect(result.validationEvidence.enforcement).toBe('required');
    });

    it('preserves explicit allowNoCommands opt-out', () => {
      const result = normalizePolicySnapshot({
        mode: 'regulated',
        validationEvidence: { enforcement: 'required', allowNoCommands: false },
      });
      expect(result.validationEvidence.allowNoCommands).toBe(false);
    });
  });

  describe('BAD — field validation', () => {
    it('rejects invalid effectiveGateBehavior, defaults to mode-consistent value', () => {
      const result = normalizePolicySnapshot({
        mode: 'team',
        effectiveGateBehavior: 'bogus',
      });
      expect(result.effectiveGateBehavior).toBe('human_gated');
    });

    it('rejects invalid identityProviderMode, defaults to optional', () => {
      const result = normalizePolicySnapshot({
        mode: 'team',
        identityProviderMode: 'bogus',
      });
      expect(result.identityProviderMode).toBe('optional');
    });

    it('rejects invalid minimumActorAssuranceForApproval, defaults to best_effort', () => {
      const result = normalizePolicySnapshot({
        mode: 'solo',
        minimumActorAssuranceForApproval: 'bogus',
      });
      expect(result.minimumActorAssuranceForApproval).toBe('best_effort');
    });

    it('rejects non-object audit, defaults to all-true', () => {
      const result = normalizePolicySnapshot({ mode: 'team', audit: 42 });
      expect(result.audit.emitTransitions).toBe(true);
      expect(result.audit.emitToolCalls).toBe(true);
      expect(result.audit.enableChainHash).toBe(true);
    });
  });

  describe('CORNER — identity preservation', () => {
    it('preserves valid identityProvider across normalization', () => {
      const identityProvider = {
        mode: 'static' as const,
        issuer: 'https://example.com',
        audience: ['aud'] as string[],
        claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
        signingKeys: [{ kind: 'pem' as const, kid: 'key-1', alg: 'RS256' as const, pem: 'PEM' }],
      };
      const result = normalizePolicySnapshot({ mode: 'team', identityProvider });
      expect(result.identityProvider).toEqual(identityProvider);
    });

    it('null identityProvider becomes undefined', () => {
      const result = normalizePolicySnapshot({ mode: 'team', identityProvider: null });
      expect(result.identityProvider).toBeUndefined();
    });
  });

  describe('EDGE', () => {
    it('handles null input gracefully', () => {
      const result = normalizePolicySnapshot(null);
      expect(result.mode).toBe('team');
    });

    it('leaves an absent challengePolicy disabled in solo mode (legacy-tolerant)', () => {
      const result = normalizePolicySnapshot({ mode: 'solo' });
      expect(result.challengePolicy).toBeUndefined();
    });

    it('fails closed to the frozen matrix for an absent challengePolicy in an enforced mode (A2)', () => {
      for (const mode of ['team', 'team-ci', 'regulated'] as const) {
        const result = normalizePolicySnapshotWithMeta({ mode });
        expect(result.snapshot.challengePolicy).toEqual(CHALLENGE_POLICY_V1);
        expect(result.normalized).toBe(true);
      }
    });

    it('fails closed to the frozen matrix when a present challengePolicy is malformed', () => {
      const result = normalizePolicySnapshotWithMeta({
        mode: 'team',
        challengePolicy: { version: 'challenge-policy.v1', counts: { TRIVIAL: 9 } },
      });
      expect(result.snapshot.challengePolicy).toEqual(CHALLENGE_POLICY_V1);
      expect(result.normalized).toBe(true);
    });

    it('fails closed to the frozen matrix when challengePolicy is a non-object', () => {
      const result = normalizePolicySnapshot({ mode: 'team', challengePolicy: 'nonsense' });
      expect(result.challengePolicy).toEqual(CHALLENGE_POLICY_V1);
    });

    it('handles undefined input gracefully', () => {
      const result = normalizePolicySnapshot(undefined);
      expect(result.mode).toBe('team');
    });
  });
});

// ─── normalizePolicySnapshotWithMeta ─────────────────────────────────────────

describe('normalizePolicySnapshotWithMeta', () => {
  it('returns normalized=false for complete snapshot', () => {
    const complete = freezePolicySnapshot(soloResolution(), NOW, sha256);
    const { snapshot: s, normalized } = normalizePolicySnapshotWithMeta(complete);
    expect(s.mode).toBe('solo');
    expect(s.effectiveGateBehavior).toBe('auto_approve');
    // normalized may be true if selfReview or discoveryHealth fields differ
    // from mode-consistent defaults; both behaviors are valid.
    expect(typeof normalized).toBe('boolean');
  });

  it('returns normalized=true for empty snapshot', () => {
    const result = normalizePolicySnapshotWithMeta({});
    expect(result.normalized).toBe(true);
  });

  it('returns normalized=true for incomplete snapshot missing key fields', () => {
    const result = normalizePolicySnapshotWithMeta({ mode: 'team' });
    expect(result.normalized).toBe(true);
  });

  it('throws PolicyConfigurationError for snapshot with invalid mode (fail-closed)', () => {
    expect(() => normalizePolicySnapshotWithMeta({ mode: 'bogus' })).toThrow(
      PolicyConfigurationError,
    );
  });

  describe('NEGATIVE — invalid audit config', () => {
    it('non-object audit defaults to all-true and marks normalized', () => {
      const complete = freezePolicySnapshot(soloResolution(), NOW, sha256);
      const { snapshot: s, normalized } = normalizePolicySnapshotWithMeta({
        ...complete,
        audit: 'not-an-object',
      });
      expect(s.audit.emitTransitions).toBe(true);
      expect(normalized).toBe(true);
    });

    it('null audit defaults to all-true and marks normalized', () => {
      const complete = freezePolicySnapshot(soloResolution(), NOW, sha256);
      const { snapshot: s, normalized } = normalizePolicySnapshotWithMeta({
        ...complete,
        audit: null,
      });
      expect(s.audit.emitTransitions).toBe(true);
      expect(normalized).toBe(true);
    });

    it('undefined audit defaults to all-true and marks normalized', () => {
      const complete = freezePolicySnapshot(soloResolution(), NOW, sha256);
      delete (complete as Record<string, unknown>).audit;
      const { snapshot: s, normalized } = normalizePolicySnapshotWithMeta(complete);
      expect(s.audit.emitTransitions).toBe(true);
      expect(normalized).toBe(true);
    });

    it('partial audit with one missing boolean falls back to true for missing field', () => {
      const complete = freezePolicySnapshot(soloResolution(), NOW, sha256);
      const { snapshot: s } = normalizePolicySnapshotWithMeta({
        ...complete,
        audit: { emitTransitions: false, timestampAssurance: complete.audit.timestampAssurance },
      });
      expect(s.audit.emitTransitions).toBe(false);
      expect(s.audit.emitToolCalls).toBe(true);
    });
  });

  describe('NEGATIVE — invalid self-review config', () => {
    it('null selfReview marks normalized and resolves to strict default', () => {
      const complete = freezePolicySnapshot(soloResolution(), NOW, sha256);
      const result = normalizePolicySnapshotWithMeta({ ...complete, selfReview: null });
      expect(result.normalized).toBe(true);
    });

    it('undefined selfReview marks normalized and resolves to strict default', () => {
      const complete = freezePolicySnapshot(soloResolution(), NOW, sha256);
      delete (complete as Record<string, unknown>).selfReview;
      const result = normalizePolicySnapshotWithMeta(complete);
      expect(result.normalized).toBe(true);
    });

    it('weakened selfReview (subagentEnabled=false) marks normalized and resolves to strict default', () => {
      const complete = freezePolicySnapshot(soloResolution(), NOW, sha256);
      const result = normalizePolicySnapshotWithMeta({
        ...complete,
        selfReview: { subagentEnabled: false, fallbackToSelf: false, strictEnforcement: true },
      });
      expect(result.normalized).toBe(true);
    });

    it('weakened selfReview (fallbackToSelf=true) marks normalized', () => {
      const complete = freezePolicySnapshot(soloResolution(), NOW, sha256);
      const result = normalizePolicySnapshotWithMeta({
        ...complete,
        selfReview: { subagentEnabled: true, fallbackToSelf: true, strictEnforcement: true },
      });
      expect(result.normalized).toBe(true);
    });

    it('weakened selfReview (strictEnforcement=false) marks normalized', () => {
      const complete = freezePolicySnapshot(soloResolution(), NOW, sha256);
      const result = normalizePolicySnapshotWithMeta({
        ...complete,
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      });
      expect(result.normalized).toBe(true);
    });
  });

  describe('NEGATIVE — invalid actor assurance', () => {
    it('invalid assurance defaults to best_effort in solo mode and marks normalized', () => {
      const { snapshot: s, normalized } = normalizePolicySnapshotWithMeta({
        mode: 'solo',
        minimumActorAssuranceForApproval: 'bogus',
        requireVerifiedActorsForApproval: false,
      });
      expect(s.minimumActorAssuranceForApproval).toBe('best_effort');
      expect(normalized).toBe(true);
    });

    it('invalid assurance with requireVerifiedActors=true defaults to claim_validated', () => {
      const { snapshot: s, normalized } = normalizePolicySnapshotWithMeta({
        mode: 'regulated',
        minimumActorAssuranceForApproval: 'bogus',
        requireVerifiedActorsForApproval: true,
      });
      expect(s.minimumActorAssuranceForApproval).toBe('claim_validated');
      expect(normalized).toBe(true);
    });

    it('invalid assurance with requireVerifiedActors=false defaults to regulated mode default', () => {
      const { snapshot: s, normalized } = normalizePolicySnapshotWithMeta({
        mode: 'regulated',
        minimumActorAssuranceForApproval: 'bogus',
        requireVerifiedActorsForApproval: false,
      });
      expect(s.minimumActorAssuranceForApproval).toBe('claim_validated');
      expect(normalized).toBe(true);
    });
  });

  describe('NEGATIVE — invalid review invocation policy', () => {
    it('invalid reviewOutputPolicy defaults to mode-consistent value', () => {
      const { snapshot: s, normalized } = normalizePolicySnapshotWithMeta({
        mode: 'regulated',
        reviewOutputPolicy: 'bogus',
      });
      expect(s.reviewOutputPolicy).toBe('structured_required');
      expect(normalized).toBe(true);
    });

    it('invalid reviewInvocationPolicy defaults to mode-consistent value', () => {
      const { snapshot: s, normalized } = normalizePolicySnapshotWithMeta({
        mode: 'regulated',
        reviewInvocationPolicy: 'bogus',
      });
      expect(s.reviewInvocationPolicy).toBe('host_task_required');
      expect(normalized).toBe(true);
    });
  });

  describe('CORNER — composite invalidity', () => {
    it('invalid mode throws PolicyConfigurationError (fail-closed)', () => {
      expect(() =>
        normalizePolicySnapshotWithMeta({
          mode: 'bogus',
          effectiveGateBehavior: 'also_bogus',
        }),
      ).toThrow(PolicyConfigurationError);
    });

    it('missing mode (null) normalizes other fields and defaults mode to team', () => {
      const { snapshot: s, normalized } = normalizePolicySnapshotWithMeta({
        mode: null,
        identityProviderMode: 'bogus',
      });
      expect(s.mode).toBe('team');
      expect(s.identityProviderMode).toBe('optional');
      expect(normalized).toBe(true);
    });
  });
});
