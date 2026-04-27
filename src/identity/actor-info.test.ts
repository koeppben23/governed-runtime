/**
 * @module identity/actor-info.test
 * @description Tests for actor assurance comparison helpers.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import { isAssuranceAtLeast, compareActorAssurance, ASSURANCE_TIERS } from './actor-info.js';

describe('ASSURANCE_TIERS', () => {
  it('has three tiers in ascending order', () => {
    expect(ASSURANCE_TIERS).toEqual(['best_effort', 'claim_validated', 'idp_verified']);
  });
});

describe('isAssuranceAtLeast', () => {
  describe('HAPPY', () => {
    it('best_effort >= best_effort', () => {
      expect(isAssuranceAtLeast('best_effort', 'best_effort')).toBe(true);
    });

    it('claim_validated >= best_effort', () => {
      expect(isAssuranceAtLeast('claim_validated', 'best_effort')).toBe(true);
    });

    it('idp_verified >= claim_validated', () => {
      expect(isAssuranceAtLeast('idp_verified', 'claim_validated')).toBe(true);
    });

    it('idp_verified >= best_effort', () => {
      expect(isAssuranceAtLeast('idp_verified', 'best_effort')).toBe(true);
    });
  });

  describe('BAD', () => {
    it('best_effort < claim_validated', () => {
      expect(isAssuranceAtLeast('best_effort', 'claim_validated')).toBe(false);
    });

    it('claim_validated < idp_verified', () => {
      expect(isAssuranceAtLeast('claim_validated', 'idp_verified')).toBe(false);
    });

    it('best_effort < idp_verified', () => {
      expect(isAssuranceAtLeast('best_effort', 'idp_verified')).toBe(false);
    });
  });

  describe('CORNER', () => {
    it('same tier is always sufficient', () => {
      for (const tier of ASSURANCE_TIERS) {
        expect(isAssuranceAtLeast(tier, tier)).toBe(true);
      }
    });

    it('undefined actual is below any required', () => {
      expect(isAssuranceAtLeast(undefined, 'best_effort')).toBe(false);
      expect(isAssuranceAtLeast(undefined, 'claim_validated')).toBe(false);
      expect(isAssuranceAtLeast(undefined, 'idp_verified')).toBe(false);
    });
  });

  describe('EDGE', () => {
    it('no tier can be below best_effort except undefined', () => {
      for (const tier of ASSURANCE_TIERS) {
        expect(isAssuranceAtLeast(tier, 'best_effort')).toBe(true);
      }
    });

    it('only idp_verified can meet idp_verified', () => {
      expect(isAssuranceAtLeast('best_effort', 'idp_verified')).toBe(false);
      expect(isAssuranceAtLeast('claim_validated', 'idp_verified')).toBe(false);
      expect(isAssuranceAtLeast('idp_verified', 'idp_verified')).toBe(true);
    });
  });
});

describe('compareActorAssurance', () => {
  it('equal tiers compare as zero', () => {
    expect(compareActorAssurance('best_effort', 'best_effort')).toBe(0);
  });

  it('stronger > weaker', () => {
    expect(compareActorAssurance('idp_verified', 'best_effort')).toBeGreaterThan(0);
  });

  it('weaker < stronger', () => {
    expect(compareActorAssurance('best_effort', 'idp_verified')).toBeLessThan(0);
  });

  it('undefined is below all tiers', () => {
    expect(compareActorAssurance(undefined, 'best_effort')).toBeLessThan(0);
  });

  describe('PERF', () => {
    it('1000 comparisons complete in < 1ms', () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        isAssuranceAtLeast('claim_validated', 'best_effort');
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(1);
    });
  });
});
