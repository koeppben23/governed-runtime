import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  SOLO_POLICY,
  TEAM_POLICY,
  TEAM_CI_POLICY,
  REGULATED_POLICY,
  PolicyConfigurationError,
  detectCiContext,
  getPolicyPreset,
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
  describe('HAPPY', () => {
    it('getPolicyPreset returns correct preset for each mode', () => {
      expect(getPolicyPreset('solo')).toBe(SOLO_POLICY);
      expect(getPolicyPreset('team')).toBe(TEAM_POLICY);
      expect(getPolicyPreset('team-ci')).toBe(TEAM_CI_POLICY);
      expect(getPolicyPreset('regulated')).toBe(REGULATED_POLICY);
    });

    it('getPolicyPreset returns correct preset for each mode', () => {
      expect(getPolicyPreset('solo')).toBe(SOLO_POLICY);
      expect(getPolicyPreset('team')).toBe(TEAM_POLICY);
      expect(getPolicyPreset('team-ci')).toBe(TEAM_CI_POLICY);
      expect(getPolicyPreset('regulated')).toBe(REGULATED_POLICY);
    });

    it('getPolicyPreset vs resolvePolicyWithContext — team-ci authority is in WithContext', () => {
      expect(getPolicyPreset('team-ci')).toBe(TEAM_CI_POLICY);
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

    it('resolvePolicyForHydrate threads configValidationEvidence into the frozen snapshot (#400)', async () => {
      // Falsification of the config→resolver→snapshot path: a team base defaults to
      // validationEvidence off; an explicit config override must survive resolution
      // AND land in the frozen policy snapshot operators actually run under.
      const result = await resolvePolicyForHydrate({
        repoMode: 'team',
        defaultMode: 'solo',
        ciContext: false,
        digestFn,
        configValidationEvidence: { enforcement: 'required', allowNoCommands: true },
      });

      // Override reflected in the resolved policy.
      expect(result.policy.validationEvidence).toEqual({
        enforcement: 'required',
        allowNoCommands: true,
      });

      // And preserved through snapshot freezing.
      const snap = createPolicySnapshot(result.policy, '2026-01-01T00:00:00.000Z', digestFn);
      expect(snap.validationEvidence).toEqual({
        enforcement: 'required',
        allowNoCommands: true,
      });
    });

    it('resolvePolicyForHydrate partial configValidationEvidence merges onto preset default (#400)', async () => {
      // Only enforcement overridden; allowNoCommands must fall back to the preset
      // default (false), preserving the fail-closed posture.
      const result = await resolvePolicyForHydrate({
        explicitMode: 'regulated',
        defaultMode: 'solo',
        ciContext: false,
        digestFn,
        configValidationEvidence: { enforcement: 'advisory' },
      });

      expect(result.policy.validationEvidence).toEqual({
        enforcement: 'advisory',
        allowNoCommands: false,
      });
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
      expect(SOLO_POLICY.enforceRiskClassification).toBe(false);
      expect(SOLO_POLICY.allowRiskDowngradeOverride).toBe(false);
      expect(SOLO_POLICY.allowReducedCeremony).toBe(false);
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
      expect(TEAM_POLICY.enforceRiskClassification).toBe(false);
      expect(TEAM_POLICY.allowRiskDowngradeOverride).toBe(false);
      expect(TEAM_POLICY.allowReducedCeremony).toBe(false);
    });

    it('REGULATED has four-eyes enforcement', () => {
      expect(REGULATED_POLICY.allowSelfApproval).toBe(false);
      expect(REGULATED_POLICY.requireHumanGates).toBe(true);
      expect(REGULATED_POLICY.audit.enableChainHash).toBe(true);
      expect(REGULATED_POLICY.minimumActorAssuranceForApproval).toBe('claim_validated');
      expect(REGULATED_POLICY.requireVerifiedActorsForApproval).toBe(false);
      expect(REGULATED_POLICY.identityProviderMode).toBe('optional');
      expect(REGULATED_POLICY.enforceRiskClassification).toBe(true);
      expect(REGULATED_POLICY.allowRiskDowngradeOverride).toBe(false);
      expect(REGULATED_POLICY.allowReducedCeremony).toBe(false);
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
      expect(TEAM_CI_POLICY.enforceRiskClassification).toBe(true);
      expect(TEAM_CI_POLICY.allowRiskDowngradeOverride).toBe(false);
      expect(TEAM_CI_POLICY.allowReducedCeremony).toBe(false);
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
      expect(REGULATED_POLICY.minimumActorAssuranceForApproval).toBe('claim_validated');
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

  describe('BAD', () => {
    it('getPolicyPreset throws PolicyConfigurationError for unknown mode', () => {
      expect(() => getPolicyPreset('enterprise')).toThrow(PolicyConfigurationError);
      expect(() => getPolicyPreset('enterprise')).toThrow(/Unsupported policy mode/);
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
        getPolicyPreset('typo');
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
          cacheTtlSeconds: 300,
        },
        configIdentityProviderMode: 'required',
      });

      expect(result.policy.identityProvider).toEqual({
        mode: 'jwks',
        issuer: 'https://issuer.example.com',
        audience: ['flowguard'],
        claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
        jwksPath: '/etc/flowguard/jwks.json',
        cacheTtlSeconds: 300,
      });
      expect(result.policy.identityProviderMode).toBe('required');
    });
  });

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
          cacheTtlSeconds: 300,
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

  describe('PERF', () => {
    it(`getPolicyPreset < ${PERF_BUDGETS.guardPredicateMs}ms (p99)`, () => {
      const result = benchmarkSync(() => getPolicyPreset('team'));
      expect(result.p99Ms).toBeLessThan(PERF_BUDGETS.guardPredicateMs);
    });
  });

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

    it('solo preset: validationEvidence off (#400)', () => {
      const r = resolvePolicyWithContext('solo', false);
      expect(r.policy.validationEvidence).toEqual({ enforcement: 'off', allowNoCommands: false });
    });

    it('team preset: validationEvidence off (#400)', () => {
      const r = resolvePolicyWithContext('team', false);
      expect(r.policy.validationEvidence).toEqual({ enforcement: 'off', allowNoCommands: false });
    });

    it('team-ci preset: validationEvidence required, fail-closed (#400)', () => {
      const r = resolvePolicyWithContext('team-ci', true);
      expect(r.policy.validationEvidence).toEqual({
        enforcement: 'required',
        allowNoCommands: false,
      });
    });

    it('regulated preset: validationEvidence required, fail-closed (#400)', () => {
      const r = resolvePolicyWithContext('regulated', false);
      expect(r.policy.validationEvidence).toEqual({
        enforcement: 'required',
        allowNoCommands: false,
      });
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
});

describe('policy barrel guard', () => {
  it('ARCHITECTURE: resolvePolicy is not exported or callable from policy modules', () => {
    const files = [
      'src/index.ts',
      'src/config/index.ts',
      'src/config/policy.ts',
      'src/config/policy-presets.ts',
    ];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (/\bresolvePolicy\b/.test(line)) {
          expect(line).toMatch(/resolvePolicyFrom|resolvePolicyWith|resolvePolicyFor/);
        }
      }
    }
  });
});
