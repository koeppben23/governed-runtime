import { describe, it, expect } from 'vitest';
import {
  projectHumanVerificationStatus,
  humanVerificationLabel,
  humanVerificationExplanation,
} from './human-verification.js';
import type { ClaimVerificationState } from '../state/proofgraph-primitives.js';

const ALL_STATES: readonly ClaimVerificationState[] = [
  'PROVEN',
  'UNPROVEN',
  'NOT_VERIFIED',
  'CONTRADICTED',
  'STALE',
  'BLOCKED',
];

describe('human-verification vocabulary', () => {
  it('PROVEN maps to verified and label "Verified"', () => {
    expect(projectHumanVerificationStatus('PROVEN')).toBe('verified');
    expect(humanVerificationLabel('PROVEN')).toBe('Verified');
  });

  it('UNPROVEN maps to not_verified and label "Not verified"', () => {
    expect(projectHumanVerificationStatus('UNPROVEN')).toBe('not_verified');
    expect(humanVerificationLabel('UNPROVEN')).toBe('Not verified');
  });

  it('NOT_VERIFIED maps to not_verified and label "Not verified"', () => {
    expect(projectHumanVerificationStatus('NOT_VERIFIED')).toBe('not_verified');
    expect(humanVerificationLabel('NOT_VERIFIED')).toBe('Not verified');
  });

  it('CONTRADICTED maps to failed and label "Failed"', () => {
    expect(projectHumanVerificationStatus('CONTRADICTED')).toBe('failed');
    expect(humanVerificationLabel('CONTRADICTED')).toBe('Failed');
  });

  it('STALE maps to needs_recheck and label "Needs re-check"', () => {
    expect(projectHumanVerificationStatus('STALE')).toBe('needs_recheck');
    expect(humanVerificationLabel('STALE')).toBe('Needs re-check');
  });

  it('BLOCKED maps to blocked and label "Blocked"', () => {
    expect(projectHumanVerificationStatus('BLOCKED')).toBe('blocked');
    expect(humanVerificationLabel('BLOCKED')).toBe('Blocked');
  });

  it('only PROVEN produces verified status', () => {
    for (const state of ALL_STATES) {
      const human = projectHumanVerificationStatus(state);
      if (state === 'PROVEN') {
        expect(human).toBe('verified');
      } else {
        expect(human).not.toBe('verified');
      }
    }
  });

  it('only CONTRADICTED produces failed status', () => {
    for (const state of ALL_STATES) {
      const human = projectHumanVerificationStatus(state);
      expect(human === 'failed').toBe(state === 'CONTRADICTED');
    }
  });

  it('only STALE produces needs_recheck status', () => {
    for (const state of ALL_STATES) {
      const human = projectHumanVerificationStatus(state);
      expect(human === 'needs_recheck').toBe(state === 'STALE');
    }
  });

  it('only BLOCKED produces blocked status', () => {
    for (const state of ALL_STATES) {
      const human = projectHumanVerificationStatus(state);
      expect(human === 'blocked').toBe(state === 'BLOCKED');
    }
  });

  it('UNPROVEN and NOT_VERIFIED produce same human status but distinct canonical labels in explanation', () => {
    expect(projectHumanVerificationStatus('UNPROVEN')).toBe(
      projectHumanVerificationStatus('NOT_VERIFIED'),
    );
    expect(humanVerificationLabel('UNPROVEN')).toBe(humanVerificationLabel('NOT_VERIFIED'));
    expect(humanVerificationExplanation('UNPROVEN')).not.toBe(
      humanVerificationExplanation('NOT_VERIFIED'),
    );
  });

  it('PROVEN explanation does not leak domain internals', () => {
    const expl = humanVerificationExplanation('PROVEN');
    expect(expl).toContain('sufficient');
    expect(expl).not.toContain('PROVEN');
    expect(expl).not.toContain('digest');
  });

  it('STALE explanation references the current verification subject', () => {
    expect(humanVerificationExplanation('STALE')).toContain('no longer current');
  });

  it('CONTRADICTED explanation states observed evidence contradicts', () => {
    expect(humanVerificationExplanation('CONTRADICTED')).toContain('contradicts');
  });

  it('every canonical state produces a non-empty label and explanation', () => {
    for (const state of ALL_STATES) {
      expect(humanVerificationLabel(state).length).toBeGreaterThan(0);
      expect(humanVerificationExplanation(state).length).toBeGreaterThan(0);
    }
  });
});
