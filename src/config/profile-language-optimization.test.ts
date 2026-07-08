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
