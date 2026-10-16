/**
 * @module presentation/plan-claim-declarations.test
 * @description Reviewer-facing plan claim rendering names the evidence ROLE of
 * every check, so a reviewer never infers a role from a check id or an
 * assertion name (FP1: a counterexample bound to `build` was read as bound to
 * `test`). The shared evidence-role rule is a plan review criterion stated once
 * in the task contract; claim rendering carries only the concrete bindings.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, expect, it } from 'vitest';
import type { PlanClaimDeclarations } from '../state/proofgraph-approval.js';
import { renderPlanClaimDeclarations } from './plan-claim-declarations.js';

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

describe('renderPlanClaimDeclarations - positive assertion binding', () => {
  function withPositiveAssertion(): PlanClaimDeclarations {
    const base = declarations(FIXTURE_COUNTEREXAMPLE);
    return {
      ...base,
      claims: [
        {
          ...base.claims[0]!,
          expectedAssertion: {
            providerId: 'junit',
            localId: 'fixture.StateNoteTest#rejectsMissingOwnership',
          },
        },
      ],
    };
  }

  it('renders the positive assertion identity when the declaration carries it', () => {
    const text = renderPlanClaimDeclarations(withPositiveAssertion());
    expect(text).toContain(
      '  - Positive evidence assertion: providerId: junit; ' +
        'localId: fixture.StateNoteTest#rejectsMissingOwnership',
    );
  });

  it('omits the positive assertion line for declarations without the optional field', () => {
    // Existing declarations stay valid and render unchanged: the optional
    // field never synthesizes a binding that was not declared.
    const text = renderPlanClaimDeclarations(declarations(FIXTURE_COUNTEREXAMPLE));
    expect(text).not.toContain('Positive evidence assertion');
    expect(text).toContain('  - Positive evidence check: test');
  });

  it('round-trips through the canonical declaration schema with and without the field', async () => {
    const { PlanClaimDeclaration } = await import('../state/proofgraph-approval.js');
    const withoutField = PlanClaimDeclaration.parse(declarations(FIXTURE_COUNTEREXAMPLE).claims[0]);
    expect('expectedAssertion' in withoutField).toBe(false);
    const withField = PlanClaimDeclaration.parse(withPositiveAssertion().claims[0]);
    expect(withField.expectedAssertion).toEqual({
      providerId: 'junit',
      localId: 'fixture.StateNoteTest#rejectsMissingOwnership',
    });
    // Canonical digests differ only because the declaration differs.
    const { canonicalJsonStringify } = await import('../shared/canonical-json.js');
    expect(canonicalJsonStringify(withField)).not.toEqual(canonicalJsonStringify(withoutField));
  });
});

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

  it('HAPPY: carries no per-claim copy of the shared evidence-role rule', () => {
    const text = renderPlanClaimDeclarations(declarations(FIXTURE_COUNTEREXAMPLE));
    expect(text).not.toContain('Evidence roles');
    expect(text).not.toContain('attempt identit');
    expect(text.split('\n').filter((line) => line.startsWith('  - '))).toHaveLength(8);
  });

  it('CORNER: an aggregate counterexample keeps its role label', () => {
    const text = renderPlanClaimDeclarations(
      declarations({ kind: 'aggregate_check', checkId: 'build', candidateId: 'vc_build' }),
    );
    expect(text).toContain(
      '  - Counterexample (adversarial) check: build; aggregate candidateId: vc_build',
    );
  });

  it('BAD: a claim without a counterexample renders an explicit none', () => {
    const text = renderPlanClaimDeclarations(declarations());
    expect(text).toContain('  - Counterexample (adversarial) check: none');
  });

  it('BAD: no declarations render the explicit empty marker', () => {
    expect(renderPlanClaimDeclarations(undefined)).toBe('No plan claim declarations recorded.');
  });
});
