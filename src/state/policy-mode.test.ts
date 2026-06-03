/**
 * @module state/policy-mode.test
 * @description Tests for the canonical policy-mode SSOT (#418).
 */
import { describe, it, expect } from 'vitest';
import {
  POLICY_MODES,
  PolicyModeSchema,
  CENTRAL_MINIMUM_MODES,
  CentralMinimumModeSchema,
  isPolicyMode,
} from './policy-mode.js';

describe('state/policy-mode (SSOT)', () => {
  describe('HAPPY', () => {
    it.each([...POLICY_MODES])('PolicyModeSchema accepts canonical mode %p', (mode) => {
      expect(PolicyModeSchema.parse(mode)).toBe(mode);
      expect(isPolicyMode(mode)).toBe(true);
    });

    it.each([...CENTRAL_MINIMUM_MODES])(
      'CentralMinimumModeSchema accepts minimum mode %p',
      (mode) => {
        expect(CentralMinimumModeSchema.parse(mode)).toBe(mode);
      },
    );

    it('exposes exactly the four canonical modes in order', () => {
      expect(POLICY_MODES).toEqual(['solo', 'team', 'team-ci', 'regulated']);
    });

    it('central minimum modes intentionally exclude team-ci', () => {
      expect(CENTRAL_MINIMUM_MODES).not.toContain('team-ci');
    });
  });

  describe('BAD — fail closed', () => {
    it.each(['regulatd', 'Regulated', 'regulated ', '', 'team_ci', 'admin', ' solo'])(
      'PolicyModeSchema rejects invalid mode %p',
      (bad) => {
        expect(PolicyModeSchema.safeParse(bad).success).toBe(false);
        expect(isPolicyMode(bad)).toBe(false);
      },
    );

    it.each([undefined, null, 1, {}, [], true])('isPolicyMode rejects non-string %p', (bad) => {
      expect(isPolicyMode(bad)).toBe(false);
    });

    it('CentralMinimumModeSchema rejects team-ci (not a valid floor)', () => {
      expect(CentralMinimumModeSchema.safeParse('team-ci').success).toBe(false);
    });
  });
});
