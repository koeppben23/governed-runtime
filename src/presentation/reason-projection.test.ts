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
import { projectActionIntent } from './human-projection.js';

describe('projectReasonFromRegistry', () => {
  it('returns null for unregistered codes (fail-closed)', () => {
    expect(projectReasonFromRegistry('NOT_A_REGISTERED_CODE')).toBeNull();
  });

  it('returns null for arbitrary non-code input', () => {
    expect(projectReasonFromRegistry('whatever') ?? null).toBeNull();
  });

  it('projects a precondition code with category-derived impact', () => {
    const projection = projectReasonFromRegistry('PLAN_REQUIRED')!;
    expect(projection).not.toBeNull();
    expect(projection.code).toBe('PLAN_REQUIRED');
    expect(projection.category).toBe('precondition');
    expect(projection.impact).toBe('workflow_blocked');
    expect(projection.summary).toContain('An approved plan is required');
    expect(projection.recovery.primary).toBe('Run /plan to create a plan');
    expect(projection.recovery.secondary).toEqual(['Get the plan approved at PLAN_REVIEW']);
  });

  it('splits a single recovery step into primary with empty secondary', () => {
    const projection = projectReasonFromRegistry('PROOFGRAPH_AGGREGATE_SCOPE_UNATTESTED')!;
    expect(projection.recovery.primary).toContain('Run the complete declared suite');
    expect(projection.recovery.secondary).toEqual([]);
  });

  it('applies documented per-code impact overrides for evidence gaps', () => {
    expect(projectReasonFromRegistry('VALIDATION_EVIDENCE_REQUIRED')!.impact).toBe(
      'verification_incomplete',
    );
    expect(projectReasonFromRegistry('PROOFGRAPH_ASSERTION_EVIDENCE_MISSING')!.impact).toBe(
      'verification_incomplete',
    );
    expect(projectReasonFromRegistry('PROOFGRAPH_ASSERTION_PROVIDER_MISMATCH')!.impact).toBe(
      'verification_incomplete',
    );
  });

  it('falls back to category-derived impact when no override exists', () => {
    expect(projectReasonFromRegistry('DISCOVERY_DRIFT_BLOCKED')!.impact).toBe('workflow_blocked');
  });

  it('interpolates vars through the canonical registry authority', () => {
    const projection = projectReasonFromRegistry('DISCOVERY_DRIFT_BLOCKED', {
      driftStatus: 'changed',
    })!;
    expect(projection.summary).toContain('verdict is changed');
  });

  it('projects quick-fix command tokens into deduplicated actions', () => {
    const projection = projectReasonFromRegistry('VALIDATION_INCOMPLETE')!;
    expect(projection.projectedActions).toHaveLength(1);
    const action = projection.projectedActions[0]!;
    expect(action.intent).toBe('run_validation');
    expect(action.presentationAction?.invocation).toBe('/validate');
    expect(action.presentationAction?.visibility).toBe('available');
  });

  it('omits actions for command tokens without a projected intent', () => {
    const projection = projectReasonFromRegistry('PLAN_REQUIRED')!;
    expect(projection.projectedActions).toEqual([]);
  });
});

describe('projectActionIntent', () => {
  it('maps a canonical command to an available presentation action', () => {
    const action = projectActionIntent('/why')!;
    expect(action.intent).toBe('inspect_blocker');
    expect(action.title).toContain('blocker');
    expect(action.presentationAction?.invocation).toBe('/why');
  });

  it('returns null for unknown commands', () => {
    expect(projectActionIntent('/not-a-command')).toBeNull();
  });
});

describe('projectImpact', () => {
  it('classifies each category deterministically', () => {
    const expectations: Readonly<Record<string, string>> = {
      precondition: 'workflow_blocked',
      admissibility: 'workflow_blocked',
      input: 'workflow_blocked',
      identity: 'review_required',
      state: 'workflow_blocked',
      config: 'workflow_blocked',
      adapter: 'degraded_only',
    };
    for (const [category, expected] of Object.entries(expectations)) {
      expect(projectImpact(category as never, 'ANY_CODE')).toBe(expected);
    }
  });
});

describe('toRecoveryProjection', () => {
  it('keeps ordered steps with the first as primary', () => {
    expect(toRecoveryProjection(['one', 'two', 'three'])).toEqual({
      primary: 'one',
      secondary: ['two', 'three'],
    });
  });

  it('handles empty input with an empty primary', () => {
    expect(toRecoveryProjection([])).toEqual({ primary: '', secondary: [] });
  });
});
