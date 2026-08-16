/**
 * @module integration/review/review-profile-freeze.test
 * @description Wave 1 (#730) — verifies the mandatory 'core' review profile is
 * frozen into obligations before invocation, resolves fail-closed, and stays in
 * lockstep with the canonical config-layer ReviewProfile.
 */
import { describe, it, expect } from 'vitest';

import { ReviewProfile as StateReviewProfile } from '../../state/evidence.js';
import type { ReviewProfile as ConfigReviewProfile } from '../../config/policy-types.js';
import {
  artifactReviewSubjectScope,
  createReviewObligation,
  resolveFrozenReviewProfile,
} from './assurance.js';

const NOW = '2026-01-01T00:00:00.000Z';

describe('review profile freeze (Wave 1 — #730)', () => {
  describe('config/state ReviewProfile parity', () => {
    it('state Zod enum values equal the config type domain', () => {
      // Compile-time proof the two definitions share the same string union.
      const core: ConfigReviewProfile = 'core';
      const full: ConfigReviewProfile = 'full';
      expect(StateReviewProfile.options).toEqual([core, full]);
    });
  });

  describe('resolveFrozenReviewProfile — fail-closed to core', () => {
    it('resolves core for a core snapshot', () => {
      expect(resolveFrozenReviewProfile({ reviewProfile: 'core' })).toBe('core');
    });

    it('resolves full for a full snapshot', () => {
      expect(resolveFrozenReviewProfile({ reviewProfile: 'full' })).toBe('full');
    });

    it('resolves core (fail-closed) for missing profile', () => {
      expect(resolveFrozenReviewProfile({})).toBe('core');
      expect(resolveFrozenReviewProfile(null)).toBe('core');
      expect(resolveFrozenReviewProfile(undefined)).toBe('core');
    });

    it('resolves core (fail-closed) for invalid profile — never off', () => {
      expect(resolveFrozenReviewProfile({ reviewProfile: 'off' })).toBe('core');
      expect(resolveFrozenReviewProfile({ reviewProfile: '' })).toBe('core');
      expect(resolveFrozenReviewProfile({ reviewProfile: 'FULL' })).toBe('core');
    });
  });

  describe('createReviewObligation freezes the profile before invocation', () => {
    it('defaults to the mandatory core baseline when no profile is supplied', () => {
      const obligation = createReviewObligation({
        obligationType: 'plan',
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
        iteration: 0,
        planVersion: 1,
        now: NOW,
        subjectDigest: 'test',
        reviewSubjectScope: artifactReviewSubjectScope('plan', '# Overview\nBody', 'test'),
      });
      expect(obligation.reviewProfile).toBe('core');
      expect(obligation.profileSource).toBe('policy_default');
      // Freeze happens at creation, while status is still pending (pre-invocation).
      expect(obligation.status).toBe('pending');
    });

    it('honors an explicitly frozen profile and source', () => {
      const obligation = createReviewObligation({
        obligationType: 'implement',
        iteration: 1,
        planVersion: 2,
        now: NOW,
        subjectDigest: 'test',
        reviewSubjectScope: { kind: 'implementation', implementationDigest: 'test' },
        reviewProfile: 'full',
        profileSource: 'runtime_required_full',
      });
      expect(obligation.reviewProfile).toBe('full');
      expect(obligation.profileSource).toBe('runtime_required_full');
    });
  });
});
