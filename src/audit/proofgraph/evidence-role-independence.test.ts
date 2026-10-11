/**
 * @module audit/proofgraph/evidence-role-independence.test
 * @description Evidence-role independence: one execution must never satisfy both
 * the positive and the adversarial obligation of the same claim.
 */
import { describe, it, expect } from 'vitest';
import {
  assessEvidenceRoleIndependence,
  declaredEvidenceRolesCollide,
} from './evidence-role-independence.js';
import { ProofProviderResult, ProofCounterexample } from '../../state/proofgraph.js';
import type {
  CounterexampleRequirement,
  ProofProviderResult as ProofProviderResultType,
} from '../../state/proofgraph.js';

const NOW = '2026-01-01T00:00:00.000Z';
const SHA = 'a'.repeat(64);
const CLAIM_ID = '00000000-0000-4000-8000-000000000001';
const POSITIVE_ATTEMPT = '00000000-0000-4000-8000-0000000000aa';
const COUNTEREXAMPLE_ATTEMPT = '00000000-0000-4000-8000-0000000000cc';

const REQUIREMENT: CounterexampleRequirement = {
  kind: 'assertion',
  checkId: 'security',
  assertion: { providerId: 'junit', localId: 'com.example.Test#case' },
};

function passResult(input: {
  readonly providerKind?: 'executed_test' | 'structural_assertion';
  readonly executionRecordId?: string | undefined;
  readonly status?: 'pass' | 'fail' | 'error';
}): ProofProviderResultType {
  const providerKind = input.providerKind ?? 'executed_test';
  return ProofProviderResult.parse({
    claimId: CLAIM_ID,
    providerKind,
    providerId: providerKind === 'executed_test' ? 'executed-test' : 'registration-consistency',
    providerVersion: '1.0.0',
    input: providerKind === 'executed_test' ? { command: 'npm test' } : { assertion: 'surfaces' },
    source: { location: 'validation-check:test', stableId: 'test' },
    ...(input.executionRecordId !== undefined
      ? { executionRecordId: input.executionRecordId }
      : {}),
    binding:
      providerKind === 'executed_test'
        ? { kind: 'implementation', digest: 'impl' }
        : { kind: 'surface_set', surfaceId: 'sfc', digest: 'd', locations: ['l'] },
    status: input.status ?? 'pass',
    resultDigest: SHA,
    executedAt: NOW,
    attestation: 'flowguard_executed',
  });
}

function counterexample(attemptId: string = COUNTEREXAMPLE_ATTEMPT): ProofCounterexample {
  return ProofCounterexample.parse({
    claimId: CLAIM_ID,
    attemptId,
    checkId: 'security',
    scenario: 'falsify',
    outcome: 'supported',
    boundDigest: 'impl',
    executedAt: NOW,
  });
}

function assess(input: {
  readonly adversarialCounterexampleRequired: boolean;
  readonly counterexampleRequirement?: CounterexampleRequirement | undefined;
  readonly providerResults: readonly ProofProviderResultType[];
  readonly attemptId?: string;
}) {
  return assessEvidenceRoleIndependence({
    ...(input.counterexampleRequirement !== undefined
      ? { counterexampleRequirement: input.counterexampleRequirement }
      : {}),
    adversarialCounterexampleRequired: input.adversarialCounterexampleRequired,
    providerResults: input.providerResults,
    counterexamples: [counterexample(input.attemptId ?? COUNTEREXAMPLE_ATTEMPT)],
  });
}

describe('declaredEvidenceRolesCollide', () => {
  it('flags a claim whose positive and counterexample checks are identical', () => {
    expect(
      declaredEvidenceRolesCollide({
        positiveCheckId: 'security',
        counterexampleRequirement: REQUIREMENT,
      }),
    ).toBe(true);
  });

  it('accepts distinct positive and counterexample checks', () => {
    expect(
      declaredEvidenceRolesCollide({
        positiveCheckId: 'build',
        counterexampleRequirement: REQUIREMENT,
      }),
    ).toBe(false);
  });

  it('accepts a claim without a counterexample requirement', () => {
    expect(declaredEvidenceRolesCollide({ positiveCheckId: 'build' })).toBe(false);
  });
});

describe('assessEvidenceRoleIndependence', () => {
  it('is independent when no adversarial role is engaged', () => {
    expect(
      assess({
        adversarialCounterexampleRequired: false,
        providerResults: [passResult({ executionRecordId: undefined })],
      }),
    ).toEqual({ kind: 'independent' });
  });

  it('is independent when the positive pass and counterexample are distinct executions', () => {
    expect(
      assess({
        adversarialCounterexampleRequired: true,
        counterexampleRequirement: REQUIREMENT,
        providerResults: [passResult({ executionRecordId: POSITIVE_ATTEMPT })],
      }),
    ).toEqual({ kind: 'independent' });
  });

  it('is independent when the engaged adversarial role comes from required evidence alone', () => {
    expect(
      assess({
        adversarialCounterexampleRequired: true,
        providerResults: [passResult({ executionRecordId: POSITIVE_ATTEMPT })],
      }),
    ).toEqual({ kind: 'independent' });
  });

  it('reports role_collision when one attempt carries both evidence roles', () => {
    const result = assess({
      adversarialCounterexampleRequired: true,
      counterexampleRequirement: REQUIREMENT,
      providerResults: [passResult({ executionRecordId: COUNTEREXAMPLE_ATTEMPT })],
    });
    expect(result.kind).toBe('role_collision');
  });

  it('reports not_verifiable when the positive executed_test pass has no execution identity', () => {
    const result = assess({
      adversarialCounterexampleRequired: true,
      counterexampleRequirement: REQUIREMENT,
      providerResults: [passResult({ executionRecordId: undefined })],
    });
    expect(result.kind).toBe('not_verifiable');
  });

  it('does not require execution identity from a structural provider', () => {
    expect(
      assess({
        adversarialCounterexampleRequired: true,
        counterexampleRequirement: REQUIREMENT,
        providerResults: [passResult({ providerKind: 'structural_assertion' })],
      }),
    ).toEqual({ kind: 'independent' });
  });

  it('does not reject a missing executed_test identity when an identified pass exists', () => {
    const result = assess({
      adversarialCounterexampleRequired: true,
      counterexampleRequirement: REQUIREMENT,
      providerResults: [
        passResult({ executionRecordId: undefined, providerKind: 'structural_assertion' }),
        passResult({ executionRecordId: POSITIVE_ATTEMPT }),
      ],
    });
    expect(result.kind).toBe('independent');
  });

  it('ignores non-passing results: a failure is not positive proof evidence', () => {
    const result = assess({
      adversarialCounterexampleRequired: true,
      counterexampleRequirement: REQUIREMENT,
      providerResults: [passResult({ status: 'fail', executionRecordId: COUNTEREXAMPLE_ATTEMPT })],
    });
    expect(result.kind).toBe('independent');
  });

  it('prioritizes a role collision over a missing execution identity', () => {
    const result = assess({
      adversarialCounterexampleRequired: true,
      counterexampleRequirement: REQUIREMENT,
      providerResults: [
        passResult({ executionRecordId: undefined }),
        passResult({ executionRecordId: COUNTEREXAMPLE_ATTEMPT }),
      ],
    });
    expect(result.kind).toBe('role_collision');
  });
});
