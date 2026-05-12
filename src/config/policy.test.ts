import { describe, it, expect } from 'vitest';
import {
  SOLO_POLICY,
  TEAM_POLICY,
  TEAM_CI_POLICY,
  REGULATED_POLICY,
  PolicyConfigurationError,
  detectCiContext,
  getPolicyPreset,
  resolvePolicy,
  resolvePolicyWithContext,
  resolvePolicyForHydrate,
  policyModes,
  createPolicySnapshot,
  resolvePolicyFromSnapshot,
  loadCentralPolicyEvidence,
  validateExistingPolicyAgainstCentral,
} from '../config/policy.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';

// ─── Shared Constants ─────────────────────────────────────────────────────────

const POLICY_PATH = '/tmp/p.json';
const digestFn = (s: string): string => `sha256:${s.length}`;

describe('config/policy', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('getPolicyPreset returns correct preset for each mode', () => {
      expect(getPolicyPreset('solo')).toBe(SOLO_POLICY);
      expect(getPolicyPreset('team')).toBe(TEAM_POLICY);
      expect(getPolicyPreset('team-ci')).toBe(TEAM_CI_POLICY);
      expect(getPolicyPreset('regulated')).toBe(REGULATED_POLICY);
    });

    it('resolvePolicy returns correct preset for each mode', () => {
      expect(resolvePolicy('solo')).toBe(SOLO_POLICY);
      expect(resolvePolicy('team')).toBe(TEAM_POLICY);
      expect(resolvePolicy('team-ci')).toBe(TEAM_CI_POLICY);
      expect(resolvePolicy('regulated')).toBe(REGULATED_POLICY);
    });

    it('resolvePolicy vs resolvePolicyWithContext — team-ci authority is in WithContext', () => {
      expect(resolvePolicy('team-ci')).toBe(TEAM_CI_POLICY);
      const withContext = resolvePolicyWithContext('team-ci', false);
      expect(withContext.policy.mode).toBe('team-ci');
      expect(withContext.effectiveMode).toBe('team');
      expect(withContext.degradedReason).toBe('ci_context_missing');
    });

    it('resolvePolicyWithContext keeps team-ci when CI context exists', () => {
      const result = resolvePolicyWithContext('team-ci', true);
      expect(result.policy).toBe(TEAM_CI_POLICY);
      expect(result.requestedMode).toBe('team-ci');
      expect(result.effectiveMode).toBe('team-ci');
      expect(result.effectiveGateBehavior).toBe('auto_approve');
      expect(result.degradedReason).toBeUndefined();
    });

    it('resolvePolicyWithContext degrades team-ci to team without CI context', () => {
      const result = resolvePolicyWithContext('team-ci', false);
      expect(result.policy.mode).toBe('team-ci');
      expect(result.requestedMode).toBe('team-ci');
      expect(result.effectiveMode).toBe('team');
      expect(result.effectiveGateBehavior).toBe('human_gated');
      expect(result.degradedReason).toBe('ci_context_missing');
    });

    it('resolvePolicyForHydrate applies central minimum over weaker repo mode', async () => {
      const result = await resolvePolicyForHydrate({
        repoMode: 'solo',
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: '/tmp/org-policy.json',
        digestFn: (s) => `sha256:${s.length}`,
        readFileFn: async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'regulated' }),
      });

      expect(result.requestedMode).toBe('solo');
      expect(result.requestedSource).toBe('repo');
      expect(result.effectiveMode).toBe('regulated');
      expect(result.effectiveSource).toBe('central');
      expect(result.resolutionReason).toBe('repo_weaker_than_central');
      expect(result.centralEvidence?.minimumMode).toBe('regulated');
      expect(result.centralEvidence?.digest).toMatch(/^sha256:/);
    });

    it('resolvePolicyForHydrate allows explicit stronger than central with explicit source', async () => {
      const result = await resolvePolicyForHydrate({
        explicitMode: 'regulated',
        repoMode: 'team',
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: '/tmp/org-policy.json',
        digestFn: (s) => `sha256:${s.length}`,
        readFileFn: async () =>
          JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team', version: '2026.04' }),
      });

      expect(result.effectiveMode).toBe('regulated');
      expect(result.effectiveSource).toBe('explicit');
      expect(result.resolutionReason).toBe('explicit_stronger_than_central');
      expect(result.centralEvidence?.minimumMode).toBe('team');
      expect(result.centralEvidence?.version).toBe('2026.04');
    });

    it('SOLO has no human gates and 1 iteration', () => {
      expect(SOLO_POLICY.requireHumanGates).toBe(false);
      expect(SOLO_POLICY.maxSelfReviewIterations).toBe(2);
      expect(SOLO_POLICY.maxImplReviewIterations).toBe(1);
      expect(SOLO_POLICY.allowSelfApproval).toBe(true);
      expect(SOLO_POLICY.audit.emitTransitions).toBe(true);
      expect(SOLO_POLICY.audit.emitToolCalls).toBe(true);
      expect(SOLO_POLICY.audit.enableChainHash).toBe(false);
      expect(SOLO_POLICY.minimumActorAssuranceForApproval).toBe('best_effort');
      expect(SOLO_POLICY.requireVerifiedActorsForApproval).toBe(false);
      expect(SOLO_POLICY.identityProviderMode).toBe('optional');
    });

    it('TEAM has human gates and 3 iterations', () => {
      expect(TEAM_POLICY.requireHumanGates).toBe(true);
      expect(TEAM_POLICY.maxSelfReviewIterations).toBe(3);
      expect(TEAM_POLICY.maxImplReviewIterations).toBe(3);
      expect(TEAM_POLICY.allowSelfApproval).toBe(true);
      expect(TEAM_POLICY.audit.emitTransitions).toBe(true);
      expect(TEAM_POLICY.audit.emitToolCalls).toBe(true);
      expect(TEAM_POLICY.audit.enableChainHash).toBe(true);
      expect(TEAM_POLICY.minimumActorAssuranceForApproval).toBe('best_effort');
      expect(TEAM_POLICY.requireVerifiedActorsForApproval).toBe(false);
      expect(TEAM_POLICY.identityProviderMode).toBe('optional');
    });

    it('REGULATED has four-eyes enforcement', () => {
      expect(REGULATED_POLICY.allowSelfApproval).toBe(false);
      expect(REGULATED_POLICY.requireHumanGates).toBe(true);
      expect(REGULATED_POLICY.audit.enableChainHash).toBe(true);
      expect(REGULATED_POLICY.minimumActorAssuranceForApproval).toBe('best_effort');
      expect(REGULATED_POLICY.requireVerifiedActorsForApproval).toBe(false);
      expect(REGULATED_POLICY.identityProviderMode).toBe('optional');
    });

    it('TEAM-CI enables auto-approval with full audit', () => {
      expect(TEAM_CI_POLICY.requireHumanGates).toBe(false);
      expect(TEAM_CI_POLICY.maxSelfReviewIterations).toBe(3);
      expect(TEAM_CI_POLICY.maxImplReviewIterations).toBe(3);
      expect(TEAM_CI_POLICY.allowSelfApproval).toBe(true);
      expect(TEAM_CI_POLICY.audit.emitTransitions).toBe(true);
      expect(TEAM_CI_POLICY.audit.emitToolCalls).toBe(true);
      expect(TEAM_CI_POLICY.audit.enableChainHash).toBe(true);
      expect(TEAM_CI_POLICY.minimumActorAssuranceForApproval).toBe('best_effort');
      expect(TEAM_CI_POLICY.requireVerifiedActorsForApproval).toBe(false);
      expect(TEAM_CI_POLICY.identityProviderMode).toBe('optional');
    });

    it('createPolicySnapshot produces deterministic hash', () => {
      const digest = (s: string) => `hash-of-${s.length}`;
      const snap1 = createPolicySnapshot(TEAM_POLICY, '2026-01-01T00:00:00.000Z', digest);
      const snap2 = createPolicySnapshot(TEAM_POLICY, '2026-01-01T00:00:00.000Z', digest);
      expect(snap1.hash).toBe(snap2.hash);
    });

    it('policyModes returns all 4 modes', () => {
      const modes = policyModes();
      expect(modes).toContain('solo');
      expect(modes).toContain('team');
      expect(modes).toContain('team-ci');
      expect(modes).toContain('regulated');
      expect(modes.length).toBe(4);
    });

    it('all SOLO_POLICY fields match expected values', () => {
      expect(SOLO_POLICY.mode).toBe('solo');
      expect(SOLO_POLICY.requireHumanGates).toBe(false);
      expect(SOLO_POLICY.maxSelfReviewIterations).toBe(2);
      expect(SOLO_POLICY.maxImplReviewIterations).toBe(1);
      expect(SOLO_POLICY.allowSelfApproval).toBe(true);
      expect(SOLO_POLICY.audit.emitTransitions).toBe(true);
      expect(SOLO_POLICY.audit.emitToolCalls).toBe(true);
      expect(SOLO_POLICY.audit.enableChainHash).toBe(false);
      expect(SOLO_POLICY.minimumActorAssuranceForApproval).toBe('best_effort');
      expect(SOLO_POLICY.requireVerifiedActorsForApproval).toBe(false);
      expect(SOLO_POLICY.identityProviderMode).toBe('optional');
      expect(SOLO_POLICY.selfReview?.subagentEnabled).toBe(true);
      expect(SOLO_POLICY.selfReview?.fallbackToSelf).toBe(false);
      expect(SOLO_POLICY.selfReview?.strictEnforcement).toBe(true);
    });

    it('all TEAM_POLICY fields match expected values', () => {
      expect(TEAM_POLICY.mode).toBe('team');
      expect(TEAM_POLICY.requireHumanGates).toBe(true);
      expect(TEAM_POLICY.maxSelfReviewIterations).toBe(3);
      expect(TEAM_POLICY.maxImplReviewIterations).toBe(3);
      expect(TEAM_POLICY.allowSelfApproval).toBe(true);
      expect(TEAM_POLICY.audit.emitTransitions).toBe(true);
      expect(TEAM_POLICY.audit.emitToolCalls).toBe(true);
      expect(TEAM_POLICY.audit.enableChainHash).toBe(true);
      expect(TEAM_POLICY.minimumActorAssuranceForApproval).toBe('best_effort');
      expect(TEAM_POLICY.requireVerifiedActorsForApproval).toBe(false);
      expect(TEAM_POLICY.identityProviderMode).toBe('optional');
      expect(TEAM_POLICY.selfReview?.subagentEnabled).toBe(true);
      expect(TEAM_POLICY.selfReview?.fallbackToSelf).toBe(false);
      expect(TEAM_POLICY.selfReview?.strictEnforcement).toBe(true);
    });

    it('all REGULATED_POLICY fields match expected values', () => {
      expect(REGULATED_POLICY.mode).toBe('regulated');
      expect(REGULATED_POLICY.requireHumanGates).toBe(true);
      expect(REGULATED_POLICY.maxSelfReviewIterations).toBe(3);
      expect(REGULATED_POLICY.maxImplReviewIterations).toBe(3);
      expect(REGULATED_POLICY.allowSelfApproval).toBe(false);
      expect(REGULATED_POLICY.audit.emitTransitions).toBe(true);
      expect(REGULATED_POLICY.audit.emitToolCalls).toBe(true);
      expect(REGULATED_POLICY.audit.enableChainHash).toBe(true);
      expect(REGULATED_POLICY.minimumActorAssuranceForApproval).toBe('best_effort');
      expect(REGULATED_POLICY.requireVerifiedActorsForApproval).toBe(false);
      expect(REGULATED_POLICY.identityProviderMode).toBe('optional');
      expect(REGULATED_POLICY.selfReview?.subagentEnabled).toBe(true);
      expect(REGULATED_POLICY.selfReview?.fallbackToSelf).toBe(false);
      expect(REGULATED_POLICY.selfReview?.strictEnforcement).toBe(true);
    });

    it('all TEAM_CI_POLICY fields match expected values', () => {
      expect(TEAM_CI_POLICY.mode).toBe('team-ci');
      expect(TEAM_CI_POLICY.requireHumanGates).toBe(false);
      expect(TEAM_CI_POLICY.maxSelfReviewIterations).toBe(3);
      expect(TEAM_CI_POLICY.maxImplReviewIterations).toBe(3);
      expect(TEAM_CI_POLICY.allowSelfApproval).toBe(true);
      expect(TEAM_CI_POLICY.audit.emitTransitions).toBe(true);
      expect(TEAM_CI_POLICY.audit.emitToolCalls).toBe(true);
      expect(TEAM_CI_POLICY.audit.enableChainHash).toBe(true);
      expect(TEAM_CI_POLICY.minimumActorAssuranceForApproval).toBe('best_effort');
      expect(TEAM_CI_POLICY.requireVerifiedActorsForApproval).toBe(false);
      expect(TEAM_CI_POLICY.identityProviderMode).toBe('optional');
      expect(TEAM_CI_POLICY.selfReview?.subagentEnabled).toBe(true);
      expect(TEAM_CI_POLICY.selfReview?.fallbackToSelf).toBe(false);
      expect(TEAM_CI_POLICY.selfReview?.strictEnforcement).toBe(true);
    });

    it('detectCiContext recognizes common CI signals', () => {
      expect(detectCiContext({ CI: 'true' })).toBe(true);
      expect(detectCiContext({ GITHUB_ACTIONS: '1' })).toBe(true);
      expect(detectCiContext({ CI: 'false' })).toBe(false);
      expect(detectCiContext({})).toBe(false);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('resolvePolicy throws PolicyConfigurationError for unknown mode', () => {
      expect(() => resolvePolicy('enterprise')).toThrow(PolicyConfigurationError);
      expect(() => resolvePolicy('enterprise')).toThrow(/Unsupported policy mode/);
    });

    it('getPolicyPreset throws PolicyConfigurationError for unknown mode', () => {
      expect(() => getPolicyPreset('invalid')).toThrow(PolicyConfigurationError);
      expect(() => getPolicyPreset('invalid')).toThrow(/Unsupported policy mode/);
    });

    it('resolvePolicyWithContext throws PolicyConfigurationError for unknown mode', () => {
      expect(() => resolvePolicyWithContext('enterprise', false)).toThrow(PolicyConfigurationError);
      expect(() => resolvePolicyWithContext('enterprise', false)).toThrow(
        /Unsupported policy mode/,
      );
    });

    it('PolicyConfigurationError carries code and message', () => {
      try {
        resolvePolicy('typo');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PolicyConfigurationError);
        const pce = err as PolicyConfigurationError;
        expect(pce.code).toBe('INVALID_POLICY_MODE');
        expect(pce.message).toContain('typo');
        expect(pce.name).toBe('PolicyConfigurationError');
      }
    });

    it('resolvePolicyForHydrate blocks explicit weaker mode than central minimum', async () => {
      await expect(
        resolvePolicyForHydrate({
          explicitMode: 'team',
          repoMode: 'solo',
          defaultMode: 'solo',
          ciContext: false,
          centralPolicyPath: '/tmp/org-policy.json',
          digestFn: (s) => `sha256:${s.length}`,
          readFileFn: async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'regulated' }),
        }),
      ).rejects.toMatchObject({ code: 'EXPLICIT_WEAKER_THAN_CENTRAL' });
    });

    it('resolvePolicyForHydrate blocks empty central policy path when env is set', async () => {
      await expect(
        resolvePolicyForHydrate({
          defaultMode: 'solo',
          ciContext: false,
          centralPolicyPath: '',
          digestFn: (s) => `sha256:${s.length}`,
          readFileFn: async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' }),
        }),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_PATH_EMPTY' });
    });

    it('resolvePolicyForHydrate blocks whitespace central policy path when env is set', async () => {
      await expect(
        resolvePolicyForHydrate({
          defaultMode: 'solo',
          ciContext: false,
          centralPolicyPath: '   ',
          digestFn: (s) => `sha256:${s.length}`,
          readFileFn: async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' }),
        }),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_PATH_EMPTY' });
    });

    it('resolvePolicyForHydrate applies config maxSelfReviewIterations override', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        digestFn: (s) => `sha256:${s.length}`,
        configMaxSelfReviewIterations: 5,
      });
      expect(result.policy.maxSelfReviewIterations).toBe(5);
      expect(result.policy.maxImplReviewIterations).toBe(1); // preset unchanged
    });

    it('resolvePolicyForHydrate applies config maxImplReviewIterations override', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'team',
        ciContext: false,
        digestFn: (s) => `sha256:${s.length}`,
        configMaxImplReviewIterations: 10,
      });
      expect(result.policy.maxSelfReviewIterations).toBe(3); // preset unchanged
      expect(result.policy.maxImplReviewIterations).toBe(10);
    });

    it('resolvePolicyForHydrate applies both config iteration overrides', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'team',
        ciContext: false,
        digestFn: (s) => `sha256:${s.length}`,
        configMaxSelfReviewIterations: 7,
        configMaxImplReviewIterations: 14,
      });
      expect(result.policy.maxSelfReviewIterations).toBe(7);
      expect(result.policy.maxImplReviewIterations).toBe(14);
    });

    it('resolvePolicyForHydrate applies config requireVerifiedActorsForApproval override', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'regulated',
        ciContext: false,
        digestFn: (s) => `sha256:${s.length}`,
        configRequireVerifiedActorsForApproval: true,
      });
      expect(result.policy.requireVerifiedActorsForApproval).toBe(true);
    });

    it('resolvePolicyForHydrate uses preset when config undefined', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        digestFn: (s) => `sha256:${s.length}`,
      });
      expect(result.policy.maxSelfReviewIterations).toBe(2); // SOLO preset
      expect(result.policy.maxImplReviewIterations).toBe(1); // SOLO preset
    });

    it('resolvePolicyForHydrate applies config overrides with central policy', async () => {
      const result = await resolvePolicyForHydrate({
        explicitMode: 'regulated',
        defaultMode: 'team',
        ciContext: false,
        centralPolicyPath: '/tmp/org-policy.json',
        digestFn: (s) => `sha256:${s.length}`,
        readFileFn: async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' }),
        configMaxSelfReviewIterations: 8,
        configMaxImplReviewIterations: 16,
        configRequireVerifiedActorsForApproval: true,
      });
      expect(result.policy.maxSelfReviewIterations).toBe(8);
      expect(result.policy.maxImplReviewIterations).toBe(16);
      expect(result.policy.requireVerifiedActorsForApproval).toBe(true);
      expect(result.policy.minimumActorAssuranceForApproval).toBe('claim_validated');
    });

    it('resolvePolicyForHydrate wires jwks identityProvider and mode through to effective policy', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'team',
        ciContext: false,
        digestFn: (s) => `sha256:${s.length}`,
        configIdentityProvider: {
          mode: 'jwks',
          issuer: 'https://issuer.example.com',
          audience: ['flowguard'],
          claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
          jwksPath: '/etc/flowguard/jwks.json',
        },
        configIdentityProviderMode: 'required',
      });

      expect(result.policy.identityProvider).toEqual({
        mode: 'jwks',
        issuer: 'https://issuer.example.com',
        audience: ['flowguard'],
        claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
        jwksPath: '/etc/flowguard/jwks.json',
      });
      expect(result.policy.identityProviderMode).toBe('required');
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('snapshot preserves all FlowGuard-critical fields', () => {
      const digest = (s: string) => `hash-${s.length}`;
      const snap = createPolicySnapshot(REGULATED_POLICY, '2026-01-01T00:00:00.000Z', digest);
      expect(snap.mode).toBe('regulated');
      expect(snap.requireHumanGates).toBe(true);
      expect(snap.maxSelfReviewIterations).toBe(3);
      expect(snap.maxImplReviewIterations).toBe(3);
      expect(snap.allowSelfApproval).toBe(false);
      expect(snap.audit.enableChainHash).toBe(true);
      expect(snap.actorClassification).toEqual(REGULATED_POLICY.actorClassification);
      expect(snap.identityProviderMode).toBe('optional');
    });

    it('resolvePolicyFromSnapshot restores typed jwks identityProvider from snapshot only', () => {
      const digest = (s: string) => `hash-${s.length}`;
      const snap = {
        ...createPolicySnapshot(TEAM_POLICY, '2026-01-01T00:00:00.000Z', digest),
        identityProvider: {
          mode: 'jwks' as const,
          issuer: 'https://issuer.example.com',
          audience: ['flowguard'],
          claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
          jwksPath: '/etc/flowguard/jwks.json',
        },
        identityProviderMode: 'required' as const,
      };

      const reconstructed = resolvePolicyFromSnapshot(snap);
      expect(reconstructed.identityProvider).toEqual(snap.identityProvider);
      expect(reconstructed.identityProviderMode).toBe('required');
    });

    it('different policies produce different hashes', () => {
      const digest = (s: string) => `hash-${s}`;
      const solo = createPolicySnapshot(SOLO_POLICY, '2026-01-01T00:00:00.000Z', digest);
      const team = createPolicySnapshot(TEAM_POLICY, '2026-01-01T00:00:00.000Z', digest);
      expect(solo.hash).not.toBe(team.hash);
    });

    it('resolvePolicyFromSnapshot reconstructs actorClassification from snapshot only', () => {
      const digest = (s: string) => `hash-${s.length}`;
      const snap = createPolicySnapshot(REGULATED_POLICY, '2026-01-01T00:00:00.000Z', digest);
      const reconstructed = resolvePolicyFromSnapshot(snap);
      expect(reconstructed.actorClassification).toEqual(REGULATED_POLICY.actorClassification);
      expect(reconstructed.actorClassification).toEqual(snap.actorClassification);
    });

    it('resolvePolicyFromSnapshot uses snapshot fields exclusively — no preset leak', () => {
      const digest = (s: string) => `hash-${s.length}`;
      // Create a snapshot with modified actorClassification
      const snap = {
        ...createPolicySnapshot(TEAM_POLICY, '2026-01-01T00:00:00.000Z', digest),
        actorClassification: { custom_tool: 'auditor' },
      };
      const reconstructed = resolvePolicyFromSnapshot(snap);
      // Must use snapshot value, not preset
      expect(reconstructed.actorClassification).toEqual({ custom_tool: 'auditor' });
    });

    it('snapshot includes requestedMode and effectiveGateBehavior', () => {
      const digest = (s: string) => `hash-${s.length}`;
      const snap = createPolicySnapshot(TEAM_POLICY, '2026-01-01T00:00:00.000Z', digest, {
        requestedMode: 'team-ci',
        effectiveGateBehavior: 'human_gated',
        degradedReason: 'ci_context_missing',
      });
      expect(snap.requestedMode).toBe('team-ci');
      expect(snap.effectiveGateBehavior).toBe('human_gated');
      expect(snap.degradedReason).toBe('ci_context_missing');
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('SOLO disables hash chain', () => {
      expect(SOLO_POLICY.audit.enableChainHash).toBe(false);
    });

    it('TEAM and REGULATED enable hash chain', () => {
      expect(TEAM_POLICY.audit.enableChainHash).toBe(true);
      expect(REGULATED_POLICY.audit.enableChainHash).toBe(true);
    });

    it('all policies emit transitions and tool calls', () => {
      for (const p of [SOLO_POLICY, TEAM_POLICY, REGULATED_POLICY]) {
        expect(p.audit.emitTransitions).toBe(true);
        expect(p.audit.emitToolCalls).toBe(true);
      }
    });

    it('resolvePolicyWithContext preserves requested/effective equality for regulated', () => {
      const result = resolvePolicyWithContext('regulated', false);
      expect(result.requestedMode).toBe('regulated');
      expect(result.effectiveMode).toBe('regulated');
      expect(result.effectiveGateBehavior).toBe('human_gated');
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it(`resolvePolicy < ${PERF_BUDGETS.guardPredicateMs}ms (p99)`, () => {
      const result = benchmarkSync(() => resolvePolicy('team'));
      expect(result.p99Ms).toBeLessThan(PERF_BUDGETS.guardPredicateMs);
    });
  });

  // ─── MUTATION KILL: detectCiContext / isTruthyEnv ──────────
  describe('MUTATION: isTruthyEnv', () => {
    it('CI=0 is falsy', () => {
      expect(detectCiContext({ CI: '0' })).toBe(false);
    });

    it('CI=no is falsy', () => {
      expect(detectCiContext({ CI: 'no' })).toBe(false);
    });

    it('CI=off is falsy', () => {
      expect(detectCiContext({ CI: 'off' })).toBe(false);
    });

    it('CI=FALSE (uppercase) is falsy — tests toLowerCase', () => {
      expect(detectCiContext({ CI: 'FALSE' })).toBe(false);
    });

    it('CI=NO (uppercase) is falsy — tests toLowerCase', () => {
      expect(detectCiContext({ CI: 'NO' })).toBe(false);
    });

    it('CI=OFF (uppercase) is falsy — tests toLowerCase', () => {
      expect(detectCiContext({ CI: 'OFF' })).toBe(false);
    });

    it('CI with surrounding whitespace is truthy when trimmed value is truthy', () => {
      expect(detectCiContext({ CI: ' true ' })).toBe(true);
    });

    it('CI with surrounding whitespace is falsy when trimmed value is false', () => {
      expect(detectCiContext({ CI: ' false ' })).toBe(false);
    });
  });

  // ─── MUTATION KILL: validateExistingPolicyAgainstCentral ───
  describe('MUTATION: validateExistingPolicyAgainstCentral', () => {
    it('passes when existingMode equals central minimum (boundary)', async () => {
      const result = await validateExistingPolicyAgainstCentral({
        existingMode: 'team',
        centralPolicyPath: '/tmp/org-policy.json',
        digestFn: (s) => `sha256:${s.length}`,
        readFileFn: async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' }),
      });
      expect(result).toBeDefined();
      expect(result!.minimumMode).toBe('team');
    });

    it('throws when existingMode is weaker with descriptive message', async () => {
      await expect(
        validateExistingPolicyAgainstCentral({
          existingMode: 'solo',
          centralPolicyPath: '/tmp/org-policy.json',
          digestFn: (s) => `sha256:${s.length}`,
          readFileFn: async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' }),
        }),
      ).rejects.toThrow(/solo.*weaker.*team/i);
    });

    it('returns undefined when no central policy path', async () => {
      const result = await validateExistingPolicyAgainstCentral({
        existingMode: 'solo',
        digestFn: (s) => s,
      });
      expect(result).toBeUndefined();
    });
  });

  // ─── MUTATION KILL: loadCentralPolicyEvidence ──────────────
  describe('MUTATION: loadCentralPolicyEvidence', () => {
    it('throws CENTRAL_POLICY_INVALID_JSON for malformed JSON', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => 'not-json{{{',
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_INVALID_JSON' });
    });

    it('throws CENTRAL_POLICY_INVALID_SCHEMA for JSON null', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => 'null',
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_INVALID_SCHEMA' });
    });

    it('throws CENTRAL_POLICY_INVALID_SCHEMA for JSON string', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => '"hello"',
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_INVALID_SCHEMA' });
    });

    it('throws CENTRAL_POLICY_INVALID_SCHEMA for JSON array', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => '[]',
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_INVALID_SCHEMA' });
    });

    it('throws CENTRAL_POLICY_INVALID_SCHEMA for wrong schemaVersion', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => JSON.stringify({ schemaVersion: 'v2', minimumMode: 'solo' }),
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_INVALID_SCHEMA' });
    });

    it('throws CENTRAL_POLICY_INVALID_MODE for invalid minimumMode', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'enterprise' }),
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_INVALID_MODE' });
    });

    it('throws CENTRAL_POLICY_INVALID_SCHEMA for non-string version', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team', version: 123 }),
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_INVALID_SCHEMA' });
    });

    it('throws CENTRAL_POLICY_INVALID_SCHEMA for non-string policyId', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team', policyId: 42 }),
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_INVALID_SCHEMA' });
    });

    it('includes version in evidence when provided as string', async () => {
      const result = await loadCentralPolicyEvidence(
        POLICY_PATH,
        (s) => `sha256:${s.length}`,
        async () =>
          JSON.stringify({ schemaVersion: 'v1', minimumMode: 'solo', version: '2026.04' }),
      );
      expect(result.version).toBe('2026.04');
    });

    it('pathHint contains basename of the policy file', async () => {
      const result = await loadCentralPolicyEvidence(
        '/var/lib/flowguard/org-policy.json',
        (s) => `sha256:${s.length}`,
        async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'solo' }),
      );
      expect(result.pathHint).toBe('basename:org-policy.json');
    });

    it('throws CENTRAL_POLICY_PATH_EMPTY for empty path', async () => {
      await expect(
        loadCentralPolicyEvidence(
          '',
          (s) => s,
          async () => '{}',
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_PATH_EMPTY' });
    });

    it('throws CENTRAL_POLICY_MISSING for ENOENT error', async () => {
      await expect(
        loadCentralPolicyEvidence(
          '/tmp/missing.json',
          (s) => s,
          async () => {
            const err = new Error('ENOENT') as Error & { code: string };
            err.code = 'ENOENT';
            throw err;
          },
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_MISSING' });
    });

    it('throws CENTRAL_POLICY_UNREADABLE for non-ENOENT error', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => {
            const err = new Error('Permission denied') as Error & { code: string };
            err.code = 'EACCES';
            throw err;
          },
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_UNREADABLE' });
    });

    it('throws CENTRAL_POLICY_UNREADABLE for error without code', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => {
            throw new Error('Something went wrong');
          },
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_UNREADABLE' });
    });

    it('computes digest from raw file content', async () => {
      const raw = JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' });
      const result = await loadCentralPolicyEvidence(
        POLICY_PATH,
        (s) => `sha256:${s}`,
        async () => raw,
      );
      expect(result.digest).toBe(`sha256:${raw}`);
    });
  });

  // ─── MUTATION KILL: resolvePolicyForHydrate central logic ──
  describe('MUTATION: resolvePolicyForHydrate central', () => {
    const centralTeam = JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' });
    const centralRegulated = JSON.stringify({
      schemaVersion: 'v1',
      minimumMode: 'regulated',
    });
    const centralSolo = JSON.stringify({ schemaVersion: 'v1', minimumMode: 'solo' });

    it('explicit mode equal to central minimum: no error, no resolutionReason', async () => {
      const result = await resolvePolicyForHydrate({
        explicitMode: 'team',
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralTeam,
      });
      expect(result.effectiveMode).toBe('team');
      expect(result.effectiveSource).toBe('explicit');
      expect(result.resolutionReason).toBeUndefined();
    });

    it('explicit weaker than central throws EXPLICIT_WEAKER_THAN_CENTRAL with message', async () => {
      await expect(
        resolvePolicyForHydrate({
          explicitMode: 'solo',
          defaultMode: 'solo',
          ciContext: false,
          centralPolicyPath: POLICY_PATH,
          digestFn,
          readFileFn: async () => centralTeam,
        }),
      ).rejects.toThrow(/solo.*weaker.*team/i);
    });

    it('explicit stronger than central sets resolutionReason', async () => {
      const result = await resolvePolicyForHydrate({
        explicitMode: 'regulated',
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralSolo,
      });
      expect(result.effectiveMode).toBe('regulated');
      expect(result.effectiveSource).toBe('explicit');
      expect(result.resolutionReason).toBe('explicit_stronger_than_central');
    });

    it('repo mode equal to central: no resolutionReason', async () => {
      const result = await resolvePolicyForHydrate({
        repoMode: 'team',
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralTeam,
      });
      expect(result.effectiveMode).toBe('team');
      expect(result.effectiveSource).toBe('repo');
      expect(result.resolutionReason).toBeUndefined();
    });

    it('default weaker than central sets default_weaker_than_central', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
      });
      expect(result.effectiveMode).toBe('regulated');
      expect(result.effectiveSource).toBe('central');
      expect(result.resolutionReason).toBe('default_weaker_than_central');
    });

    it('repo weaker than central sets repo_weaker_than_central', async () => {
      const result = await resolvePolicyForHydrate({
        repoMode: 'solo',
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
      });
      expect(result.effectiveMode).toBe('regulated');
      expect(result.effectiveSource).toBe('central');
      expect(result.resolutionReason).toBe('repo_weaker_than_central');
    });

    it('config overrides wired through to central-elevated policy', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
        configMaxSelfReviewIterations: 10,
        configMaxImplReviewIterations: 20,
        configRequireVerifiedActorsForApproval: true,
        configIdentityProvider: {
          mode: 'jwks',
          issuer: 'https://idp.example.com',
          audience: ['flowguard'],
          claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
          jwksPath: '/etc/jwks.json',
        },
        configIdentityProviderMode: 'required',
      });
      expect(result.policy.maxSelfReviewIterations).toBe(10);
      expect(result.policy.maxImplReviewIterations).toBe(20);
      expect(result.policy.requireVerifiedActorsForApproval).toBe(true);
      expect(result.policy.minimumActorAssuranceForApproval).toBe('claim_validated');
      expect(result.policy.identityProvider?.mode).toBe('jwks');
      expect(result.policy.identityProviderMode).toBe('required');
    });

    it('legacy requireVerifiedActors translates to claim_validated on central path', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
        configRequireVerifiedActorsForApproval: true,
      });
      expect(result.policy.minimumActorAssuranceForApproval).toBe('claim_validated');
    });

    it('configMinimumActorAssurance takes priority over legacy boolean on central path', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
        configMinimumActorAssuranceForApproval: 'idp_verified',
        configRequireVerifiedActorsForApproval: true,
      });
      expect(result.policy.minimumActorAssuranceForApproval).toBe('idp_verified');
    });

    it('centralEvidence included in result when central policy resolved', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
      });
      expect(result.centralEvidence).toBeDefined();
      expect(result.centralEvidence!.minimumMode).toBe('regulated');
      expect(result.centralEvidence!.pathHint).toContain('p.json');
    });

    it('idp config wired through when central upgrades to higher mode', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
        configIdentityProvider: {
          mode: 'jwks',
          issuer: 'https://idp',
          audience: ['fg'],
          claimMapping: { subjectClaim: 'sub' },
          jwksPath: '/etc/jwks.json',
        },
      });
      expect(result.policy.identityProvider).toBeDefined();
      expect(result.policy.identityProvider!.issuer).toBe('https://idp');
    });
  });

  // ─── MUTATION KILL: preset field values via function exercise ──
  describe('MUTATION: preset fields via resolvePolicyWithContext', () => {
    it('solo preset: actorClassification decision is system', () => {
      const r = resolvePolicyWithContext('solo', false);
      expect(r.policy.actorClassification).toEqual({ flowguard_decision: 'system' });
    });

    it('team preset: actorClassification decision is human', () => {
      const r = resolvePolicyWithContext('team', false);
      expect(r.policy.actorClassification).toEqual({ flowguard_decision: 'human' });
    });

    it('team-ci preset: actorClassification decision is system', () => {
      const r = resolvePolicyWithContext('team-ci', true);
      expect(r.policy.actorClassification).toEqual({ flowguard_decision: 'system' });
    });

    it('regulated preset: actorClassification includes abort_session as human', () => {
      const r = resolvePolicyWithContext('regulated', false);
      expect(r.policy.actorClassification).toEqual({
        flowguard_decision: 'human',
        flowguard_abort_session: 'human',
      });
    });

    it('solo selfReview is default config', () => {
      const r = resolvePolicyWithContext('solo', false);
      expect(r.policy.selfReview.subagentEnabled).toBe(true);
      expect(r.policy.selfReview.fallbackToSelf).toBe(false);
      expect(r.policy.selfReview.strictEnforcement).toBe(true);
    });

    it('solo identityProvider is undefined', () => {
      const r = resolvePolicyWithContext('solo', false);
      expect(r.policy.identityProvider).toBeUndefined();
    });

    it('team identityProvider is undefined', () => {
      const r = resolvePolicyWithContext('team', false);
      expect(r.policy.identityProvider).toBeUndefined();
    });

    it('regulated identityProvider is undefined', () => {
      const r = resolvePolicyWithContext('regulated', false);
      expect(r.policy.identityProvider).toBeUndefined();
    });
  });

  // ─── MUTATION KILL: error message content assertions ──────────
  describe('MUTATION: error message strings', () => {
    it('validateExistingPolicyAgainstCentral error message mentions both modes', async () => {
      const centralTeam = JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' });
      await expect(
        validateExistingPolicyAgainstCentral({
          existingMode: 'solo',
          centralPolicyPath: POLICY_PATH,
          digestFn,
          readFileFn: async () => centralTeam,
        }),
      ).rejects.toThrow(/solo.*weaker.*team/i);
    });

    it('central policy invalid mode error includes the invalid mode value', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () =>
          JSON.stringify({ schemaVersion: 'v1', minimumMode: 'enterprise' }),
        ),
      ).rejects.toThrow(/enterprise/);
    });

    it('central policy invalid JSON error says "not valid JSON"', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => '{broken'),
      ).rejects.toThrow(/not valid JSON/);
    });

    it('central policy non-object error says "must be a JSON object"', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => '"hello"'),
      ).rejects.toThrow(/must be a JSON object/);
    });

    it('central policy wrong schemaVersion error mentions "v1"', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () =>
          JSON.stringify({ schemaVersion: 'v2', minimumMode: 'team' }),
        ),
      ).rejects.toThrow(/schemaVersion.*"v1"/);
    });

    it('central policy numeric version error says "version must be a string"', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () =>
          JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team', version: 123 }),
        ),
      ).rejects.toThrow(/version must be a string/);
    });

    it('central policy numeric policyId error says "policyId must be a string"', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () =>
          JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team', policyId: 42 }),
        ),
      ).rejects.toThrow(/policyId must be a string/);
    });

    it('empty path error says "FLOWGUARD_POLICY_PATH is set but empty"', async () => {
      await expect(loadCentralPolicyEvidence('   ', digestFn, async () => '{}')).rejects.toThrow(
        /FLOWGUARD_POLICY_PATH is set but empty/,
      );
    });

    it('non-Error throw produces error message via String()', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => {
          throw 'raw string error';
        }),
      ).rejects.toThrow(/raw string error/);
    });

    it('read failure error message includes path and error text', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => {
          throw new Error('disk failure');
        }),
      ).rejects.toThrow(/cannot be read.*disk failure/i);
    });
  });

  // ─── MUTATION KILL: parseCentralPolicyBundle conditional paths ─
  describe('MUTATION: parseCentralPolicyBundle conditional spreads', () => {
    it('JSON number triggers CENTRAL_POLICY_INVALID_SCHEMA', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => '42'),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_INVALID_SCHEMA' });
    });

    it('parses correctly when policyId is present (non-exposed field)', async () => {
      const raw = JSON.stringify({
        schemaVersion: 'v1',
        minimumMode: 'solo',
        policyId: 'org-policy-001',
      });
      const result = await loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => raw);
      expect(result.minimumMode).toBe('solo');
    });

    it('version string passes through to evidence', async () => {
      const raw = JSON.stringify({
        schemaVersion: 'v1',
        minimumMode: 'team',
        version: '2026.1',
        policyId: 'test-pol',
      });
      const result = await loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => raw);
      expect(result.version).toBe('2026.1');
    });

    it('absent policyId does not produce undefined policyId field', async () => {
      const raw = JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' });
      const result = await loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => raw);
      expect(result).not.toHaveProperty('policyId');
    });

    it('absent version does not produce undefined version field', async () => {
      const raw = JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' });
      const result = await loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => raw);
      expect(result).not.toHaveProperty('version');
    });

    it('modeStrength: team equals central team (no error)', async () => {
      const result = await resolvePolicyForHydrate({
        explicitMode: 'team',
        defaultMode: 'solo',
        ciContext: true,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' }),
      });
      expect(result.effectiveMode).toBe('team');
    });

    it('modeStrength: team-ci equals central team (no error)', async () => {
      const result = await resolvePolicyForHydrate({
        explicitMode: 'team-ci',
        defaultMode: 'solo',
        ciContext: true,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' }),
      });
      expect(result.effectiveMode).toBe('team-ci');
    });

    it('read error without code property maps to CENTRAL_POLICY_UNREADABLE', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => {
          const e = { message: 'fail', code: 'EPERM' };
          throw e;
        }),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_UNREADABLE' });
    });

    it('read error with code ENOENT maps to CENTRAL_POLICY_MISSING', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => {
          const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
          throw err;
        }),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_MISSING' });
    });

    it('valid string policyId does not throw', async () => {
      const result = await loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () =>
        JSON.stringify({ schemaVersion: 'v1', minimumMode: 'solo', policyId: 'valid-id' }),
      );
      expect(result.minimumMode).toBe('solo');
    });
  });

  // ─── MUTATION KILL: resolvePolicyForHydrate legacy & conditional spreads ──
  describe('MUTATION: resolvePolicyForHydrate legacy & conditional spreads', () => {
    const centralRegulated = JSON.stringify({ schemaVersion: 'v1', minimumMode: 'regulated' });
    const centralSolo = JSON.stringify({ schemaVersion: 'v1', minimumMode: 'solo' });

    it('legacy requireVerifiedActors=false does NOT produce claim_validated (local)', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        digestFn,
        configRequireVerifiedActorsForApproval: false,
      });
      expect(result.policy.minimumActorAssuranceForApproval).toBe('best_effort');
    });

    it('legacy requireVerifiedActors=true produces claim_validated (local)', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        digestFn,
        configRequireVerifiedActorsForApproval: true,
      });
      expect(result.policy.minimumActorAssuranceForApproval).toBe('claim_validated');
    });

    it('legacy requireVerifiedActors=false does NOT produce claim_validated (central)', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
        configRequireVerifiedActorsForApproval: false,
      });
      expect(result.policy.minimumActorAssuranceForApproval).toBe('best_effort');
    });

    it('legacy requireVerifiedActors=true produces claim_validated (central)', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
        configRequireVerifiedActorsForApproval: true,
      });
      expect(result.policy.minimumActorAssuranceForApproval).toBe('claim_validated');
    });

    it('explicit equal to central does NOT set resolutionReason', async () => {
      const result = await resolvePolicyForHydrate({
        explicitMode: 'regulated',
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
      });
      expect(result.resolutionReason).toBeUndefined();
    });

    it('explicit stronger than central DOES set resolutionReason', async () => {
      const result = await resolvePolicyForHydrate({
        explicitMode: 'regulated',
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralSolo,
      });
      expect(result.resolutionReason).toBe('explicit_stronger_than_central');
    });

    it('repo stronger than central does NOT set resolutionReason', async () => {
      const result = await resolvePolicyForHydrate({
        repoMode: 'regulated',
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralSolo,
      });
      expect(result.resolutionReason).toBeUndefined();
    });

    it('explicit team is weaker than central regulated → throws', async () => {
      await expect(
        resolvePolicyForHydrate({
          explicitMode: 'team',
          defaultMode: 'solo',
          ciContext: false,
          centralPolicyPath: POLICY_PATH,
          digestFn,
          readFileFn: async () => centralRegulated,
        }),
      ).rejects.toMatchObject({ code: 'EXPLICIT_WEAKER_THAN_CENTRAL' });
    });

    it('explicit team-ci is weaker than central regulated → throws', async () => {
      await expect(
        resolvePolicyForHydrate({
          explicitMode: 'team-ci',
          defaultMode: 'solo',
          ciContext: true,
          centralPolicyPath: POLICY_PATH,
          digestFn,
          readFileFn: async () => centralRegulated,
        }),
      ).rejects.toMatchObject({ code: 'EXPLICIT_WEAKER_THAN_CENTRAL' });
    });

    it('validateExistingPolicyAgainstCentral has correct error code', async () => {
      const centralTeam = JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' });
      await expect(
        validateExistingPolicyAgainstCentral({
          existingMode: 'solo',
          centralPolicyPath: POLICY_PATH,
          digestFn,
          readFileFn: async () => centralTeam,
        }),
      ).rejects.toMatchObject({ code: 'EXISTING_POLICY_WEAKER_THAN_CENTRAL' });
    });

    it('loadCentralPolicyEvidence non-Error throw with code produces CENTRAL_POLICY_UNREADABLE and includes path', async () => {
      const rejection = loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => {
        throw { code: 'EPERM', message: 'permission denied' };
      });
      await expect(rejection).rejects.toMatchObject({ code: 'CENTRAL_POLICY_UNREADABLE' });
      await expect(rejection).rejects.toThrow(/p\.json/);
    });

    it('loadCentralPolicyEvidence non-Error throw message includes stringified error', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => {
          throw 'plain string failure';
        }),
      ).rejects.toThrow(/plain string failure/);
    });
  });
});
