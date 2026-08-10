/**
 * @module audit/proofgraph/counterexample-binder.test
 * @description Binding declared counterexample refs to executed outcomes (#762).
 *
 * After legacy eradication: a counterexample without a counterexampleRequirement
 * always returns not_verified (defensive corruption handling). All positive
 * outcomes require assertion-level binding via a structured counterexampleRequirement.
 */
import { describe, it, expect } from 'vitest';
import { bindCounterexamples } from './counterexample-binder.js';
import { makeState, IMPL_EVIDENCE } from '../../fixtures.js';
import { ProofCounterexample, type CounterexampleRequirement } from '../../state/proofgraph.js';
import type { SessionState } from '../../state/schema.js';

const NOW = '2026-01-01T00:00:00.000Z';
const CLAIM = '00000000-0000-4000-8000-000000000001';
const ATT = '00000000-0000-4000-8000-0000000000cc';
const IMPL_DIGEST = IMPL_EVIDENCE.candidate.candidateDigest;
const SHA = 'a'.repeat(64);
const AUTHORITY_REF = {
  kind: 'canonical_authority' as const,
  authorityId: 'ticket',
  digest: 'authority',
};

const COUNTEREXAMPLE_REQ: CounterexampleRequirement = {
  checkId: 'security',
  assertion: { providerId: 'junit', localId: 'com.example.Test#method' },
};
const AGGREGATE_COUNTEREXAMPLE_REQ: CounterexampleRequirement = {
  kind: 'aggregate_check',
  checkId: 'security',
};

function validationResult(passed: boolean) {
  return {
    checkId: 'security',
    passed,
    detail: '',
    executedAt: NOW,
    kind: 'security' as const,
    command: 'npm run security',
    exitCode: passed ? 0 : 1,
    executionMs: 5,
    outputDigest: SHA,
    timedOut: false,
    outcome: (passed ? 'supported' : 'inconclusive') as 'supported' | 'inconclusive',
  };
}

function aggregateValidationResult(fullCheckScopeAttestation?: 'full_check') {
  return {
    ...validationResult(true),
    fullCheckScopeAttestation,
    assertionExtraction: {
      status: 'extracted' as const,
      attemptId: ATT,
      providerId: 'pytest' as const,
      format: 'junit_xml' as const,
      bindingCapability: 'aggregate' as const,
      reportDigests: [SHA],
      assertions: [],
      summary: {
        assertionCount: 0,
        passedCount: 0,
        failedCount: 0,
        erroredCount: 0,
        skippedCount: 0,
        suiteInfrastructureError: false,
      },
    },
  };
}

function claim(attemptId = ATT) {
  return {
    claimId: CLAIM,
    statement: 'the change is safe',
    signalClass: 'fact' as const,
    critical: true,
    provenance: AUTHORITY_REF,
    evidenceRefs: [],
    counterexampleRefs: [{ kind: 'validation_attempt' as const, attemptId }],
    counterexampleRequirement: COUNTEREXAMPLE_REQ,
  };
}

function stateWith(
  attempts: SessionState['validationAttempts'],
  phase: SessionState['phase'] = 'IMPL_REVIEW',
  overrides: Partial<ReturnType<typeof claim>> = {},
): SessionState {
  return makeState(phase, {
    implementation: IMPL_EVIDENCE,
    proofContract: {
      version: 'contract.v1',
      claims: [{ ...claim(), ...overrides }],
    },
    validationAttempts: attempts,
  });
}

describe('bindCounterexamples', () => {
  it('maps a failing counterexample check to not_verified (inconclusive)', () => {
    const state = stateWith([
      {
        attemptId: ATT,
        scope: 'implementation',
        implementationDigest: IMPL_DIGEST,
        result: validationResult(false),
      },
    ]);
    const [cx] = bindCounterexamples(state, NOW).counterexamples;
    expect(cx).toMatchObject({ claimId: CLAIM, outcome: 'not_verified', boundDigest: IMPL_DIGEST });
  });

  it('maps an inconclusive result to not_verified', () => {
    const state = stateWith([
      {
        attemptId: ATT,
        scope: 'implementation',
        implementationDigest: IMPL_DIGEST,
        result: { ...validationResult(false), outcome: 'inconclusive' as const },
      },
    ]);
    const [cx] = bindCounterexamples(state, NOW).counterexamples;
    expect(cx).toMatchObject({ claimId: CLAIM, outcome: 'not_verified', boundDigest: IMPL_DIGEST });
  });

  it('returns not_verified for outcome=blocked (defensive fallback when no assertion extraction)', () => {
    const state = stateWith([
      {
        attemptId: ATT,
        scope: 'implementation',
        implementationDigest: IMPL_DIGEST,
        result: { ...validationResult(false), outcome: 'blocked' as const, timedOut: true },
      },
    ]);
    const [cx] = bindCounterexamples(state, NOW).counterexamples;
    expect(cx!.outcome).toBe('not_verified');
  });

  it('returns not_verified for a passing counterexample without assertion extraction', () => {
    const state = stateWith([
      {
        attemptId: ATT,
        scope: 'implementation',
        implementationDigest: IMPL_DIGEST,
        result: validationResult(true),
      },
    ]);
    expect(bindCounterexamples(state, NOW).counterexamples[0]!.outcome).toBe('not_verified');
  });

  it('does not upgrade an old aggregate attempt when the current candidate is full scope', () => {
    const state = {
      ...stateWith(
        [
          {
            attemptId: ATT,
            scope: 'implementation' as const,
            implementationDigest: IMPL_DIGEST,
            result: aggregateValidationResult(),
          },
        ],
        'IMPL_REVIEW',
        { counterexampleRequirement: AGGREGATE_COUNTEREXAMPLE_REQ },
      ),
      verificationCandidates: [
        {
          assertionCapability: 'structured' as const,
          kind: 'security' as const,
          command: 'pytest --junitxml=reports.xml',
          source: 'provider:pytest',
          confidence: 'high' as const,
          reason: 'replacement candidate',
          fullCheckScopeAttestation: 'full_check' as const,
          assertionReport: {
            collection: 'snapshot_diff' as const,
            transport: 'file' as const,
            format: 'junit_xml' as const,
            providerId: 'pytest' as const,
            standardPatterns: ['reports.xml'],
          },
        },
      ],
    };

    expect(bindCounterexamples(state, NOW).counterexamples[0]!.outcome).toBe('not_verified');
  });

  it('supports an aggregate counterexample attested by its executed attempt', () => {
    const state = stateWith(
      [
        {
          attemptId: ATT,
          scope: 'implementation',
          implementationDigest: IMPL_DIGEST,
          result: aggregateValidationResult('full_check'),
        },
      ],
      'IMPL_REVIEW',
      { counterexampleRequirement: AGGREGATE_COUNTEREXAMPLE_REQ },
    );

    expect(bindCounterexamples(state, NOW).counterexamples[0]!.outcome).toBe('supported');
  });

  it('records a distinct diagnostic for each aggregate binding precondition', () => {
    const cases = [
      {
        result: { ...aggregateValidationResult('full_check'), checkId: 'other' },
        diagnostic: 'aggregate_check_mismatch',
      },
      { result: aggregateValidationResult(), diagnostic: 'aggregate_scope_unattested' },
      {
        result: { ...aggregateValidationResult('full_check'), assertionExtraction: undefined },
        diagnostic: 'aggregate_extraction_missing',
      },
      {
        result: {
          ...aggregateValidationResult('full_check'),
          assertionExtraction: {
            ...aggregateValidationResult('full_check').assertionExtraction!,
            bindingCapability: 'assertion' as const,
          },
        },
        diagnostic: 'aggregate_capability_missing',
      },
    ] as const;

    for (const { result, diagnostic } of cases) {
      const binding = bindCounterexamples(
        stateWith(
          [{ attemptId: ATT, scope: 'implementation', implementationDigest: IMPL_DIGEST, result }],
          'IMPL_REVIEW',
          { counterexampleRequirement: AGGREGATE_COUNTEREXAMPLE_REQ },
        ),
        NOW,
      );
      expect(binding.counterexamples[0]!.outcome).toBe('not_verified');
      expect(binding.diagnostics.get(CLAIM)).toBe(diagnostic);
    }
  });

  it('rejects aggregate evidence from a different candidate of the same check kind', () => {
    const binding = bindCounterexamples(
      stateWith(
        [
          {
            attemptId: ATT,
            scope: 'implementation',
            implementationDigest: IMPL_DIGEST,
            result: {
              ...aggregateValidationResult('full_check'),
              candidateId: 'security-secondary',
            },
          },
        ],
        'IMPL_REVIEW',
        {
          counterexampleRequirement: {
            ...AGGREGATE_COUNTEREXAMPLE_REQ,
            candidateId: 'security-primary',
          },
        },
      ),
      NOW,
    );

    expect(binding.counterexamples[0]?.outcome).toBe('not_verified');
    expect(binding.diagnostics.get(CLAIM)).toBe('aggregate_candidate_mismatch');
  });

  it('returns not_verified when counterexampleRequirement is absent (defensive corruption handling)', () => {
    const state = stateWith(
      [
        {
          attemptId: ATT,
          scope: 'implementation',
          implementationDigest: IMPL_DIGEST,
          result: { ...validationResult(true), outcome: 'supported' as const },
        },
      ],
      'IMPL_REVIEW',
      { counterexampleRequirement: undefined },
    );
    expect(bindCounterexamples(state, NOW).counterexamples[0]!.outcome).toBe('not_verified');
  });

  it('marks a missing counterexample attempt as not_verified', () => {
    const cx = bindCounterexamples(stateWith([]), NOW).counterexamples[0]!;
    expect(cx.outcome).toBe('not_verified');
    expect(cx.boundDigest).toBe(IMPL_EVIDENCE.candidate.contentDigest);
  });

  it('returns nothing when there is no implementation', () => {
    const state = makeState('IMPL_REVIEW', {
      proofContract: { version: 'contract.v1', claims: [claim()] },
    });
    expect(bindCounterexamples(state, NOW).counterexamples).toEqual([]);
  });

  it('ignores non-validation_attempt counterexample references', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      proofContract: {
        version: 'contract.v1',
        claims: [{ ...claim(), counterexampleRefs: [{ kind: 'content', digest: 'x' }] }],
      },
    });
    expect(bindCounterexamples(state, NOW).counterexamples).toEqual([]);
  });

  it('every produced ProofCounterexample passes schema validation', () => {
    const state = stateWith([
      {
        attemptId: ATT,
        scope: 'implementation',
        implementationDigest: IMPL_DIGEST,
        result: validationResult(true),
      },
    ]);
    const counterexamples = bindCounterexamples(state, NOW).counterexamples;
    expect(counterexamples.length).toBeGreaterThan(0);
    for (const counterexample of counterexamples) {
      expect(() => ProofCounterexample.parse(counterexample)).not.toThrow();
    }
  });

  it('unresolved attempt has non-empty checkId', () => {
    const state = stateWith([]);
    const [cx] = bindCounterexamples(state, NOW).counterexamples;
    expect(cx!.checkId).toBeTruthy();
    expect(cx!.attemptId).toBeTruthy();
  });
});
