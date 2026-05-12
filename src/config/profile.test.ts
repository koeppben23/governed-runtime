import { describe, it, expect } from 'vitest';
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
import type { RepoSignals, PhaseInstructions } from '../config/profile.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';

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
      registry.register({ id: 'test', name: 'Test 1', activeChecks: [] });
      registry.register({ id: 'test', name: 'Test 2', activeChecks: [] });
      expect(registry.get('test')?.name).toBe('Test 2');
      expect(registry.size).toBe(1);
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('profile without detect function cannot be auto-detected', () => {
      const registry = new ProfileRegistry();
      registry.register({ id: 'manual', name: 'Manual', activeChecks: [] });
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

// P10a: profiles expose activeChecks but no heuristic check executors
describe('config/P10a — no heuristic executors', () => {
  it('baselineProfile.activeChecks contains test_quality and rollback_safety', () => {
    expect(baselineProfile.activeChecks).toContain('test_quality');
    expect(baselineProfile.activeChecks).toContain('rollback_safety');
    expect(baselineProfile.activeChecks).toHaveLength(2);
  });

  it('baselineProfile has no checks property', () => {
    expect(baselineProfile).not.toHaveProperty('checks');
  });

  it('all profiles have activeChecks but no checks', () => {
    for (const profile of [baselineProfile, javaProfile, angularProfile, typescriptProfile]) {
      expect(profile.activeChecks).toBeDefined();
      expect(profile.activeChecks.length).toBeGreaterThanOrEqual(2);
      expect(profile).not.toHaveProperty('checks');
    }
  });
});
