/**
 * @module documentation/live-risk-trigger-controls.test
 * @description Fail-closed oracles for the #1074 risk-trigger coverage controls.
 */
import { describe, expect, it } from 'vitest';
import {
  ADVERSARIAL_ASSERTION,
  assertRetainedClaim,
  assertStateIntegrityTrigger,
  claimDeclaration,
} from '../../../demos/risk-trigger-fixture/run-live-risk-trigger-controls.mjs';

function state(covered: boolean) {
  return {
    phase: 'EVIDENCE_REVIEW',
    implementationRiskAssessment: { riskTriggers: ['state_integrity'] },
    plan: {
      claimDeclarations: {
        claims: [{ claimId: '11111111-1111-4111-8111-111111111111', ...claimDeclaration(covered) }],
      },
    },
  };
}

describe('risk-trigger control oracles', () => {
  it('requires the detected state_integrity trigger from the real change', () => {
    expect(assertStateIntegrityTrigger(state(false)).riskTriggers).toEqual(['state_integrity']);
    expect(() =>
      assertStateIntegrityTrigger({ implementationRiskAssessment: { riskTriggers: [] } }),
    ).toThrow(/not detected/);
    expect(() => assertStateIntegrityTrigger({ implementationRiskAssessment: null })).toThrow(
      /not detected/,
    );
  });

  it('binds coverage to the approved claim set and never after approval', () => {
    const covered = state(true);
    covered.plan.claimDeclarations.claims[0]!.coversRiskTriggers = ['state_integrity'];
    expect(assertRetainedClaim(covered, true)).toBe('11111111-1111-4111-8111-111111111111');
    const missing = state(false);
    expect(() => assertRetainedClaim(missing, true)).toThrow(/does not cover state_integrity/);
    const unexpected = state(true);
    unexpected.plan.claimDeclarations.claims[0]!.coversRiskTriggers = ['state_integrity'];
    expect(() => assertRetainedClaim(unexpected, false)).toThrow(/must not declare coverage/);
  });

  it('rejects withdrawal, weakening and a foreign adversarial assertion', () => {
    const empty = state(false);
    empty.plan.claimDeclarations.claims = [];
    expect(() => assertRetainedClaim(empty, false)).toThrow(/retained critical plan claim/);
    const weakened = state(false);
    weakened.plan.claimDeclarations.claims[0]!.critical = false;
    expect(() => assertRetainedClaim(weakened, false)).toThrow(/changed or weakened/);
    const foreign = state(false);
    foreign.plan.claimDeclarations.claims[0]!.counterexampleRequirement.assertion.localId =
      'other#method';
    expect(() => assertRetainedClaim(foreign, false)).toThrow(/changed or weakened/);
    expect(claimDeclaration(true).coversRiskTriggers).toEqual(['state_integrity']);
    expect(claimDeclaration(false)).not.toHaveProperty('coversRiskTriggers');
    expect(claimDeclaration(true).counterexampleRequirement.assertion.localId).toBe(
      ADVERSARIAL_ASSERTION,
    );
  });
});
