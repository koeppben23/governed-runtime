/**
 * @module hydrate.test
 * @test-policy mutation-kill — targets applyHydrateOverrides, input validation,
 * activeChecks fallback, phaseRuleContent, defaults via ?? operators.
 */
import { describe, it, expect } from 'vitest';
import { executeHydrate, type HydrateInput } from './hydrate.js';
import type { RailContext } from './types.js';
import {
  FIXED_TIME,
  FIXED_SESSION_UUID,
  FIXED_FINGERPRINT,
  DECISION_IDENTITY_INITIATOR,
  makeState,
} from '../__fixtures__.js';
import { getPolicyPreset } from '../config/policy.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const digestFn = (text: string): string => `sha256:${text.slice(0, 8)}`;

const baseCtx: RailContext = {
  now: () => FIXED_TIME,
  digest: digestFn,
  policy: getPolicyPreset('solo'),
};

function minimalInput(overrides?: {
  session?: Partial<HydrateInput['session']>;
  policy?: Partial<HydrateInput['policy']>;
  profile?: Partial<HydrateInput['profile']>;
}): HydrateInput {
  return {
    session: {
      sessionId: FIXED_SESSION_UUID,
      worktree: '/tmp/test-repo',
      fingerprint: FIXED_FINGERPRINT,
      ...overrides?.session,
    },
    policy: { ...overrides?.policy },
    profile: { ...overrides?.profile },
  };
}

function hydrateNew(input: HydrateInput, ctx = baseCtx) {
  return executeHydrate(null, input, ctx);
}

/** Asserts result is ok and returns the state for further assertions. */
function expectOk(result: ReturnType<typeof executeHydrate>) {
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') throw new Error('unreachable — assertion above fails first');
  return result.state;
}

/** Asserts result is blocked with the expected code. */
function expectBlocked(result: ReturnType<typeof executeHydrate>, code: string) {
  expect(result.kind).toBe('blocked');
  if (result.kind === 'blocked') expect(result.code).toBe(code);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('hydrate rail unit tests', () => {
  // ─── Input Validation ─────────────────────────────────────────────────

  describe('input validation', () => {
    it('blocks on empty sessionId', () => {
      const result = hydrateNew(minimalInput({ session: { sessionId: '' } }));
      expectBlocked(result, 'MISSING_SESSION_ID');
    });

    it('blocks on whitespace-only sessionId', () => {
      const result = hydrateNew(minimalInput({ session: { sessionId: '   ' } }));
      expectBlocked(result, 'MISSING_SESSION_ID');
    });

    it('blocks on empty worktree', () => {
      const result = hydrateNew(minimalInput({ session: { worktree: '' } }));
      expectBlocked(result, 'MISSING_WORKTREE');
    });

    it('blocks on whitespace-only worktree (trim branch)', () => {
      const result = hydrateNew(minimalInput({ session: { worktree: '   \t  ' } }));
      expectBlocked(result, 'MISSING_WORKTREE');
    });

    it('blocks on missing fingerprint', () => {
      const result = hydrateNew(minimalInput({ session: { fingerprint: '' } }));
      expectBlocked(result, 'INVALID_FINGERPRINT');
    });

    it('blocks on short fingerprint (regex anchor)', () => {
      const result = hydrateNew(minimalInput({ session: { fingerprint: 'a1b2c3' } }));
      expectBlocked(result, 'INVALID_FINGERPRINT');
    });

    it('blocks on uppercase fingerprint', () => {
      const result = hydrateNew(
        minimalInput({ session: { fingerprint: 'A1B2C3D4E5F6A1B2C3D4E5F6' } }),
      );
      expectBlocked(result, 'INVALID_FINGERPRINT');
    });

    it('blocks when fingerprint has correct chars but wrong length (25 chars)', () => {
      const result = hydrateNew(
        minimalInput({ session: { fingerprint: 'a1b2c3d4e5f6a1b2c3d4e5f6a' } }),
      );
      expectBlocked(result, 'INVALID_FINGERPRINT');
    });

    it('blocks when fingerprint has non-hex chars (regex char class)', () => {
      const result = hydrateNew(
        minimalInput({ session: { fingerprint: 'a1b2c3d4e5g6a1b2c3d4e5f6' } }),
      );
      expectBlocked(result, 'INVALID_FINGERPRINT');
    });

    it('accepts valid worktree with leading/trailing whitespace (trim passes)', () => {
      const result = hydrateNew(minimalInput({ session: { worktree: '  /tmp/repo  ' } }));
      expect(result.kind).toBe('ok');
    });
  });

  // ─── Idempotent Path ──────────────────────────────────────────────────

  describe('idempotent existing state', () => {
    it('returns existing state unchanged when state is not null', () => {
      const existing = makeState('TICKET');
      const result = executeHydrate(existing, minimalInput(), baseCtx);
      const state = expectOk(result);
      expect(state).toBe(existing);
    });
  });

  // ─── applyHydrateOverrides ────────────────────────────────────────────

  describe('applyHydrateOverrides', () => {
    it('applies maxSelfReviewIterations override when provided', () => {
      const result = hydrateNew(minimalInput({ policy: { maxSelfReviewIterations: 5 } }));
      const state = expectOk(result);
      expect(state.policySnapshot.maxSelfReviewIterations).toBe(5);
    });

    it('preserves base maxSelfReviewIterations when override is undefined', () => {
      const result = hydrateNew(minimalInput({ policy: {} }));
      const state = expectOk(result);
      // solo default is 2
      expect(state.policySnapshot.maxSelfReviewIterations).toBe(2);
    });

    it('applies maxImplReviewIterations override when provided', () => {
      const result = hydrateNew(minimalInput({ policy: { maxImplReviewIterations: 7 } }));
      const state = expectOk(result);
      expect(state.policySnapshot.maxImplReviewIterations).toBe(7);
    });

    it('preserves base maxImplReviewIterations when override is undefined', () => {
      const result = hydrateNew(minimalInput({ policy: {} }));
      const state = expectOk(result);
      expect(state.policySnapshot.maxImplReviewIterations).toBe(1);
    });

    it('applies requireVerifiedActorsForApproval override', () => {
      const result = hydrateNew(
        minimalInput({ policy: { requireVerifiedActorsForApproval: true } }),
      );
      const state = expectOk(result);
      expect(state.policySnapshot.requireVerifiedActorsForApproval).toBe(true);
    });

    it('preserves base requireVerifiedActorsForApproval when undefined', () => {
      const result = hydrateNew(minimalInput({ policy: {} }));
      const state = expectOk(result);
      // solo default is false
      expect(state.policySnapshot.requireVerifiedActorsForApproval).toBe(false);
    });

    it('applies identityProviderMode override', () => {
      const result = hydrateNew(minimalInput({ policy: { identityProviderMode: 'required' } }));
      const state = expectOk(result);
      expect(state.policySnapshot.identityProviderMode).toBe('required');
    });

    it('applies minimumActorAssuranceForApproval override', () => {
      const result = hydrateNew(
        minimalInput({ policy: { minimumActorAssuranceForApproval: 'idp_verified' } }),
      );
      const state = expectOk(result);
      expect(state.policySnapshot.minimumActorAssuranceForApproval).toBe('idp_verified');
    });

    it('applies identityProvider override', () => {
      const idpConfig = {
        issuer: 'https://idp.example.com',
        audience: ['my-app'],
        jwksSource: { type: 'local' as const, keys: [] },
        claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
      };
      const result = hydrateNew(minimalInput({ policy: { identityProvider: idpConfig } }));
      const state = expectOk(result);
      expect(state.policySnapshot.identityProvider).toEqual(idpConfig);
    });
  });

  // ─── activeChecks Fallback ────────────────────────────────────────────

  describe('activeChecks resolution', () => {
    it('uses explicit activeChecks when provided', () => {
      const result = hydrateNew(minimalInput({ profile: { activeChecks: ['custom_check'] } }));
      const state = expectOk(result);
      expect(state.activeChecks).toEqual(['custom_check']);
    });

    it('uses profile activeChecks when no explicit checks given', () => {
      // profileId "baseline" has activeChecks: ['test_quality', 'rollback_safety']
      const result = hydrateNew(minimalInput({ profile: { profileId: 'baseline' } }));
      const state = expectOk(result);
      expect(state.activeChecks).toEqual(['test_quality', 'rollback_safety']);
    });

    it('falls back to default checks when no profile or explicit checks', () => {
      const result = hydrateNew(minimalInput({ profile: {} }));
      const state = expectOk(result);
      // Falls to baseline profile fallback
      expect(state.activeChecks).toContain('test_quality');
      expect(state.activeChecks).toContain('rollback_safety');
    });

    it('slice() creates a copy — not a reference to profile array (isolation)', () => {
      const result = hydrateNew(minimalInput({ profile: { profileId: 'baseline' } }));
      const state = expectOk(result);
      // Mutating returned array should not affect the profile
      const checks = state.activeChecks as string[];
      checks.push('extra');
      // Re-hydrate to verify isolation
      const result2 = hydrateNew(minimalInput({ profile: { profileId: 'baseline' } }));
      const state2 = expectOk(result2);
      expect(state2.activeChecks).not.toContain('extra');
    });
  });

  // ─── Policy Snapshot Defaults ─────────────────────────────────────────

  describe('policy snapshot defaults', () => {
    it('policySource defaults to "default" when not provided', () => {
      const result = hydrateNew(minimalInput({ policy: {} }));
      const state = expectOk(result);
      expect((state.policySnapshot as Record<string, unknown>).source).toBe('default');
    });

    it('policySource uses provided value when given', () => {
      const result = hydrateNew(minimalInput({ policy: { policySource: 'central' } }));
      const state = expectOk(result);
      expect((state.policySnapshot as Record<string, unknown>).source).toBe('central');
    });

    it('requestedPolicyMode defaults to resolved policy mode when not provided', () => {
      const result = hydrateNew(minimalInput({ policy: { policyMode: 'team' } }));
      const state = expectOk(result);
      expect(state.policySnapshot.requestedMode).toBe('team');
    });

    it('requestedPolicyMode uses explicit value when provided', () => {
      const result = hydrateNew(
        minimalInput({ policy: { policyMode: 'team', requestedPolicyMode: 'regulated' } }),
      );
      const state = expectOk(result);
      expect(state.policySnapshot.requestedMode).toBe('regulated');
    });
  });

  // ─── Discovery Defaults ───────────────────────────────────────────────

  describe('discovery field defaults', () => {
    it('discoveryDigest defaults to null when not provided', () => {
      const result = hydrateNew(minimalInput());
      const state = expectOk(result);
      expect(state.discoveryDigest).toBeNull();
    });

    it('discoveryDigest uses provided value when given', () => {
      const result = hydrateNew(minimalInput({ session: { discoveryDigest: 'sha256:abc123' } }));
      const state = expectOk(result);
      expect(state.discoveryDigest).toBe('sha256:abc123');
    });

    it('detectedStack defaults to null when not provided', () => {
      const result = hydrateNew(minimalInput());
      const state = expectOk(result);
      expect(state.detectedStack).toBeNull();
    });

    it('detectedStack uses provided value', () => {
      const stack = { languages: ['typescript'], frameworks: ['vitest'] };
      const result = hydrateNew(minimalInput({ session: { detectedStack: stack as never } }));
      const state = expectOk(result);
      expect(state.detectedStack).toEqual(stack);
    });

    it('verificationCandidates defaults to empty array when not provided', () => {
      const result = hydrateNew(minimalInput());
      const state = expectOk(result);
      expect(state.verificationCandidates).toEqual([]);
    });

    it('verificationCandidates uses provided value', () => {
      const candidates = [{ path: 'test.ts', kind: 'unit' }];
      const result = hydrateNew(
        minimalInput({ session: { verificationCandidates: candidates as never } }),
      );
      const state = expectOk(result);
      expect(state.verificationCandidates).toEqual(candidates);
    });
  });

  // ─── Profile and Actor Fields ─────────────────────────────────────────

  describe('profile and actor fields', () => {
    it('initiatedBy defaults to sessionId when not provided', () => {
      const result = hydrateNew(minimalInput());
      const state = expectOk(result);
      expect(state.initiatedBy).toBe(FIXED_SESSION_UUID);
    });

    it('initiatedBy uses provided value when given', () => {
      const result = hydrateNew(minimalInput({ profile: { initiatedBy: 'actor-123' } }));
      const state = expectOk(result);
      expect(state.initiatedBy).toBe('actor-123');
    });

    it('initiatedByIdentity is NOT present when not provided (conditional spread)', () => {
      const result = hydrateNew(minimalInput());
      const state = expectOk(result);
      expect('initiatedByIdentity' in state).toBe(false);
    });

    it('initiatedByIdentity IS present when provided', () => {
      const result = hydrateNew(
        minimalInput({ profile: { initiatedByIdentity: DECISION_IDENTITY_INITIATOR } }),
      );
      const state = expectOk(result);
      expect((state as Record<string, unknown>).initiatedByIdentity).toEqual(
        DECISION_IDENTITY_INITIATOR,
      );
    });

    it('actorInfo is NOT present when not provided (conditional spread)', () => {
      const result = hydrateNew(minimalInput());
      const state = expectOk(result);
      expect('actorInfo' in state).toBe(false);
    });

    it('actorInfo IS present when provided', () => {
      const actorInfo = { actorId: 'user-1', source: 'env' as const };
      const result = hydrateNew(minimalInput({ profile: { actorInfo: actorInfo as never } }));
      const state = expectOk(result);
      expect((state as Record<string, unknown>).actorInfo).toEqual(actorInfo);
    });
  });

  // ─── activeProfile Resolution ─────────────────────────────────────────

  describe('activeProfile resolution', () => {
    it('activeProfile is not null when profile is resolved', () => {
      const result = hydrateNew(minimalInput({ profile: { profileId: 'baseline' } }));
      const state = expectOk(result);
      expect(state.activeProfile).not.toBeNull();
      expect(state.activeProfile?.id).toBe('baseline');
    });

    it('activeProfile has ruleContent from base instructions', () => {
      const result = hydrateNew(minimalInput({ profile: { profileId: 'baseline' } }));
      const state = expectOk(result);
      expect(state.activeProfile?.ruleContent).toBeDefined();
    });

    it('phaseRuleContent present when profile has phase instructions', () => {
      // baseline profile has phase instructions
      const result = hydrateNew(minimalInput({ profile: { profileId: 'baseline' } }));
      const state = expectOk(result);
      expect(
        (state.activeProfile as Record<string, unknown> | null)?.phaseRuleContent,
      ).toBeDefined();
    });
  });

  // ─── effectiveGateBehavior ────────────────────────────────────────────

  describe('effectiveGateBehavior', () => {
    it('defaults to auto_approve for solo (requireHumanGates=false)', () => {
      const result = hydrateNew(minimalInput({ policy: { policyMode: 'solo' } }));
      const state = expectOk(result);
      expect(state.policySnapshot.effectiveGateBehavior).toBe('auto_approve');
    });

    it('defaults to human_gated for team (requireHumanGates=true)', () => {
      const result = hydrateNew(minimalInput({ policy: { policyMode: 'team' } }));
      const state = expectOk(result);
      expect(state.policySnapshot.effectiveGateBehavior).toBe('human_gated');
    });

    it('uses explicit effectiveGateBehavior when provided', () => {
      const result = hydrateNew(
        minimalInput({ policy: { policyMode: 'solo', effectiveGateBehavior: 'human_gated' } }),
      );
      const state = expectOk(result);
      expect(state.policySnapshot.effectiveGateBehavior).toBe('human_gated');
    });
  });

  // ─── discoverySummary Default ─────────────────────────────────────────

  describe('discoverySummary default', () => {
    it('discoverySummary defaults to null when not provided', () => {
      const result = hydrateNew(minimalInput());
      const state = expectOk(result);
      expect(state.discoverySummary).toBeNull();
    });

    it('discoverySummary uses provided value', () => {
      const summary = { fileCount: 10, totalLines: 1000 };
      const result = hydrateNew(minimalInput({ session: { discoverySummary: summary as never } }));
      const state = expectOk(result);
      expect(state.discoverySummary).toEqual(summary);
    });
  });
});
