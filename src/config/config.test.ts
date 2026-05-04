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
  resolveRuntimePolicyMode,
  policyModes,
  createPolicySnapshot,
  resolvePolicyFromSnapshot,
  loadCentralPolicyEvidence,
  validateExistingPolicyAgainstCentral,
} from '../config/policy.js';
import { COMMANDS } from '../cli/templates.js';
import {
  ProfileRegistry,
  baselineProfile,
  javaProfile,
  angularProfile,
  typescriptProfile,
  defaultProfileRegistry,
  resolveProfileInstructions,
  extractBaseInstructions,
  extractByPhaseInstructions,
} from '../config/profile.js';
import type { RepoSignals, PhaseInstructions, CheckExecutor } from '../config/profile.js';
import { BlockedReasonRegistry, defaultReasonRegistry, blocked } from '../config/reasons.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';
import { makeState, makeProgressedState, PLAN_RECORD, IMPL_EVIDENCE } from '../__fixtures__.js';
import type { SessionState } from '../state/schema.js';
import type { PlanEvidence, PlanRecord } from '../state/evidence.js';

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

describe('config/profile', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('defaultProfileRegistry has 4 built-in profiles', () => {
      expect(defaultProfileRegistry.size).toBe(4);
    });

    it('baseline profile detected with lowest confidence', () => {
      const signals: RepoSignals = { files: [], packageFiles: [], configFiles: [] };
      expect(baselineProfile.detect!({ repoSignals: signals })).toBe(0.1);
    });

    it('java profile detected by pom.xml', () => {
      const signals: RepoSignals = { files: [], packageFiles: ['pom.xml'], configFiles: [] };
      expect(javaProfile.detect!({ repoSignals: signals })).toBe(0.8);
    });

    it('angular profile detected by angular.json', () => {
      const signals: RepoSignals = { files: [], packageFiles: [], configFiles: ['angular.json'] };
      expect(angularProfile.detect!({ repoSignals: signals })).toBe(0.85);
    });

    it('typescript profile detected by tsconfig.json', () => {
      const signals: RepoSignals = { files: [], packageFiles: [], configFiles: ['tsconfig.json'] };
      expect(typescriptProfile.detect!({ repoSignals: signals })).toBe(0.7);
    });

    it('defaultProfileRegistry.detect picks highest confidence', () => {
      // Both angular.json and tsconfig.json present → angular wins (0.85 > 0.7)
      const signals: RepoSignals = {
        files: [],
        packageFiles: [],
        configFiles: ['angular.json', 'tsconfig.json'],
      };
      const detected = defaultProfileRegistry.detect({ repoSignals: signals });
      expect(detected?.id).toBe('frontend-angular');
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('get returns undefined for unknown profile ID', () => {
      expect(defaultProfileRegistry.get('unknown-stack')).toBeUndefined();
    });

    it('detect returns undefined when no profile matches', () => {
      const registry = new ProfileRegistry();
      const signals: RepoSignals = { files: [], packageFiles: [], configFiles: [] };
      expect(registry.detect({ repoSignals: signals })).toBeUndefined();
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('java profile detects build.gradle.kts', () => {
      const signals: RepoSignals = {
        files: [],
        packageFiles: ['build.gradle.kts'],
        configFiles: [],
      };
      expect(javaProfile.detect!({ repoSignals: signals })).toBe(0.8);
    });

    it('angular profile detects nx.json', () => {
      const signals: RepoSignals = { files: [], packageFiles: [], configFiles: ['nx.json'] };
      expect(angularProfile.detect!({ repoSignals: signals })).toBe(0.85);
    });

    it('no matching signals → detect returns only baseline (via confidence > 0)', () => {
      const signals: RepoSignals = { files: ['readme.md'], packageFiles: [], configFiles: [] };
      const detected = defaultProfileRegistry.detect({ repoSignals: signals });
      expect(detected?.id).toBe('baseline');
    });

    it('register overwrites existing profile', () => {
      const registry = new ProfileRegistry();
      registry.register({ id: 'test', name: 'Test 1', activeChecks: [], checks: new Map() });
      registry.register({ id: 'test', name: 'Test 2', activeChecks: [], checks: new Map() });
      expect(registry.get('test')?.name).toBe('Test 2');
      expect(registry.size).toBe(1);
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('profile without detect function cannot be auto-detected', () => {
      const registry = new ProfileRegistry();
      registry.register({ id: 'manual', name: 'Manual', activeChecks: [], checks: new Map() });
      const signals: RepoSignals = { files: [], packageFiles: [], configFiles: [] };
      expect(registry.detect({ repoSignals: signals })).toBeUndefined();
    });

    it('all built-in profiles have instructions', () => {
      expect(baselineProfile.instructions).toBeDefined();
      expect(extractBaseInstructions(baselineProfile.instructions).length).toBeGreaterThan(0);
      expect(javaProfile.instructions).toBeDefined();
      expect(angularProfile.instructions).toBeDefined();
      expect(typescriptProfile.instructions).toBeDefined();
    });

    it.each([
      ['baseline', baselineProfile],
      ['java', javaProfile],
      ['angular', angularProfile],
      ['typescript', typescriptProfile],
    ] as const)('%s profile contains NOT_VERIFIED marker guidance', (_name, profile) => {
      const base = extractBaseInstructions(profile.instructions);
      expect(base).toContain('NOT_VERIFIED');
    });

    it.each([
      ['baseline', baselineProfile],
      ['java', javaProfile],
      ['angular', angularProfile],
      ['typescript', typescriptProfile],
    ] as const)('%s profile contains ASSUMPTION marker guidance', (_name, profile) => {
      const base = extractBaseInstructions(profile.instructions);
      expect(base).toContain('ASSUMPTION');
    });

    it('no built-in profile references AGENTS.md', () => {
      for (const profile of [baselineProfile, javaProfile, angularProfile, typescriptProfile]) {
        const base = extractBaseInstructions(profile.instructions);
        expect(base).not.toContain('AGENTS.md');
        const byPhase = extractByPhaseInstructions(profile.instructions);
        if (byPhase) {
          for (const content of Object.values(byPhase)) {
            expect(content).not.toContain('AGENTS.md');
          }
        }
      }
    });

    it('ids() returns all registered IDs', () => {
      const ids = defaultProfileRegistry.ids();
      expect(ids).toContain('baseline');
      expect(ids).toContain('backend-java');
      expect(ids).toContain('frontend-angular');
      expect(ids).toContain('typescript');
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('profile detection with 10k signals < 100ms (p99)', () => {
      const files = Array.from({ length: 10000 }, (_, i) => `src/file${i}.ts`);
      const signals: RepoSignals = {
        files,
        packageFiles: ['pom.xml'],
        configFiles: ['tsconfig.json'],
      };
      const result = benchmarkSync(
        () => {
          defaultProfileRegistry.detect({ repoSignals: signals });
        },
        20,
        5,
      );
      expect(result.p99Ms).toBeLessThan(100);
    });
  });
});

describe('config/profile/phase-instructions', () => {
  const phaseInstructions: PhaseInstructions = {
    base: 'Always present base rules.',
    byPhase: {
      PLAN: 'Focus on plan structure and completeness.',
      IMPLEMENTATION: 'Focus on code quality and test coverage.',
    },
  };

  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('resolveProfileInstructions returns base for plain string', () => {
      expect(resolveProfileInstructions('plain rules', 'PLAN')).toBe('plain rules');
    });

    it('resolveProfileInstructions returns base + phase extra for matching phase', () => {
      const result = resolveProfileInstructions(phaseInstructions, 'PLAN');
      expect(result).toContain('Always present base rules.');
      expect(result).toContain('Focus on plan structure and completeness.');
    });

    it('resolveProfileInstructions returns only base for non-matching phase', () => {
      const result = resolveProfileInstructions(phaseInstructions, 'TICKET');
      expect(result).toBe('Always present base rules.');
    });

    it('extractBaseInstructions returns base from PhaseInstructions', () => {
      expect(extractBaseInstructions(phaseInstructions)).toBe('Always present base rules.');
    });

    it('extractBaseInstructions returns string as-is', () => {
      expect(extractBaseInstructions('plain')).toBe('plain');
    });

    it('extractByPhaseInstructions returns byPhase from PhaseInstructions', () => {
      const byPhase = extractByPhaseInstructions(phaseInstructions);
      expect(byPhase).toBeDefined();
      expect(byPhase!.PLAN).toBe('Focus on plan structure and completeness.');
      expect(byPhase!.IMPLEMENTATION).toBe('Focus on code quality and test coverage.');
    });

    it('extractByPhaseInstructions returns undefined for string', () => {
      expect(extractByPhaseInstructions('plain')).toBeUndefined();
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('resolveProfileInstructions returns empty for undefined', () => {
      expect(resolveProfileInstructions(undefined, 'PLAN')).toBe('');
    });

    it('extractBaseInstructions returns empty for undefined', () => {
      expect(extractBaseInstructions(undefined)).toBe('');
    });

    it('extractByPhaseInstructions returns undefined for undefined', () => {
      expect(extractByPhaseInstructions(undefined)).toBeUndefined();
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('PhaseInstructions with no byPhase returns only base', () => {
      const noPhase: PhaseInstructions = { base: 'base only' };
      expect(resolveProfileInstructions(noPhase, 'PLAN')).toBe('base only');
    });

    it('PhaseInstructions with empty byPhase returns only base', () => {
      const emptyPhase: PhaseInstructions = { base: 'base', byPhase: {} };
      expect(resolveProfileInstructions(emptyPhase, 'PLAN')).toBe('base');
    });

    it('resolveProfileInstructions separates base and phase with double newline', () => {
      const result = resolveProfileInstructions(phaseInstructions, 'PLAN');
      expect(result).toBe(
        'Always present base rules.\n\nFocus on plan structure and completeness.',
      );
    });

    it('all 8 phases are valid keys for byPhase', () => {
      const allPhases: PhaseInstructions = {
        base: 'b',
        byPhase: {
          TICKET: 't',
          PLAN: 'p',
          PLAN_REVIEW: 'pr',
          VALIDATION: 'v',
          IMPLEMENTATION: 'i',
          IMPL_REVIEW: 'ir',
          EVIDENCE_REVIEW: 'er',
          COMPLETE: 'c',
        },
      };
      for (const [phase, extra] of Object.entries(allPhases.byPhase!)) {
        expect(
          resolveProfileInstructions(allPhases, phase as import('../state/schema.js').Phase),
        ).toBe(`b\n\n${extra}`);
      }
    });

    it('extractByPhaseInstructions returns undefined for PhaseInstructions without byPhase', () => {
      const noPhase: PhaseInstructions = { base: 'b' };
      expect(extractByPhaseInstructions(noPhase)).toBeUndefined();
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe('EDGE', () => {
    it('all built-in profiles work with resolveProfileInstructions', () => {
      for (const profile of [baselineProfile, javaProfile, angularProfile, typescriptProfile]) {
        const result = resolveProfileInstructions(profile.instructions, 'PLAN');
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
      }
    });

    it('PhaseInstructions in GovernanceProfile interface is accepted by registry', () => {
      const registry = new ProfileRegistry();
      registry.register({
        id: 'test-phase-aware',
        name: 'Test Phase-Aware',
        activeChecks: [],
        checks: new Map(),
        instructions: phaseInstructions,
      });
      const profile = registry.get('test-phase-aware');
      expect(profile).toBeDefined();
      expect(resolveProfileInstructions(profile!.instructions, 'PLAN')).toContain('plan structure');
      expect(resolveProfileInstructions(profile!.instructions, 'TICKET')).toBe(
        'Always present base rules.',
      );
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('resolveProfileInstructions p95 < 1ms per call', () => {
      const result = benchmarkSync(
        () => resolveProfileInstructions(phaseInstructions, 'PLAN'),
        1000,
        100,
      );
      expect(result.p95Ms).toBeLessThan(1);
    });
  });
});

// ─── P0/P1/P2/P6: Profile byPhase, Examples, Baseline Hardening, Tag Alignment ──

describe('config/profile/byPhase-content', () => {
  const ALL_PROFILES = [
    { name: 'baseline', profile: baselineProfile },
    { name: 'java', profile: javaProfile },
    { name: 'angular', profile: angularProfile },
    { name: 'typescript', profile: typescriptProfile },
  ] as const;

  // ─── HAPPY: All profiles export PhaseInstructions ─────────
  describe('HAPPY', () => {
    it.each(ALL_PROFILES)(
      '$name profile exports PhaseInstructions with base and byPhase',
      ({ profile }) => {
        const instructions = profile.instructions;
        expect(instructions).toBeDefined();
        expect(typeof instructions).toBe('object');
        const base = extractBaseInstructions(instructions);
        expect(base.length).toBeGreaterThan(100);
        const byPhase = extractByPhaseInstructions(instructions);
        expect(byPhase).toBeDefined();
        expect(Object.keys(byPhase!).length).toBeGreaterThanOrEqual(4);
      },
    );

    it.each(ALL_PROFILES)(
      '$name profile has PLAN phase content with testing rules',
      ({ profile }) => {
        const resolved = resolveProfileInstructions(profile.instructions, 'PLAN');
        expect(resolved).toContain('Test');
      },
    );

    it.each(ALL_PROFILES)(
      '$name profile has IMPLEMENTATION phase with few-shot examples',
      ({ profile }) => {
        const resolved = resolveProfileInstructions(profile.instructions, 'IMPLEMENTATION');
        expect(resolved).toContain('<examples>');
        expect(resolved).toContain('<example');
        expect(resolved).toContain('</examples>');
      },
    );

    it.each(ALL_PROFILES)('$name profile has REVIEW phase with review checklist', ({ profile }) => {
      const resolved = resolveProfileInstructions(profile.instructions, 'REVIEW');
      expect(resolved).toContain('Review Checklist');
    });

    it.each(ALL_PROFILES)(
      '$name profile IMPLEMENTATION phase includes negative test matrix',
      ({ profile }) => {
        const resolved = resolveProfileInstructions(profile.instructions, 'IMPLEMENTATION');
        expect(resolved).toContain('Negative Tests');
      },
    );
  });

  // ─── BAD: Phases without byPhase content return only base ──
  describe('BAD', () => {
    it.each(ALL_PROFILES)('$name profile READY phase returns only base content', ({ profile }) => {
      const resolved = resolveProfileInstructions(profile.instructions, 'READY');
      const base = extractBaseInstructions(profile.instructions);
      expect(resolved).toBe(base);
    });

    it.each(ALL_PROFILES)('$name profile TICKET phase returns only base content', ({ profile }) => {
      const resolved = resolveProfileInstructions(profile.instructions, 'TICKET');
      const base = extractBaseInstructions(profile.instructions);
      expect(resolved).toBe(base);
    });

    it.each(ALL_PROFILES)(
      '$name profile COMPLETE phase returns only base content',
      ({ profile }) => {
        const resolved = resolveProfileInstructions(profile.instructions, 'COMPLETE');
        const base = extractBaseInstructions(profile.instructions);
        expect(resolved).toBe(base);
      },
    );
  });

  // ─── CORNER: Phase-specific content is additive, not replacing ──
  describe('CORNER', () => {
    it.each(ALL_PROFILES)(
      '$name profile IMPLEMENTATION content includes base + phase additions',
      ({ profile }) => {
        const base = extractBaseInstructions(profile.instructions);
        const resolved = resolveProfileInstructions(profile.instructions, 'IMPLEMENTATION');
        expect(resolved).toContain(base);
        expect(resolved.length).toBeGreaterThan(base.length);
      },
    );

    it.each(ALL_PROFILES)(
      '$name profile base content does NOT contain few-shot examples',
      ({ profile }) => {
        const base = extractBaseInstructions(profile.instructions);
        expect(base).not.toContain('<examples>');
        expect(base).not.toContain('<incorrect>');
        expect(base).not.toContain('<correct>');
      },
    );

    it.each(ALL_PROFILES)(
      '$name profile base content contains anti-pattern TABLE (IDs only)',
      ({ profile }) => {
        const base = extractBaseInstructions(profile.instructions);
        expect(base).toContain('Anti-Patterns');
        expect(base).toContain('| ID |');
      },
    );
  });

  // ─── EDGE: Cross-phase consistency ────────────────────────
  describe('EDGE', () => {
    it.each(ALL_PROFILES)(
      '$name profile IMPL_REVIEW has examples AND review checklist',
      ({ profile }) => {
        const resolved = resolveProfileInstructions(profile.instructions, 'IMPL_REVIEW');
        expect(resolved).toContain('<examples>');
        expect(resolved).toContain('Review Checklist');
      },
    );

    it.each(ALL_PROFILES)(
      '$name profile EVIDENCE_REVIEW has review checklist but NOT examples',
      ({ profile }) => {
        const resolved = resolveProfileInstructions(profile.instructions, 'EVIDENCE_REVIEW');
        expect(resolved).toContain('Review Checklist');
        expect(resolved).not.toContain('<examples>');
      },
    );

    it.each(ALL_PROFILES)(
      '$name profile PLAN_REVIEW has review checklist but NOT examples',
      ({ profile }) => {
        const resolved = resolveProfileInstructions(profile.instructions, 'PLAN_REVIEW');
        expect(resolved).toContain('Review Checklist');
        expect(resolved).not.toContain('<examples>');
      },
    );
  });
});

describe('config/profile/few-shot-examples', () => {
  // ─── P1: Example Coverage ─────────────────────────────────
  describe('HAPPY', () => {
    it('TypeScript profile has 7 examples', () => {
      const impl = resolveProfileInstructions(typescriptProfile.instructions, 'IMPLEMENTATION');
      const matches = impl.match(/<example id="/g);
      expect(matches).toHaveLength(7);
    });

    it('Java profile has 7 examples', () => {
      const impl = resolveProfileInstructions(javaProfile.instructions, 'IMPLEMENTATION');
      const matches = impl.match(/<example id="/g);
      expect(matches).toHaveLength(7);
    });

    it('Angular profile has 7 examples', () => {
      const impl = resolveProfileInstructions(angularProfile.instructions, 'IMPLEMENTATION');
      const matches = impl.match(/<example id="/g);
      expect(matches).toHaveLength(7);
    });

    it('Baseline profile has 8 examples', () => {
      const impl = resolveProfileInstructions(baselineProfile.instructions, 'IMPLEMENTATION');
      const matches = impl.match(/<example id="/g);
      expect(matches).toHaveLength(8);
    });
  });

  // ─── P6a: Tag Alignment ────────────────────────────────────
  describe('P6a tag alignment', () => {
    const ALL_PROFILES = [
      { name: 'baseline', profile: baselineProfile },
      { name: 'java', profile: javaProfile },
      { name: 'angular', profile: angularProfile },
      { name: 'typescript', profile: typescriptProfile },
    ] as const;

    it.each(ALL_PROFILES)(
      '$name profile uses <incorrect>/<correct> tags (not <bad_code>/<good_code>)',
      ({ profile }) => {
        const impl = resolveProfileInstructions(profile.instructions, 'IMPLEMENTATION');
        expect(impl).toContain('<incorrect>');
        expect(impl).toContain('</incorrect>');
        expect(impl).toContain('<correct>');
        expect(impl).toContain('</correct>');
        expect(impl).not.toContain('<bad_code>');
        expect(impl).not.toContain('</bad_code>');
        expect(impl).not.toContain('<good_code>');
        expect(impl).not.toContain('</good_code>');
      },
    );

    it.each(ALL_PROFILES)('$name profile examples have <why> explanations', ({ profile }) => {
      const impl = resolveProfileInstructions(profile.instructions, 'IMPLEMENTATION');
      const whyCount = (impl.match(/<why>/g) || []).length;
      const exampleCount = (impl.match(/<example /g) || []).length;
      expect(whyCount).toBe(exampleCount);
    });
  });

  // ─── CORNER: Specific example IDs ─────────────────────────
  describe('CORNER', () => {
    it('TypeScript examples cover TS01, TS02, TS04, TS05, TS06, TS08, TS10', () => {
      const impl = resolveProfileInstructions(typescriptProfile.instructions, 'IMPLEMENTATION');
      for (const id of [
        'AP-TS01',
        'AP-TS02',
        'AP-TS04',
        'AP-TS05',
        'AP-TS06',
        'AP-TS08',
        'AP-TS10',
      ]) {
        expect(impl).toContain(`id="${id}"`);
      }
    });

    it('Java examples cover J01, J03, J04, J05, J07, J08, J09', () => {
      const impl = resolveProfileInstructions(javaProfile.instructions, 'IMPLEMENTATION');
      for (const id of ['AP-J01', 'AP-J03', 'AP-J04', 'AP-J05', 'AP-J07', 'AP-J08', 'AP-J09']) {
        expect(impl).toContain(`id="${id}"`);
      }
    });

    it('Angular examples cover NG01, NG02, NG03, NG04, NG05, NG06, NG07', () => {
      const impl = resolveProfileInstructions(angularProfile.instructions, 'IMPLEMENTATION');
      for (const id of [
        'AP-NG01',
        'AP-NG02',
        'AP-NG03',
        'AP-NG04',
        'AP-NG05',
        'AP-NG06',
        'AP-NG07',
      ]) {
        expect(impl).toContain(`id="${id}"`);
      }
    });

    it('Baseline examples cover B01-B08', () => {
      const impl = resolveProfileInstructions(baselineProfile.instructions, 'IMPLEMENTATION');
      for (const id of [
        'AP-B01',
        'AP-B02',
        'AP-B03',
        'AP-B04',
        'AP-B05',
        'AP-B06',
        'AP-B07',
        'AP-B08',
      ]) {
        expect(impl).toContain(`id="${id}"`);
      }
    });
  });
});

describe('config/profile/baseline-hardening', () => {
  // ─── P2: Baseline parity with specialized profiles ─────────
  describe('HAPPY', () => {
    it('baseline profile has negative test matrix', () => {
      const plan = resolveProfileInstructions(baselineProfile.instructions, 'PLAN');
      expect(plan).toContain('Minimum Negative Tests');
      expect(plan).toContain('Function/Module');
      expect(plan).toContain('API Boundary');
    });

    it('baseline profile has review checklist', () => {
      const review = resolveProfileInstructions(baselineProfile.instructions, 'REVIEW');
      expect(review).toContain('Review Checklist');
      expect(review).toContain('Error Handling');
      expect(review).toContain('Input Validation');
      expect(review).toContain('Security');
    });

    it('baseline profile has few-shot examples', () => {
      const impl = resolveProfileInstructions(baselineProfile.instructions, 'IMPLEMENTATION');
      expect(impl).toContain('<examples>');
      expect(impl).toContain('AP-B01');
    });

    it('baseline profile has testing fundamentals', () => {
      const plan = resolveProfileInstructions(baselineProfile.instructions, 'PLAN');
      expect(plan).toContain('Testing Fundamentals');
      expect(plan).toContain('Test Structure');
      expect(plan).toContain('Test Quality');
    });
  });

  // ─── EDGE: Baseline content is language-agnostic ───────────
  describe('EDGE', () => {
    it('baseline examples use language-agnostic code (not TypeScript-specific)', () => {
      const impl = resolveProfileInstructions(baselineProfile.instructions, 'IMPLEMENTATION');
      // Baseline examples should NOT contain TypeScript-specific syntax
      expect(impl).not.toContain('interface ');
      expect(impl).not.toContain(': string');
      expect(impl).not.toContain('async function');
    });

    it('baseline base content does not contain stack-specific references', () => {
      const base = extractBaseInstructions(baselineProfile.instructions);
      expect(base).not.toContain('TypeScript');
      expect(base).not.toContain('Java');
      expect(base).not.toContain('Angular');
      expect(base).not.toContain('Spring');
    });
  });
});

describe('config/profile/java-dedup', () => {
  // ─── P6b: Java Section 6 redundancy removal ────────────────
  it('Java profile Section 6 has no redundant content', () => {
    const base = extractBaseInstructions(javaProfile.instructions);
    // The section should contain the MUST/MUST NOT version only
    expect(base).toContain('contract MUST be treated as authoritative');
    // The informal "NEVER edit" version should be gone
    expect(base).not.toContain('NEVER edit generated code');
    expect(base).not.toContain('NEVER place business logic');
  });

  it('Java profile Section 6 preserves contract drift rule', () => {
    const base = extractBaseInstructions(javaProfile.instructions);
    expect(base).toContain('Contract drift -> hard failure');
  });
});

describe('config/profile/decision-trees', () => {
  // ─── Java and Angular have decision trees in PLAN/ARCHITECTURE ──
  describe('HAPPY', () => {
    it('Java profile has decision trees in PLAN phase', () => {
      const plan = resolveProfileInstructions(javaProfile.instructions, 'PLAN');
      expect(plan).toContain('Architecture Pattern Selection');
      expect(plan).toContain('Test Type Selection');
    });

    it('Angular profile has decision trees in PLAN phase', () => {
      const plan = resolveProfileInstructions(angularProfile.instructions, 'PLAN');
      expect(plan).toContain('State Management Selection');
      expect(plan).toContain('Test Type Selection');
      expect(plan).toContain('Library Type Selection');
      expect(plan).toContain('Component Type Decision');
    });

    it('Java profile has decision trees in ARCHITECTURE phase', () => {
      const arch = resolveProfileInstructions(javaProfile.instructions, 'ARCHITECTURE');
      expect(arch).toContain('Architecture Pattern Selection');
    });

    it('Angular profile has decision trees in ARCHITECTURE phase', () => {
      const arch = resolveProfileInstructions(angularProfile.instructions, 'ARCHITECTURE');
      expect(arch).toContain('State Management Selection');
    });
  });

  // ─── BAD: Decision trees NOT in non-planning phases ────────
  describe('BAD', () => {
    it('Java base content does NOT contain decision trees', () => {
      const base = extractBaseInstructions(javaProfile.instructions);
      expect(base).not.toContain('Architecture Pattern Selection');
      expect(base).not.toContain('Test Type Selection');
    });

    it('Angular base content does NOT contain decision trees', () => {
      const base = extractBaseInstructions(angularProfile.instructions);
      expect(base).not.toContain('State Management Selection');
      expect(base).not.toContain('Component Type Decision');
    });
  });
});

// ─── PERF: Token budget verification ─────────────────────────────────────────

describe('config/profile/token-budget', () => {
  it.each([
    { name: 'baseline', profile: baselineProfile, maxBaseChars: 5000 },
    { name: 'typescript', profile: typescriptProfile, maxBaseChars: 8000 },
    { name: 'java', profile: javaProfile, maxBaseChars: 10000 },
    { name: 'angular', profile: angularProfile, maxBaseChars: 8000 },
  ] as const)(
    '$name base content stays within $maxBaseChars character budget',
    ({ profile, maxBaseChars }) => {
      const base = extractBaseInstructions(profile.instructions);
      expect(base.length).toBeLessThan(maxBaseChars);
    },
  );

  it('byPhase content reduces per-phase token count vs monolithic', () => {
    // For each profile, base-only (READY phase) should be shorter than
    // the heaviest phase (IMPLEMENTATION)
    for (const profile of [baselineProfile, javaProfile, angularProfile, typescriptProfile]) {
      const readyContent = resolveProfileInstructions(profile.instructions, 'READY');
      const implContent = resolveProfileInstructions(profile.instructions, 'IMPLEMENTATION');
      expect(readyContent.length).toBeLessThan(implContent.length);
    }
  });
});

// ─── Version Neutrality & Verification Hardening ─────────────────────────────

describe('config/profile/version-neutrality', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('java profile base uses detection-first language', () => {
      const base = extractBaseInstructions(javaProfile.instructions);
      expect(base).toContain('Technology Stack Detection');
      expect(base).toContain('Detect stack facts from repository evidence first');
    });

    it('java profile base requires NOT_VERIFIED for unverified versions', () => {
      const base = extractBaseInstructions(javaProfile.instructions);
      expect(base).toContain('NOT_VERIFIED');
      expect(base).toContain('version cannot be verified');
    });

    it('angular AP-NG09 references version-conditional guidance', () => {
      const base = extractBaseInstructions(angularProfile.instructions);
      expect(base).toContain('repo version or convention requires them');
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('java profile base must NOT contain hard-coded Java version', () => {
      const base = extractBaseInstructions(javaProfile.instructions);
      expect(base).not.toContain('Java 21');
      expect(base).not.toContain('Java 17');
      expect(base).not.toContain('Java 11');
    });

    it('java profile base must NOT contain hard-coded Spring Boot version', () => {
      const base = extractBaseInstructions(javaProfile.instructions);
      expect(base).not.toContain('Spring Boot 3.x');
      expect(base).not.toContain('Spring Boot 2.x');
    });

    it('java profile base must NOT use assume-first wording', () => {
      const base = extractBaseInstructions(javaProfile.instructions);
      expect(base).not.toMatch(/[Uu]nless repository evidence.*assume/);
    });

    it('angular AP-NG09 must NOT contain bare "Deprecated" claim', () => {
      const base = extractBaseInstructions(angularProfile.instructions);
      // Match the table cell: "| Deprecated," without version context
      expect(base).not.toMatch(/\|\s*Deprecated,\s/);
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('java profile still detects conditional tooling (no version assumption)', () => {
      const base = extractBaseInstructions(javaProfile.instructions);
      // These are detect-if-present, not version-specific
      expect(base).toContain('JPA/Hibernate');
      expect(base).toContain('MapStruct');
      expect(base).toContain('Actuator');
    });

    it('typescript profile remains version-neutral (no change needed)', () => {
      const base = extractBaseInstructions(typescriptProfile.instructions);
      // Should not contain any hard-coded version numbers
      expect(base).not.toMatch(/TypeScript \d+/);
      expect(base).not.toMatch(/Node\.?js? \d+/);
    });

    it('baseline profile remains version-agnostic (no change needed)', () => {
      const base = extractBaseInstructions(baselineProfile.instructions);
      // Baseline should never mention specific language versions
      expect(base).not.toMatch(/Java \d+/);
      expect(base).not.toMatch(/Python \d+/);
      expect(base).not.toMatch(/Node\.?js? \d+/);
    });
  });
});

describe('config/profile/verification-hardening', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it.each([
      { name: 'baseline', profile: baselineProfile },
      { name: 'typescript', profile: typescriptProfile },
      { name: 'java', profile: javaProfile },
      { name: 'angular', profile: angularProfile },
    ] as const)('$name profile base contains Verification Commands section', ({ profile }) => {
      const base = extractBaseInstructions(profile.instructions);
      expect(base).toContain('Verification Commands');
    });

    it.each([
      { name: 'baseline', profile: baselineProfile },
      { name: 'typescript', profile: typescriptProfile },
      { name: 'java', profile: javaProfile },
      { name: 'angular', profile: angularProfile },
    ] as const)('$name verification section requires NOT_VERIFIED on failure', ({ profile }) => {
      const base = extractBaseInstructions(profile.instructions);
      // Find the verification section and check it mentions NOT_VERIFIED
      const verIdx = base.indexOf('Verification Commands');
      expect(verIdx).toBeGreaterThan(-1);
      const verSection = base.slice(verIdx, verIdx + 500);
      expect(verSection).toContain('NOT_VERIFIED');
      expect(verSection).toContain('recovery');
    });

    it.each([
      { name: 'baseline', profile: baselineProfile },
      { name: 'typescript', profile: typescriptProfile },
      { name: 'java', profile: javaProfile },
      { name: 'angular', profile: angularProfile },
    ] as const)('$name verification section prioritizes repo-native commands', ({ profile }) => {
      const base = extractBaseInstructions(profile.instructions);
      const verIdx = base.indexOf('Verification Commands');
      const verSection = base.slice(verIdx, verIdx + 500);
      // CI commands should be listed first (position 1)
      expect(verSection).toMatch(/1\.\s*Documented CI commands/);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it.each([
      { name: 'baseline', profile: baselineProfile },
      { name: 'typescript', profile: typescriptProfile },
      { name: 'java', profile: javaProfile },
      { name: 'angular', profile: angularProfile },
    ] as const)(
      '$name verification section must NOT prescribe unconditional framework commands',
      ({ profile }) => {
        const base = extractBaseInstructions(profile.instructions);
        const verIdx = base.indexOf('Verification Commands');
        const verSection = base.slice(verIdx, verIdx + 500);
        // Framework defaults should be conditional ("only if repo-native absent")
        expect(verSection).toMatch(/[Oo]nly if repo-native.*(absent|commands are absent)/);
      },
    );
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('java verification mentions mvnw/gradlew', () => {
      const base = extractBaseInstructions(javaProfile.instructions);
      const verIdx = base.indexOf('Verification Commands');
      const verSection = base.slice(verIdx, verIdx + 500);
      expect(verSection).toMatch(/mvnw|gradlew|Maven|Gradle/);
    });

    it('typescript verification mentions package.json scripts', () => {
      const base = extractBaseInstructions(typescriptProfile.instructions);
      const verIdx = base.indexOf('Verification Commands');
      const verSection = base.slice(verIdx, verIdx + 500);
      expect(verSection).toContain('package.json');
    });

    it('angular verification mentions ng or nx commands', () => {
      const base = extractBaseInstructions(angularProfile.instructions);
      const verIdx = base.indexOf('Verification Commands');
      const verSection = base.slice(verIdx, verIdx + 500);
      expect(verSection).toMatch(/ng |nx /);
    });

    it('verification section comes after quality gates in all profiles', () => {
      for (const profile of [baselineProfile, javaProfile, angularProfile, typescriptProfile]) {
        const base = extractBaseInstructions(profile.instructions);
        const qgIdx = base.indexOf('Quality Gates');
        const verIdx = base.indexOf('Verification Commands');
        const apIdx = base.indexOf('Anti-Patterns');
        expect(qgIdx).toBeLessThan(verIdx);
        expect(verIdx).toBeLessThan(apIdx);
      }
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('verification section adds < 500 chars per profile', () => {
      for (const profile of [baselineProfile, javaProfile, angularProfile, typescriptProfile]) {
        const base = extractBaseInstructions(profile.instructions);
        const verIdx = base.indexOf('Verification Commands');
        const apIdx = base.indexOf('Anti-Patterns');
        // Section between verification heading and anti-patterns
        const verLen = apIdx - verIdx;
        expect(verLen).toBeLessThan(500);
        expect(verLen).toBeGreaterThan(50); // not empty
      }
    });
  });
});

describe('config/profile/convention-override-clause', () => {
  const ALL_PROFILES = [
    { name: 'baseline', profile: baselineProfile },
    { name: 'java', profile: javaProfile },
    { name: 'angular', profile: angularProfile },
    { name: 'typescript', profile: typescriptProfile },
  ] as const;

  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it.each(ALL_PROFILES)(
      '$name profile base contains "Quality gates are unconditional"',
      ({ profile }) => {
        const base = extractBaseInstructions(profile.instructions);
        expect(base).toContain('Quality gates are unconditional');
      },
    );

    it.each(ALL_PROFILES)(
      '$name profile base contains convention-override clause',
      ({ profile }) => {
        const base = extractBaseInstructions(profile.instructions);
        expect(base).toContain('They must never');
        expect(base).toContain('override hard-fail gates');
        expect(base).toContain('fail-closed behavior');
        expect(base).toContain('mandates.');
      },
    );
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it.each(ALL_PROFILES)(
      '$name clause appears after Quality Gates table and before Verification Commands',
      ({ profile }) => {
        const base = extractBaseInstructions(profile.instructions);
        const qgIdx = base.indexOf('Quality Gates');
        const clauseIdx = base.indexOf('Quality gates are unconditional');
        const verIdx = base.indexOf('Verification Commands');
        expect(qgIdx).toBeLessThan(clauseIdx);
        expect(clauseIdx).toBeLessThan(verIdx);
      },
    );

    it.each(ALL_PROFILES)(
      '$name clause mentions conventions may narrow choices inside passing gates',
      ({ profile }) => {
        const base = extractBaseInstructions(profile.instructions);
        expect(base).toContain('narrow implementation choices only inside passing gates');
      },
    );
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('convention-override clause does NOT appear in phase-specific content', () => {
      for (const profile of [baselineProfile, javaProfile, angularProfile, typescriptProfile]) {
        const byPhase = extractByPhaseInstructions(profile.instructions);
        if (byPhase) {
          for (const content of Object.values(byPhase)) {
            expect(content).not.toContain('Quality gates are unconditional');
          }
        }
      }
    });
  });
});

describe('config/profile/detected-stack-instruction', () => {
  const ALL_PROFILES = [
    { name: 'baseline', profile: baselineProfile },
    { name: 'java', profile: javaProfile },
    { name: 'angular', profile: angularProfile },
    { name: 'typescript', profile: typescriptProfile },
  ] as const;

  const STACK_PHASES = ['PLAN', 'IMPLEMENTATION', 'IMPL_REVIEW', 'REVIEW'] as const;
  const NON_STACK_PHASES = ['PLAN_REVIEW', 'EVIDENCE_REVIEW'] as const;

  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it.each(ALL_PROFILES)(
      '$name profile includes detected stack instruction in PLAN/IMPL/IMPL_REVIEW/REVIEW',
      ({ profile }) => {
        const byPhase = extractByPhaseInstructions(profile.instructions);
        expect(byPhase).toBeDefined();
        for (const phase of STACK_PHASES) {
          const content = byPhase![phase as keyof typeof byPhase];
          expect(content).toBeDefined();
          expect(content).toContain('flowguard_status.detectedStack');
          expect(content).toContain('flowguard_status.verificationCandidates');
          expect(content).toContain('NOT_VERIFIED');
        }
      },
    );
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it.each(ALL_PROFILES)(
      '$name profile does NOT include detected stack instruction in PLAN_REVIEW/EVIDENCE_REVIEW',
      ({ profile }) => {
        const byPhase = extractByPhaseInstructions(profile.instructions);
        expect(byPhase).toBeDefined();
        for (const phase of NON_STACK_PHASES) {
          const content = byPhase![phase as keyof typeof byPhase];
          if (content) {
            expect(content).not.toContain('flowguard_status.detectedStack');
            expect(content).not.toContain('flowguard_status.verificationCandidates');
          }
        }
      },
    );

    it.each(ALL_PROFILES)(
      '$name detected stack instruction is NOT in base content',
      ({ profile }) => {
        const base = extractBaseInstructions(profile.instructions);
        expect(base).not.toContain('flowguard_status.detectedStack');
        expect(base).not.toContain('flowguard_status.verificationCandidates');
      },
    );
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('detected stack instruction text matches across all profiles', () => {
      const expected = 'Use flowguard_status.detectedStack when present';
      for (const { profile } of ALL_PROFILES) {
        const byPhase = extractByPhaseInstructions(profile.instructions);
        if (!byPhase) continue;
        for (const phase of STACK_PHASES) {
          const content = byPhase[phase as keyof typeof byPhase];
          expect(content).toContain(expected);
          expect(content).toContain('flowguard_status.verificationCandidates');
        }
      }
    });
  });
});

describe('config/check-executors', () => {
  const testQuality = baselineProfile.checks.get('test_quality')!;
  const rollbackSafety = baselineProfile.checks.get('rollback_safety')!;

  /** Helper: make a plan record with custom body. */
  function planWith(body: string): PlanRecord {
    return {
      current: {
        body,
        digest: 'd',
        sections: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      history: [],
    };
  }

  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('test_quality passes when plan mentions tests', async () => {
      const state = makeState('VALIDATION', {
        plan: planWith('## Plan\n1. Add unit tests for the service'),
      });
      const result = await testQuality.execute(state);
      expect(result.passed).toBe(true);
      expect(result.checkId).toBe('test_quality');
      expect(result.executedAt).toBeDefined();
    });

    it('rollback_safety passes for low-risk plan', async () => {
      const state = makeState('VALIDATION', {
        plan: planWith('## Plan\n1. Rename variable in utils'),
      });
      const result = await rollbackSafety.execute(state);
      expect(result.passed).toBe(true);
      expect(result.detail).toContain('No high-risk signals');
    });

    it('rollback_safety passes for high-risk plan with rollback mention', async () => {
      const state = makeState('VALIDATION', {
        plan: planWith('## Plan\n1. Add database migration\n2. Rollback script included'),
      });
      const result = await rollbackSafety.execute(state);
      expect(result.passed).toBe(true);
      expect(result.detail).toContain('rollback safety');
    });

    it('executors are registered in BASELINE_CHECKS for all profiles', () => {
      for (const profile of [baselineProfile, javaProfile, angularProfile, typescriptProfile]) {
        expect(profile.checks.get('test_quality')).toBeDefined();
        expect(profile.checks.get('rollback_safety')).toBeDefined();
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('test_quality fails when plan has no test-related content', async () => {
      const state = makeState('VALIDATION', {
        plan: planWith('## Plan\n1. Refactor module structure'),
      });
      const result = await testQuality.execute(state);
      expect(result.passed).toBe(false);
      expect(result.detail).toContain('does not address test quality');
    });

    it('rollback_safety fails for high-risk plan without rollback mention', async () => {
      const state = makeState('VALIDATION', {
        plan: planWith('## Plan\n1. Change authentication flow\n2. Update database schema'),
      });
      const result = await rollbackSafety.execute(state);
      expect(result.passed).toBe(false);
      expect(result.detail).toContain('high-risk signals');
      expect(result.detail).toContain('rollback');
    });

    it('test_quality fails when plan is empty (null plan)', async () => {
      const state = makeState('VALIDATION', { plan: null });
      const result = await testQuality.execute(state);
      expect(result.passed).toBe(false);
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('test_quality fails when implementation has files but no test files', async () => {
      const state = makeState('VALIDATION', {
        plan: planWith('## Plan\n1. Add test coverage'),
        implementation: {
          changedFiles: ['src/auth.ts', 'src/config.ts'],
          domainFiles: ['src/auth.ts'],
          digest: 'd',
          executedAt: '2026-01-01T00:00:00.000Z',
        },
      });
      const result = await testQuality.execute(state);
      expect(result.passed).toBe(false);
      expect(result.detail).toContain('none appear to be test files');
    });

    it('test_quality passes when implementation includes test files', async () => {
      const state = makeState('VALIDATION', {
        plan: planWith('## Plan\n1. Add test coverage'),
        implementation: IMPL_EVIDENCE, // has src/auth.test.ts
      });
      const result = await testQuality.execute(state);
      expect(result.passed).toBe(true);
    });

    it('test_quality passes when implementation has no changed files (empty array)', async () => {
      const state = makeState('VALIDATION', {
        plan: planWith('## Plan\n1. Add test coverage'),
        implementation: {
          changedFiles: [],
          domainFiles: [],
          digest: 'd',
          executedAt: '2026-01-01T00:00:00.000Z',
        },
      });
      const result = await testQuality.execute(state);
      expect(result.passed).toBe(true);
    });

    it('rollback_safety detects various high-risk keywords', async () => {
      const keywords = [
        'database',
        'schema',
        'migration',
        'auth',
        'security',
        'payment',
        'messaging',
        'queue',
      ];
      for (const keyword of keywords) {
        const state = makeState('VALIDATION', { plan: planWith(`Plan: change ${keyword} logic`) });
        const result = await rollbackSafety.execute(state);
        expect(result.passed).toBe(false);
      }
    });

    it('rollback_safety accepts various rollback keywords', async () => {
      const rollbackKeywords = [
        'rollback',
        'backward compat',
        'feature flag',
        'revert',
        'reversible',
      ];
      for (const keyword of rollbackKeywords) {
        const state = makeState('VALIDATION', {
          plan: planWith(`Plan: change database logic. ${keyword} strategy included.`),
        });
        const result = await rollbackSafety.execute(state);
        expect(result.passed).toBe(true);
      }
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe('EDGE', () => {
    it('test_quality detects spec files as test files', async () => {
      const state = makeState('VALIDATION', {
        plan: planWith('## Plan\n1. Add test'),
        implementation: {
          changedFiles: ['src/auth.ts', 'src/auth.spec.ts'],
          domainFiles: ['src/auth.ts'],
          digest: 'd',
          executedAt: '2026-01-01T00:00:00.000Z',
        },
      });
      const result = await testQuality.execute(state);
      expect(result.passed).toBe(true);
    });

    it('test_quality is case-insensitive for signal detection', async () => {
      const state = makeState('VALIDATION', { plan: planWith('## Plan\n1. Run TESTING suite') });
      const result = await testQuality.execute(state);
      expect(result.passed).toBe(true);
    });

    it('rollback_safety is case-insensitive for signal detection', async () => {
      const state = makeState('VALIDATION', {
        plan: planWith('## Plan\n1. Change DATABASE schema\n2. ROLLBACK plan included'),
      });
      const result = await rollbackSafety.execute(state);
      expect(result.passed).toBe(true);
    });

    it('all executors return ISO datetime in executedAt', async () => {
      const state = makeState('VALIDATION', { plan: planWith('Add test for auth') });
      const tqResult = await testQuality.execute(state);
      const rsResult = await rollbackSafety.execute(state);
      expect(tqResult.executedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(rsResult.executedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('both executors complete in < 5ms', async () => {
      const state = makeState('VALIDATION', {
        plan: planWith('Add unit tests for database migration with rollback'),
      });
      const start = performance.now();
      await testQuality.execute(state);
      await rollbackSafety.execute(state);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(5);
    });
  });
});

describe('config/reasons', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('format produces structured result for known code', () => {
      const result = defaultReasonRegistry.format('COMMAND_NOT_ALLOWED', {
        command: '/plan',
        phase: 'COMPLETE',
      });
      expect(result.code).toBe('COMMAND_NOT_ALLOWED');
      expect(result.reason).toContain('/plan');
      expect(result.reason).toContain('COMPLETE');
      expect(result.recovery.length).toBeGreaterThan(0);
    });

    it('blocked() helper returns correct RailBlocked structure', () => {
      const result = blocked('TICKET_REQUIRED', { action: 'planning' });
      expect(result.kind).toBe('blocked');
      expect(result.code).toBe('TICKET_REQUIRED');
      expect(result.reason).toContain('planning');
      expect(result.quickFix).toBe('/ticket');
    });

    it('defaultReasonRegistry has 30+ codes', () => {
      expect(defaultReasonRegistry.size).toBeGreaterThanOrEqual(30);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('format returns generic message for unknown code', () => {
      const result = defaultReasonRegistry.format('TOTALLY_UNKNOWN');
      expect(result.code).toBe('TOTALLY_UNKNOWN');
      expect(result.reason).toContain('TOTALLY_UNKNOWN');
      expect(result.recovery).toEqual([]);
    });

    it('get returns undefined for unknown code', () => {
      expect(defaultReasonRegistry.get('NOPE')).toBeUndefined();
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('format interpolates all {variables}', () => {
      const result = defaultReasonRegistry.format('COMMAND_NOT_ALLOWED', {
        command: '/implement',
        phase: 'TICKET',
      });
      expect(result.reason).toBe('/implement is not allowed in phase TICKET');
    });

    it('format leaves unknown {variables} as-is', () => {
      const result = defaultReasonRegistry.format('COMMAND_NOT_ALLOWED', {});
      expect(result.reason).toContain('{command}');
      expect(result.reason).toContain('{phase}');
    });

    it('registerAll adds multiple reasons', () => {
      const registry = new BlockedReasonRegistry();
      registry.registerAll([
        { code: 'A', category: 'input', messageTemplate: 'A', recoverySteps: [] },
        { code: 'B', category: 'input', messageTemplate: 'B', recoverySteps: [] },
      ]);
      expect(registry.size).toBe(2);
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('all seed codes have non-empty messageTemplate', () => {
      for (const code of defaultReasonRegistry.codes()) {
        const reason = defaultReasonRegistry.get(code);
        expect(reason?.messageTemplate.length).toBeGreaterThan(0);
      }
    });

    it('blocked() with unknown code and vars.message uses it', () => {
      const result = blocked('CUSTOM_CODE', { message: 'Custom error' });
      expect(result.reason).toBe('Custom error');
    });

    it('codes() returns array of strings', () => {
      const codes = defaultReasonRegistry.codes();
      expect(Array.isArray(codes)).toBe(true);
      expect(codes.length).toBe(defaultReasonRegistry.size);
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    const REASON_LOOKUP_MS = 8;
    it(`reason lookup + format < ${REASON_LOOKUP_MS}ms (p99)`, () => {
      const result = benchmarkSync(() => {
        defaultReasonRegistry.format('COMMAND_NOT_ALLOWED', {
          command: '/plan',
          phase: 'TICKET',
        });
      });
      expect(result.p99Ms).toBeLessThan(REASON_LOOKUP_MS);
    });
  });
});

describe('cli/templates/verification-output-contract', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('/plan template contains ## Verification Plan section', () => {
      const planTemplate = COMMANDS['plan.md'];
      expect(planTemplate).toContain('## Verification Plan');
    });

    it('/plan template requires Source citation for verification checks', () => {
      const planTemplate = COMMANDS['plan.md'];
      expect(planTemplate).toMatch(/Source:/i);
    });

    it('/plan template requires NOT_VERIFIED fallback when no candidate available', () => {
      const planTemplate = COMMANDS['plan.md'];
      expect(planTemplate).toMatch(/NOT_VERIFIED/i);
      expect(planTemplate).toMatch(/recovery/i);
    });

    it('/plan template requires seven sections', () => {
      const planTemplate = COMMANDS['plan.md'];
      expect(planTemplate).toContain('## Objective');
      expect(planTemplate).toContain('## Approach');
      expect(planTemplate).toContain('## Steps');
      expect(planTemplate).toContain('## Files to Modify');
      expect(planTemplate).toContain('## Edge Cases');
      expect(planTemplate).toContain('## Validation Criteria');
      expect(planTemplate).toContain('## Verification Plan');
    });

    it('/implement template contains ## Verification Evidence section', () => {
      const implementTemplate = COMMANDS['implement.md'];
      expect(implementTemplate).toContain('## Verification Evidence');
    });

    it('/implement template distinguishes Planned checks from Executed checks', () => {
      const implementTemplate = COMMANDS['implement.md'];
      expect(implementTemplate).toMatch(/Planned checks/i);
      expect(implementTemplate).toMatch(/Executed checks/i);
    });

    it('/implement template requires NOT_VERIFIED for unexecuted checks', () => {
      const implementTemplate = COMMANDS['implement.md'];
      expect(implementTemplate).toMatch(/NOT_VERIFIED/i);
    });

    it('/review template checks verificationCandidates vs generic command mismatch', () => {
      const reviewTemplate = COMMANDS['review.md'];
      expect(reviewTemplate).toMatch(/verificationCandidates/i);
      expect(reviewTemplate).toMatch(/generic commands/i);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('/plan guards against invented verification commands via Source citation requirement', () => {
      const planTemplate = COMMANDS['plan.md'];
      expect(planTemplate).toMatch(/Cite Source for each verification check/i);
    });

    it('/plan must NOT use generic commands when candidates exist', () => {
      const planTemplate = COMMANDS['plan.md'];
      expect(planTemplate).toMatch(/verificationCandidates/i);
    });

    it('/implement requires listing only actually executed checks', () => {
      const implementTemplate = COMMANDS['implement.md'];
      expect(implementTemplate).toMatch(/list only checks.*actually executed/i);
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('/plan requires source-backed Verification Plan', () => {
      const planTemplate = COMMANDS['plan.md'];
      expect(planTemplate).toMatch(/Verification Plan cites Source/i);
    });

    it('/implement requires clearly separated Verification Evidence', () => {
      const implementTemplate = COMMANDS['implement.md'];
      expect(implementTemplate).toMatch(/Verification Evidence[\s\S]*distinguishing/i);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // P32: Runtime Policy Mode Unification
  // ═══════════════════════════════════════════════════════════════════════════════
  describe('P32 Runtime Policy Mode Unification', () => {
    // ─── HAPPY ─────────────────────────────────────────────────
    describe('HAPPY', () => {
      it('state.policySnapshot.mode takes precedence over config', () => {
        const state = {
          policySnapshot: { mode: 'regulated' as const },
        };
        const result = resolveRuntimePolicyMode({
          state,
          configDefaultMode: 'team',
        });
        expect(result).toBe('regulated');
      });

      it('config.defaultMode is used when no state', () => {
        const result = resolveRuntimePolicyMode({
          configDefaultMode: 'team',
        });
        expect(result).toBe('team');
      });

      it('solo is fallback when no state and no config', () => {
        const result = resolveRuntimePolicyMode({});
        expect(result).toBe('solo');
      });

      it('team config used correctly', () => {
        const result = resolveRuntimePolicyMode({
          configDefaultMode: 'team',
        });
        expect(result).toBe('team');
      });

      it('solo config used correctly', () => {
        const result = resolveRuntimePolicyMode({
          configDefaultMode: 'solo',
        });
        expect(result).toBe('solo');
      });

      it('team-ci config used correctly', () => {
        const result = resolveRuntimePolicyMode({
          configDefaultMode: 'team-ci',
        });
        expect(result).toBe('team-ci');
      });
    });

    // ─── BAD ─────────────────────────────────────────────────
    describe('BAD', () => {
      it('undefined state is handled gracefully', () => {
        const result = resolveRuntimePolicyMode({
          state: undefined,
          configDefaultMode: 'team',
        });
        expect(result).toBe('team');
      });

      it('empty policySnapshot is handled', () => {
        const result = resolveRuntimePolicyMode({
          state: { policySnapshot: {} },
          configDefaultMode: 'team',
        });
        expect(result).toBe('team');
      });
    });

    // ─── CORNER ─────────────────────────────────────────────────
    describe('CORNER', () => {
      it('null configDefaultMode falls back to solo', () => {
        const result = resolveRuntimePolicyMode({
          configDefaultMode: undefined,
        });
        expect(result).toBe('solo');
      });

      it('null state falls back to config', () => {
        const result = resolveRuntimePolicyMode({
          state: undefined,
          configDefaultMode: 'team',
        });
        expect(result).toBe('team');
      });
    });

    // ─── EDGE ─────────────────────────────────────────────────
    describe('EDGE', () => {
      it('empty state object falls back to config', () => {
        const result = resolveRuntimePolicyMode({
          state: {},
          configDefaultMode: 'team',
        });
        expect(result).toBe('team');
      });

      it('state with null mode falls back to config', () => {
        const result = resolveRuntimePolicyMode({
          state: { policySnapshot: { mode: undefined } },
          configDefaultMode: 'team',
        });
        expect(result).toBe('team');
      });

      it('complex state object works', () => {
        const result = resolveRuntimePolicyMode({
          state: {
            policySnapshot: {
              mode: 'regulated',
              requireHumanGates: true,
            },
          },
          configDefaultMode: 'solo',
        });
        expect(result).toBe('regulated');
      });
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('/plan has verification guidance in independent review loop', () => {
      const planTemplate = COMMANDS['plan.md'];
      expect(planTemplate).toMatch(/verificationCandidates/i);
    });

    it('/review flags generic command usage as defect', () => {
      const reviewTemplate = COMMANDS['review.md'];
      expect(reviewTemplate).toMatch(/flag this as a defect/i);
    });
  });
});
