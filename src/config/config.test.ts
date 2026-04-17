import { describe, it, expect } from 'vitest';
import {
  SOLO_POLICY,
  TEAM_POLICY,
  TEAM_CI_POLICY,
  REGULATED_POLICY,
  detectCiContext,
  getPolicyPreset,
  resolvePolicy,
  resolvePolicyWithContext,
  policyModes,
  createPolicySnapshot,
  policyFromSnapshot,
} from '../config/policy';
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
} from '../config/profile';
import type { RepoSignals, PhaseInstructions, CheckExecutor } from '../config/profile';
import { BlockedReasonRegistry, defaultReasonRegistry, blocked } from '../config/reasons';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy';
import { makeState, makeProgressedState, PLAN_RECORD, IMPL_EVIDENCE } from '../__fixtures__';
import type { SessionState } from '../state/schema';
import type { PlanEvidence, PlanRecord } from '../state/evidence';

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
      expect(withContext.policy).toBe(TEAM_POLICY);
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
      expect(result.policy).toBe(TEAM_POLICY);
      expect(result.requestedMode).toBe('team-ci');
      expect(result.effectiveMode).toBe('team');
      expect(result.effectiveGateBehavior).toBe('human_gated');
      expect(result.degradedReason).toBe('ci_context_missing');
    });

    it('SOLO has no human gates and 1 iteration', () => {
      expect(SOLO_POLICY.requireHumanGates).toBe(false);
      expect(SOLO_POLICY.maxSelfReviewIterations).toBe(1);
      expect(SOLO_POLICY.maxImplReviewIterations).toBe(1);
      expect(SOLO_POLICY.allowSelfApproval).toBe(true);
    });

    it('TEAM has human gates and 3 iterations', () => {
      expect(TEAM_POLICY.requireHumanGates).toBe(true);
      expect(TEAM_POLICY.maxSelfReviewIterations).toBe(3);
      expect(TEAM_POLICY.allowSelfApproval).toBe(true);
    });

    it('REGULATED has four-eyes enforcement', () => {
      expect(REGULATED_POLICY.allowSelfApproval).toBe(false);
      expect(REGULATED_POLICY.requireHumanGates).toBe(true);
    });

    it('TEAM-CI enables auto-approval with full audit', () => {
      expect(TEAM_CI_POLICY.requireHumanGates).toBe(false);
      expect(TEAM_CI_POLICY.maxSelfReviewIterations).toBe(3);
      expect(TEAM_CI_POLICY.maxImplReviewIterations).toBe(3);
      expect(TEAM_CI_POLICY.audit.enableChainHash).toBe(true);
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

    it('detectCiContext recognizes common CI signals', () => {
      expect(detectCiContext({ CI: 'true' })).toBe(true);
      expect(detectCiContext({ GITHUB_ACTIONS: '1' })).toBe(true);
      expect(detectCiContext({ CI: 'false' })).toBe(false);
      expect(detectCiContext({})).toBe(false);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('resolvePolicy returns TEAM for unknown mode', () => {
      expect(resolvePolicy('enterprise')).toBe(TEAM_POLICY);
    });

    it('resolvePolicy returns TEAM for undefined', () => {
      expect(resolvePolicy()).toBe(TEAM_POLICY);
    });

    it('resolvePolicyWithContext falls back to TEAM for unknown mode', () => {
      const result = resolvePolicyWithContext('enterprise', false);
      expect(result.requestedMode).toBe('team');
      expect(result.effectiveMode).toBe('team');
      expect(result.policy).toBe(TEAM_POLICY);
      expect(result.degradedReason).toBeUndefined();
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
    });

    it('different policies produce different hashes', () => {
      const digest = (s: string) => `hash-${s}`;
      const solo = createPolicySnapshot(SOLO_POLICY, '2026-01-01T00:00:00.000Z', digest);
      const team = createPolicySnapshot(TEAM_POLICY, '2026-01-01T00:00:00.000Z', digest);
      expect(solo.hash).not.toBe(team.hash);
    });

    it('policyFromSnapshot reconstructs actorClassification from snapshot only', () => {
      const digest = (s: string) => `hash-${s.length}`;
      const snap = createPolicySnapshot(REGULATED_POLICY, '2026-01-01T00:00:00.000Z', digest);
      const reconstructed = policyFromSnapshot(snap);
      expect(reconstructed.actorClassification).toEqual(REGULATED_POLICY.actorClassification);
      expect(reconstructed.actorClassification).toEqual(snap.actorClassification);
    });

    it('policyFromSnapshot uses snapshot fields exclusively — no preset leak', () => {
      const digest = (s: string) => `hash-${s.length}`;
      // Create a snapshot with modified actorClassification
      const snap = {
        ...createPolicySnapshot(TEAM_POLICY, '2026-01-01T00:00:00.000Z', digest),
        actorClassification: { custom_tool: 'auditor' },
      };
      const reconstructed = policyFromSnapshot(snap);
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
      expect(profile.instructions).toContain('NOT_VERIFIED');
    });

    it.each([
      ['baseline', baselineProfile],
      ['java', javaProfile],
      ['angular', angularProfile],
      ['typescript', typescriptProfile],
    ] as const)('%s profile contains ASSUMPTION marker guidance', (_name, profile) => {
      expect(profile.instructions).toContain('ASSUMPTION');
    });

    it('no built-in profile references AGENTS.md', () => {
      const allInstructions = [
        baselineProfile.instructions,
        javaProfile.instructions,
        angularProfile.instructions,
        typescriptProfile.instructions,
      ];
      for (const instr of allInstructions) {
        expect(instr).not.toContain('AGENTS.md');
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
          resolveProfileInstructions(allPhases, phase as import('../state/schema').Phase),
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
    it('existing built-in profiles work with resolveProfileInstructions (backward compat)', () => {
      // All built-in profiles use plain strings — resolveProfileInstructions should pass them through
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
    it('resolveProfileInstructions is sub-microsecond per call', () => {
      const start = performance.now();
      for (let i = 0; i < 10000; i++) {
        resolveProfileInstructions(phaseInstructions, 'PLAN');
      }
      const elapsed = performance.now() - start;
      // 10k calls < 10ms → < 1μs each
      expect(elapsed).toBeLessThan(10);
    });
  });
});

describe('config/profile/check-executors', () => {
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
    const REASON_LOOKUP_MS = 5;
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
