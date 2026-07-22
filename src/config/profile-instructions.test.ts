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

    it('Baseline profile has 12 examples', () => {
      const impl = resolveProfileInstructions(baselineProfile.instructions, 'IMPLEMENTATION');
      const matches = impl.match(/<example id="/g);
      expect(matches).toHaveLength(12);
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

    it('Baseline examples cover B01-B12', () => {
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
        'AP-B09',
        'AP-B10',
        'AP-B11',
        'AP-B12',
      ]) {
        expect(impl).toContain(`id="${id}"`);
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

    it.each(ALL_PROFILES)(
      '$name profile PLAN_REVIEW includes Discovery evidence check but NOT flowguard_status',
      ({ profile }) => {
        const resolved = resolveProfileInstructions(profile.instructions, 'PLAN_REVIEW');
        expect(resolved).toContain('Discovery Evidence Check');
        expect(resolved).toContain('Discovery Context');
        expect(resolved).toContain('Review Checklist');
        expect(resolved).not.toContain('flowguard_status.detectedStack');
        expect(resolved).not.toContain('flowguard_status.verificationCandidates');
        expect(resolved).not.toContain('<examples>');
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

    it.each(ALL_PROFILES)(
      '$name profile EVIDENCE_REVIEW does NOT contain Discovery evidence check',
      ({ profile }) => {
        const resolved = resolveProfileInstructions(profile.instructions, 'EVIDENCE_REVIEW');
        expect(resolved).toContain('Review Checklist');
        expect(resolved).not.toContain('Discovery Evidence Check');
        expect(resolved).not.toContain('flowguard_status.detectedStack');
        expect(resolved).not.toContain('flowguard_status.verificationCandidates');
        expect(resolved).not.toContain('<examples>');
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
