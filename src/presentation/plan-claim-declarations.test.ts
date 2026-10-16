/**
 * @module presentation/plan-claim-declarations.test
 * @description Reviewer-facing plan claim rendering names the evidence ROLE of
 * every check, so a reviewer never infers a role from a check id or an
 * assertion name, and states the separate-attempt contract for evidence roles
 * without implying that execution evidence exists at plan-review time.
 *
 * Regressions for two observed plan-review false positives:
 * - FP1: a counterexample bound to `build` was read as bound to `test`.
 * - FP2: positive and counterexample evidence were assumed to share an attempt
 *   because the two checks run overlapping test suites.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, expect, it } from 'vitest';
import type { PlanClaimDeclarations } from '../state/proofgraph-approval.js';
import { EVIDENCE_ROLES_LINE, renderPlanClaimDeclarations } from './plan-claim-declarations.js';

const CLAIM_ID = '11111111-1111-4111-8111-111111111111';

function declarations(
  counterexample?: NonNullable<
    PlanClaimDeclarations['claims'][number]['counterexampleRequirement']
  >,
): PlanClaimDeclarations {
  return {
    flow: 'plan',
    version: 'v2',
    claims: [
      {
        claimId: CLAIM_ID,
        statement: 'ModuleStateStore.write rejects writes with missing or blank ownership values.',
        critical: true,
        authoritySectionId: 'Invariant',
        claimScope: 'specific_behavior',
        expectedCheckId: 'test',
        ...(counterexample ? { counterexampleRequirement: counterexample } : {}),
      },
    ],
  };
}

const FIXTURE_COUNTEREXAMPLE = {
  kind: 'assertion' as const,
  checkId: 'build',
  assertion: {
    providerId: 'junit',
    localId: 'fixture.StateNoteFalsificationProbeTest#rejectsMissingOrBlankOwnership',
  },
};

describe('renderPlanClaimDeclarations - evidence roles', () => {
  it('HAPPY: names the positive and the counterexample check by role (FP1)', () => {
    const text = renderPlanClaimDeclarations(declarations(FIXTURE_COUNTEREXAMPLE));
    expect(text).toContain('  - Positive evidence check: test');
    expect(text).toContain(
      '  - Counterexample (adversarial) check: build; assertion providerId: junit; ' +
        'localId: fixture.StateNoteFalsificationProbeTest#rejectsMissingOrBlankOwnership',
    );
    expect(text).not.toContain('Expected check:');
    expect(text).not.toContain('Counterexample requirement:');
  });

  it('HAPPY: states the separate-attempt role contract without demanding plan-time execution (FP2)', () => {
    const text = renderPlanClaimDeclarations(declarations(FIXTURE_COUNTEREXAMPLE));
    expect(text).toContain(`  - ${EVIDENCE_ROLES_LINE}`);
    expect(EVIDENCE_ROLES_LINE).toContain(
      'separate validation attempts with distinct attempt identities',
    );
    expect(EVIDENCE_ROLES_LINE).toContain('overlapping underlying test suites do not imply');
    expect(EVIDENCE_ROLES_LINE).toContain('execution evidence is not required at plan-review time');
  });

  it('CORNER: an aggregate counterexample keeps its role label and the role contract', () => {
    const text = renderPlanClaimDeclarations(
      declarations({ kind: 'aggregate_check', checkId: 'build', candidateId: 'vc_build' }),
    );
    expect(text).toContain(
      '  - Counterexample (adversarial) check: build; aggregate candidateId: vc_build',
    );
    expect(text).toContain(EVIDENCE_ROLES_LINE);
  });

  it('BAD: a claim without a counterexample gets no role contract', () => {
    const text = renderPlanClaimDeclarations(declarations());
    expect(text).toContain('  - Counterexample (adversarial) check: none');
    expect(text).not.toContain(EVIDENCE_ROLES_LINE);
  });

  it('BAD: no declarations render the explicit empty marker', () => {
    expect(renderPlanClaimDeclarations(undefined)).toBe('No plan claim declarations recorded.');
  });
});
