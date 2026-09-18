/**
 * @module shared/actor-assurance.test
 * @description Contract tests for the actor-assurance vocabulary authority:
 * tuple, schema, type guard, and ordinal comparison semantics.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect } from 'vitest';
import {
  ACTOR_ASSURANCE_TIERS,
  ActorAssuranceSchema,
  compareActorAssurance,
  isActorAssurance,
  isAssuranceAtLeast,
} from './actor-assurance.js';

describe('ACTOR_ASSURANCE_TIERS', () => {
  it('HAPPY: has three tiers in canonical ascending order', () => {
    expect(ACTOR_ASSURANCE_TIERS).toEqual(['best_effort', 'claim_validated', 'idp_verified']);
  });
});

describe('ActorAssuranceSchema', () => {
  it('HAPPY: parses every canonical tier', () => {
    for (const tier of ACTOR_ASSURANCE_TIERS) {
      expect(ActorAssuranceSchema.parse(tier)).toBe(tier);
    }
  });

  it('HAPPY: schema options mirror the canonical tuple in order', () => {
    // toEqual (not ===): these are distinct array instances with equal content.
    expect(ActorAssuranceSchema.options).toEqual([...ACTOR_ASSURANCE_TIERS]);
  });

  it('BAD: rejects removed and unknown assurance values', () => {
    for (const invalid of ['verified', 'unknown', 'BEST_EFFORT', '', ' best_effort ']) {
      expect(ActorAssuranceSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('BAD: rejects non-string values', () => {
    for (const invalid of [null, undefined, 0, 42, {}, []]) {
      expect(ActorAssuranceSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('isActorAssurance', () => {
  it('HAPPY: accepts every canonical tier', () => {
    for (const tier of ACTOR_ASSURANCE_TIERS) {
      expect(isActorAssurance(tier)).toBe(true);
    }
  });

  it('BAD: rejects removed, unknown, and non-string values', () => {
    for (const invalid of ['verified', 'unknown', '', null, undefined, 42]) {
      expect(isActorAssurance(invalid)).toBe(false);
    }
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
      for (const tier of ACTOR_ASSURANCE_TIERS) {
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
      for (const tier of ACTOR_ASSURANCE_TIERS) {
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
  it('HAPPY: equal tiers compare as zero', () => {
    for (const tier of ACTOR_ASSURANCE_TIERS) {
      expect(compareActorAssurance(tier, tier)).toBe(0);
    }
  });

  it('HAPPY: stronger > weaker and weaker < stronger', () => {
    expect(compareActorAssurance('idp_verified', 'best_effort')).toBeGreaterThan(0);
    expect(compareActorAssurance('best_effort', 'idp_verified')).toBeLessThan(0);
  });

  it('CORNER: the canonical tuple is strictly ascending under comparison', () => {
    for (let index = 1; index < ACTOR_ASSURANCE_TIERS.length; index++) {
      const weaker = ACTOR_ASSURANCE_TIERS[index - 1]!;
      const stronger = ACTOR_ASSURANCE_TIERS[index]!;
      expect(compareActorAssurance(stronger, weaker)).toBeGreaterThan(0);
      expect(compareActorAssurance(weaker, stronger)).toBeLessThan(0);
    }
  });

  it('EDGE: undefined is below all tiers', () => {
    for (const tier of ACTOR_ASSURANCE_TIERS) {
      expect(compareActorAssurance(undefined, tier)).toBeLessThan(0);
    }
    expect(compareActorAssurance(undefined, 'best_effort')).toBe(-1);
  });
});
