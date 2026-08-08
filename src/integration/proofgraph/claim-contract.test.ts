/**
 * Claim-declaration contract at the write boundaries (#762).
 *
 * A critical claim requires executed adversarial evidence to become PROVEN. A
 * critical declaration without a counterexample check is therefore structurally
 * unprovable and, with the gate unconditional, would block the final approval
 * forever with no recovery. The same holds for inactive checks and unregistered
 * surfaces or profiles.
 *
 * These tests pin that such declarations are rejected where they are authored,
 * and that diagnostics speak each tool's PUBLIC field names.
 */

import { describe, expect, it } from 'vitest';
import {
  buildHeuristicRiskWarning,
  validateProofClaimContract,
  type NormalizedClaimDeclaration,
} from './claim-contract.js';
import { isRiskAssessmentCurrent } from '../../audit/proofgraph/gate.js';

const CLAIM_A = '10000000-0000-4000-8000-00000000000a';
const CLAIM_B = '10000000-0000-4000-8000-00000000000b';

const BASE = {
  activeChecks: ['build', 'security'] as const,
  allowedSurfaces: ['command-registration', 'config-defaults'] as const,
  allowedMutationProfiles: ['proofgraph-evaluator', 'proofgraph-gate'] as const,
  verificationCandidates: [
    {
      assertionCapability: 'unsupported' as const,
      kind: 'build' as const,
      command: './mvnw verify',
      source: 'repo:mvnw',
      confidence: 'high' as const,
      reason: 'Maven build',
    },
    {
      assertionCapability: 'structured' as const,
      kind: 'security' as const,
      command: './mvnw test',
      source: 'repo:mvnw',
      confidence: 'high' as const,
      reason: 'JUnit via Maven wrapper (test)',
      assertionReport: {
        collection: 'snapshot_diff' as const,
        transport: 'file' as const,
        format: 'junit_xml' as const,
        providerId: 'junit' as const,
        standardPatterns: ['target/surefire-reports/TEST-*.xml'],
      },
    },
  ],
};

function planClaim(
  overrides: Partial<NormalizedClaimDeclaration> = {},
): NormalizedClaimDeclaration {
  return {
    claimId: CLAIM_A,
    statement: 'updateTask rejects unknown ids',
    critical: true,
    claimScope: 'specific_behavior',
    positiveCheckId: 'build',
    counterexampleRequirement: {
      checkId: 'security',
      kind: 'assertion',
      assertion: { providerId: 'junit', localId: 'com.example.Test#testMethod' },
    },
    authoritySectionId: 'step-1',
    ...overrides,
  };
}

describe('validateProofClaimContract — accepted declarations', () => {
  it('accepts a complete critical plan claim', () => {
    expect(validateProofClaimContract({ ...BASE, source: 'plan', claims: [planClaim()] })).toEqual({
      kind: 'ok',
    });
  });

  it('accepts a non-critical claim without a counterexample check', () => {
    const claim = planClaim({ critical: false, counterexampleRequirement: undefined });
    expect(validateProofClaimContract({ ...BASE, source: 'plan', claims: [claim] })).toEqual({
      kind: 'ok',
    });
  });

  it('accepts an empty claim set — a claims-free change stays legitimate', () => {
    expect(validateProofClaimContract({ ...BASE, source: 'plan', claims: [] })).toEqual({
      kind: 'ok',
    });
  });
});

describe('validateProofClaimContract — critical contract', () => {
  it('rejects a suite claim with a single assertion requirement', () => {
    const result = validateProofClaimContract({
      ...BASE,
      source: 'plan',
      claims: [planClaim({ claimScope: 'suite' })],
    });
    expect(result).toMatchObject({ kind: 'invalid', field: 'counterexampleRequirement' });
  });

  it('fails closed when aggregate suite coverage is unsupported', () => {
    const result = validateProofClaimContract({
      ...BASE,
      source: 'plan',
      claims: [
        planClaim({
          claimScope: 'suite',
          counterexampleRequirement: { kind: 'aggregate_check', checkId: 'security' },
        }),
      ],
    });
    expect(result).toMatchObject({ kind: 'invalid', failureKind: 'unsatisfiable' });
    if (result.kind === 'invalid') expect(result.detail).toContain('aggregate counterexample capability');
  });

  it('accepts aggregate coverage when the candidate report provider and format are registered', () => {
    const providerId = 'test-aggregate-provider';
    const format = 'test_aggregate_format';
    const result = validateProofClaimContract({
      ...BASE,
      source: 'plan',
      aggregateFormatsByProvider: new Map([[providerId, new Set([format])]]),
      verificationCandidates: [
        {
          ...BASE.verificationCandidates[1],
          assertionReport: {
            ...BASE.verificationCandidates[1].assertionReport!,
            providerId: providerId as never,
            format: format as never,
          },
        },
      ],
      claims: [
        planClaim({
          claimScope: 'suite',
          counterexampleRequirement: { kind: 'aggregate_check', checkId: 'security' },
        }),
      ],
    });
    expect(result).toEqual({ kind: 'ok' });
  });

  it('rejects a critical claim without a counterexample check', () => {
    const claim = planClaim({ counterexampleRequirement: undefined });
    const result = validateProofClaimContract({ ...BASE, source: 'plan', claims: [claim] });

    expect(result).toMatchObject({ kind: 'invalid', claimRef: CLAIM_A });
    if (result.kind !== 'invalid') return;
    expect(result.field).toBe('counterexampleRequirement');
    expect(result.detail).toContain('never become PROVEN');
  });

  it('rejects a critical claim when the counterexample check has no verification candidate', () => {
    const claim = planClaim({
      counterexampleRequirement: {
        checkId: 'build',
        kind: 'assertion',
        assertion: { providerId: 'junit', localId: 'some-id' },
      },
    });
    const result = validateProofClaimContract({
      ...BASE,
      verificationCandidates: [],
      source: 'plan',
      claims: [claim],
    });

    expect(result).toMatchObject({ kind: 'invalid', field: 'counterexampleRequirement.checkId' });
    if (result.kind !== 'invalid') return;
    expect(result.failureKind).toBe('unsatisfiable');
    expect(result.detail).toContain('not in active verification candidates');
  });

  it('reports the satisfiability violation using declare_contract public fields', () => {
    const claim = planClaim({
      claimId: undefined,
      counterexampleRequirement: {
        checkId: 'build',
        kind: 'assertion',
        assertion: { providerId: 'junit', localId: 'some-id' },
      },
    });
    const result = validateProofClaimContract({
      ...BASE,
      verificationCandidates: [],
      source: 'declare_contract',
      claims: [claim],
    });

    expect(result).toMatchObject({ kind: 'invalid', field: 'counterexampleRequirement.checkId' });
    if (result.kind !== 'invalid') return;
    expect(result.failureKind).toBe('unsatisfiable');
  });

  it('allows a non-critical claim to reuse an optional counterexample check', () => {
    const claim = planClaim({
      critical: false,
      counterexampleRequirement: {
        checkId: 'build',
        kind: 'assertion',
        assertion: { providerId: 'junit', localId: 'some-id' },
      },
    });

    expect(validateProofClaimContract({ ...BASE, source: 'plan', claims: [claim] })).toEqual({
      kind: 'ok',
    });
  });
});

describe('validateProofClaimContract — check references', () => {
  it('rejects an expected check that is not active', () => {
    const claim = planClaim({ positiveCheckId: 'typecheck' });
    const result = validateProofClaimContract({ ...BASE, source: 'plan', claims: [claim] });

    expect(result).toMatchObject({ kind: 'invalid', field: 'expectedCheckId' });
    if (result.kind !== 'invalid') return;
    // The author needs to know what they could have referenced instead.
    expect(result.detail).toContain('build, security');
  });

  it('rejects a counterexample check that is not active', () => {
    const claim = planClaim({
      counterexampleRequirement: {
        checkId: 'e2e',
        kind: 'assertion',
        assertion: { providerId: 'junit', localId: 'some-id' },
      },
    });
    expect(validateProofClaimContract({ ...BASE, source: 'plan', claims: [claim] })).toMatchObject({
      kind: 'invalid',
      field: 'counterexampleRequirement',
    });
  });
});

describe('validateProofClaimContract — registries', () => {
  it('rejects an unregistered structural surface', () => {
    const claim = planClaim({ structuralSurface: 'made-up-surface' });
    expect(validateProofClaimContract({ ...BASE, source: 'plan', claims: [claim] })).toMatchObject({
      kind: 'invalid',
      field: 'structuralSurface',
    });
  });

  it('rejects an unregistered mutation profile', () => {
    const claim = planClaim({ mutationProfile: 'typo-profile' });
    expect(validateProofClaimContract({ ...BASE, source: 'plan', claims: [claim] })).toMatchObject({
      kind: 'invalid',
      field: 'mutationProfile',
    });
  });
});

describe('validateProofClaimContract — identity and authority', () => {
  it('rejects a duplicate claimId for plan declarations', () => {
    const result = validateProofClaimContract({
      ...BASE,
      source: 'plan',
      claims: [planClaim(), planClaim({ statement: 'other' })],
    });
    expect(result).toMatchObject({ kind: 'invalid', field: 'claimId' });
  });

  it('rejects a plan claim without a governing section', () => {
    const claim = planClaim({ authoritySectionId: '   ' });
    expect(validateProofClaimContract({ ...BASE, source: 'plan', claims: [claim] })).toMatchObject({
      kind: 'invalid',
      field: 'authoritySectionId',
    });
  });

  it('does not require an authority section for declare_contract', () => {
    const claim = planClaim({ claimId: undefined, authoritySectionId: undefined });
    expect(
      validateProofClaimContract({ ...BASE, source: 'declare_contract', claims: [claim] }),
    ).toEqual({ kind: 'ok' });
  });
});

describe('validateProofClaimContract — public field language', () => {
  it('reports the plan field name for the positive check', () => {
    const claim = planClaim({ positiveCheckId: 'nope' });
    const result = validateProofClaimContract({ ...BASE, source: 'plan', claims: [claim] });
    if (result.kind !== 'invalid') throw new Error('expected invalid');
    expect(result.field).toBe('expectedCheckId');
  });

  it('reports the declare_contract field name for the same rule', () => {
    const claim = planClaim({ claimId: undefined, positiveCheckId: 'nope' });
    const result = validateProofClaimContract({
      ...BASE,
      source: 'declare_contract',
      claims: [claim],
    });
    if (result.kind !== 'invalid') throw new Error('expected invalid');
    // The caller never supplied `expectedCheckId`; naming it would be unfixable.
    expect(result.field).toBe('checkId');
  });

  it('identifies a declare_contract claim by statement, since its id is derived', () => {
    const claims = [
      planClaim({ claimId: undefined }),
      planClaim({ claimId: undefined, positiveCheckId: 'security' }),
    ];
    const result = validateProofClaimContract({ ...BASE, source: 'declare_contract', claims });
    if (result.kind !== 'invalid') throw new Error('expected invalid');
    expect(result.field).toBe('statement');
    expect(result.claimRef).toBe('updateTask rejects unknown ids');
    expect(result.detail).toContain('derived');
  });
});

describe('isRiskAssessmentCurrent', () => {
  it('accepts an assessment bound to the current revision', () => {
    expect(isRiskAssessmentCurrent({ implementationDigest: 'abc', riskTriggers: [] }, 'abc')).toBe(
      true,
    );
  });

  it('rejects an assessment bound to a superseded revision', () => {
    expect(isRiskAssessmentCurrent({ implementationDigest: 'old', riskTriggers: [] }, 'abc')).toBe(
      false,
    );
  });

  it('rejects a missing assessment or a missing revision', () => {
    expect(isRiskAssessmentCurrent(undefined, 'abc')).toBe(false);
    expect(
      isRiskAssessmentCurrent({ implementationDigest: 'abc', riskTriggers: [] }, undefined),
    ).toBe(false);
  });

  it('treats a pre-trigger assessment as superseded', () => {
    expect(isRiskAssessmentCurrent({ implementationDigest: 'abc' }, 'abc')).toBe(false);
  });
});

describe('buildHeuristicRiskWarning', () => {
  it('warns when target paths look HIGH-RISK and no critical claim is declared', () => {
    const warning = buildHeuristicRiskWarning({
      targetPaths: ['src/state/schema.ts'],
      assessedTaskClass: 'HIGH-RISK',
      criticalClaimCount: 0,
    });
    expect(warning).toMatchObject({
      computedMinimumTaskClass: 'HIGH-RISK',
      assessedFrom: 'plan_target_paths',
      assessedFileCount: 1,
    });
    // It must not read as a classification; the binding one comes later.
    expect(warning?.message).toContain('heuristic forecast');
  });

  it('stays silent when a critical claim is already declared', () => {
    expect(
      buildHeuristicRiskWarning({
        targetPaths: ['src/state/schema.ts'],
        assessedTaskClass: 'HIGH-RISK',
        criticalClaimCount: 1,
      }),
    ).toBeNull();
  });

  it('stays silent without target paths — their absence never triggers anything', () => {
    expect(
      buildHeuristicRiskWarning({
        targetPaths: undefined,
        assessedTaskClass: 'HIGH-RISK',
        criticalClaimCount: 0,
      }),
    ).toBeNull();
  });

  it('stays silent for a non HIGH-RISK forecast', () => {
    expect(
      buildHeuristicRiskWarning({
        targetPaths: ['README.md'],
        assessedTaskClass: 'TRIVIAL',
        criticalClaimCount: 0,
      }),
    ).toBeNull();
  });
});
