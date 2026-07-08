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

describe('config/profile — activeChecks derived from discovery', () => {
  it('baselineProfile.activeChecks is empty (derived at hydrate-time)', () => {
    expect(baselineProfile.activeChecks).toEqual([]);
  });

  it('baselineProfile has no checks property', () => {
    expect(baselineProfile).not.toHaveProperty('checks');
  });

  it('all profiles have empty activeChecks and no checks', () => {
    for (const profile of [baselineProfile, javaProfile, angularProfile, typescriptProfile]) {
      expect(profile.activeChecks).toBeDefined();
      expect(profile.activeChecks).toEqual([]);
      expect(profile).not.toHaveProperty('checks');
    }
  });
});
