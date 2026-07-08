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
