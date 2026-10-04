/**
 * @module presentation/reason-projection
 * @description Tests for reason projection onto human surfaces.
 */

import { describe, expect, it } from 'vitest';
import {
  projectReasonFromRegistry,
  projectImpact,
  toRecoveryProjection,
} from './reason-projection.js';

describe('projectReasonFromRegistry', () => {
  it('returns null for unregistered codes (fail-closed)', () => {
    expect(projectReasonFromRegistry('NOT_A_REGISTERED_CODE')).toBeNull();
  });

  it('returns null for arbitrary non-code input', () => {
    expect(projectReasonFromRegistry('whatever') ?? null).toBeNull();
  });

  it('projects a registered code with registry verbatim headline and split recovery', () => {
    const projection = projectReasonFromRegistry('PLAN_REQUIRED')!;
    expect(projection).not.toBeNull();
    expect(projection.code).toBe('PLAN_REQUIRED');
    expect(projection.category).toBe('precondition');
    expect(projection.headline).toContain('An approved plan is required');
    expect(projection.recovery.primary).toBe('Run /plan to create a plan');
    expect(projection.recovery.secondary).toEqual(['Get the plan approved at PLAN_REVIEW']);
  });

  it('splits a single recovery step into primary with empty secondary', () => {
    const projection = projectReasonFromRegistry('PROOFGRAPH_AGGREGATE_SCOPE_UNATTESTED')!;
    expect(projection.recovery.primary).toContain('Run the complete declared suite');
    expect(projection.recovery.secondary).toEqual([]);
  });

  it('carries an impact only for explicitly migrated codes', () => {
    expect(projectReasonFromRegistry('VALIDATION_EVIDENCE_REQUIRED')!.impact).toBe(
      'verification_incomplete',
    );
    expect(projectReasonFromRegistry('PROOFGRAPH_CERTIFICATE_INVALID')!.impact).toBe(
      'verification_incomplete',
    );
    expect(projectReasonFromRegistry('FOUR_EYES_ACTOR_MATCH')!.impact).toBe('review_required');
    expect(projectReasonFromRegistry('DISCOVERY_DRIFT_BLOCKED')!.impact).toBe('workflow_blocked');
  });

  it('projects NO impact for unmigrated codes (never inferred from category)', () => {
    expect(projectReasonFromRegistry('READ_FAILED')!.impact).toBeUndefined();
    expect(projectReasonFromRegistry('CENTRAL_POLICY_UNREADABLE')!.impact).toBeUndefined();
    expect(projectReasonFromRegistry('ACTOR_CLAIM_INVALID')!.impact).toBeUndefined();
    expect(
      projectReasonFromRegistry('PROOFGRAPH_ASSERTION_EVIDENCE_MISSING')!.impact,
    ).toBeUndefined();
    expect(
      projectReasonFromRegistry('PROOFGRAPH_AGGREGATE_SCOPE_UNATTESTED')!.impact,
    ).toBeUndefined();
  });

  it('replaces the headline with human copy and preserves the interpolated detail in canonicalMessage', () => {
    const projection = projectReasonFromRegistry('DISCOVERY_DRIFT_BLOCKED', {
      driftStatus: 'changed',
    })!;
    expect(projection.headline).toBe('Discovery drift blocks mutating tools');
    expect(projection.headline).not.toContain('changed');
    expect(projection.explanation).toBeDefined();
    expect(projection.canonicalMessage).toContain('Discovery drift verdict is');
    expect(projection.canonicalMessage).toContain('verdict is changed');
  });

  it('omits canonicalMessage and explanation for unmigrated codes', () => {
    const projection = projectReasonFromRegistry('PLAN_REQUIRED')!;
    expect('canonicalMessage' in projection).toBe(false);
    expect('explanation' in projection).toBe(false);
  });
});

describe('projectImpact', () => {
  it('is an explicit per-code lookup, not a category heuristic', () => {
    expect(projectImpact('VALIDATION_EVIDENCE_REQUIRED')).toBe('verification_incomplete');
    expect(projectImpact('PROOFGRAPH_CERTIFICATE_INVALID')).toBe('verification_incomplete');
    expect(projectImpact('FOUR_EYES_ACTOR_MATCH')).toBe('review_required');
    expect(projectImpact('DISCOVERY_DRIFT_BLOCKED')).toBe('workflow_blocked');
  });

  it('returns undefined for unmigrated codes of every category', () => {
    expect(projectImpact('READ_FAILED')).toBeUndefined();
    expect(projectImpact('ACTOR_CLAIM_INVALID')).toBeUndefined();
    expect(projectImpact('CENTRAL_POLICY_UNREADABLE')).toBeUndefined();
    expect(projectImpact('PROOFGRAPH_AGGREGATE_SCOPE_UNATTESTED')).toBeUndefined();
    expect(projectImpact('PROOFGRAPH_ASSERTION_PROVIDER_MISMATCH')).toBeUndefined();
  });
});

describe('toRecoveryProjection', () => {
  it('keeps ordered steps with the first as primary', () => {
    expect(toRecoveryProjection(['one', 'two', 'three'])).toEqual({
      primary: 'one',
      secondary: ['two', 'three'],
    });
  });

  it('enforces the non-empty recovery invariant instead of inventing an empty primary', () => {
    expect(() => toRecoveryProjection([])).toThrow(/at least one recovery step/);
  });
});
