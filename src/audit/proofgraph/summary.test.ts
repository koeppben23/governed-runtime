/**
 * @module audit/proofgraph/summary.test
 * @description End-to-end pure vertical: contract + validation ledger -> summary (#762).
 */
import { describe, it, expect } from 'vitest';
import { summarizeProofGraph, summarizePersistedProofGraph } from './summary.js';
import { makeState } from '../../fixtures.js';
import type { SessionState } from '../../state/schema.js';
import type { ProofClaim } from '../../state/proofgraph.js';
import { TEST_EXECUTION_OBSERVATION } from '../../state/evidence-test-constants.js';

const NOW = '2026-01-01T00:00:00.000Z';
const CLAIM = '00000000-0000-4000-8000-000000000001';
const ATT = '00000000-0000-4000-8000-0000000000aa';
const IMPL_DIGEST = 'impl-current';
const SHA = 'a'.repeat(64);
const AUTHORITY_REF = {
  kind: 'canonical_authority' as const,
  authorityId: 'ticket',
  digest: 'authority',
};
const IMPL = {
  implementationId: '00000000-0000-4000-8000-0000000000aa',
  changedFiles: ['a.ts'],
  domainFiles: [],
  digest: IMPL_DIGEST,
  executedAt: NOW,
};

function attemptResult(passed: boolean) {
  const outcome: 'supported' | 'inconclusive' = passed ? 'supported' : 'inconclusive';
  return {
    checkId: 'test',
    passed,
    detail: '',
    executedAt: NOW,
    kind: 'test' as const,
    command: 'npm test',
    exitCode: passed ? 0 : 1,
    executionMs: 5,
    outputDigest: SHA,
    timedOut: false,
    outcome,
  };
}

function claim() {
  return {
    claimId: CLAIM,
    statement: 'covered by a passing implementation test',
    signalClass: 'fact' as const,
    critical: true,
    provenance: AUTHORITY_REF,
    evidenceRefs: [{ kind: 'validation_attempt' as const, attemptId: ATT }],
    counterexampleRefs: [],
  };
}

function stateWith(attempts: SessionState['validationAttempts']): SessionState {
  return makeState('IMPL_VALIDATION', {
    implementation: IMPL,
    proofContract: { version: 'contract.v2', claims: [claim()] },
    validationAttempts: attempts,
  });
}

describe('summarizeProofGraph', () => {
  it('summarizes an empty ProofGraph for a session without a contract', () => {
    const summary = summarizeProofGraph(makeState('READY'), NOW);
    expect(summary.projection.claims).toEqual([]);
    expect(summary.criticalClaimCount).toBe(0);
    expect(summary.criticalUnprovenCount).toBe(0);
  });

  it('reports a critical claim as PROVEN when its bound implementation test passed', () => {
    const summary = summarizeProofGraph(
      stateWith([
        {
          attemptId: ATT,
          scope: 'implementation',
          implementationId: '00000000-0000-4000-8000-0000000000aa',
          implementationDigest: IMPL_DIGEST,
          executionObservation: TEST_EXECUTION_OBSERVATION,
          result: attemptResult(true),
        },
      ]),
      NOW,
    );
    expect(summary.counts.PROVEN).toBe(1);
    expect(summary.criticalClaimCount).toBe(1);
    expect(summary.criticalUnprovenCount).toBe(0);
  });

  it('surfaces a critical gap as NOT_VERIFIED when the referenced attempt is missing', () => {
    const summary = summarizeProofGraph(stateWith([]), NOW);
    expect(summary.counts.NOT_VERIFIED).toBe(1);
    expect(summary.criticalUnprovenCount).toBe(1);
  });

  it('reports STALE when the passing evidence is bound to a superseded revision', () => {
    const summary = summarizeProofGraph(
      stateWith([
        {
          attemptId: ATT,
          scope: 'implementation',
          implementationId: '00000000-0000-4000-8000-0000000000aa',
          implementationDigest: 'old-digest',
          executionObservation: TEST_EXECUTION_OBSERVATION,
          result: attemptResult(true),
        },
      ]),
      NOW,
    );
    expect(summary.counts.STALE).toBe(1);
    expect(summary.criticalUnprovenCount).toBe(1);
  });
});

// AC#6 (#762): the projection must expose counterexample status, mutation
// status where present, and unresolved assumptions - not merely imply them.
describe('summarizeProofGraph reviewer projection', () => {
  const CX_ATT = '00000000-0000-4000-8000-0000000000cc';

  function passingAttempt(attemptId: string, checkId: string, digest: string, passed: boolean) {
    return {
      attemptId,
      scope: 'implementation' as const,
      implementationId: '00000000-0000-4000-8000-0000000000aa',
      implementationDigest: digest,
      executionObservation: TEST_EXECUTION_OBSERVATION,
      result: { ...attemptResult(passed), checkId },
    };
  }

  function stateWithCounterexample(cxDigest: string): SessionState {
    return makeState('IMPL_VALIDATION', {
      implementation: IMPL,
      proofContract: {
        version: 'contract.v2',
        claims: [
          {
            ...claim(),
            counterexampleRefs: [{ kind: 'validation_attempt' as const, attemptId: CX_ATT }],
            counterexampleRequirement: {
              kind: 'assertion',
              checkId: 'security',
              assertion: { providerId: 'junit', localId: 'com.example.Test#method' },
            },
          },
        ],
      },
      validationAttempts: [
        passingAttempt(ATT, 'test', IMPL_DIGEST, true),
        passingAttempt(CX_ATT, 'security', cxDigest, true),
      ],
    });
  }

  it('surfaces executed counterexample outcomes explicitly', () => {
    const summary = summarizeProofGraph(stateWithCounterexample(IMPL_DIGEST), NOW);
    expect(summary.counterexamples).toHaveLength(1);
    expect(summary.counterexamples[0]).toMatchObject({
      outcome: 'not_verified',
      boundDigest: IMPL_DIGEST,
      stale: false,
    });
  });

  it('marks a counterexample bound to a superseded revision as stale', () => {
    const summary = summarizeProofGraph(stateWithCounterexample('old-digest'), NOW);
    expect(summary.counterexamples[0]).toMatchObject({ stale: true });
  });

  it('surfaces recorded mutation verdicts including survivors', () => {
    const summary = summarizeProofGraph(stateWith([]), NOW, {
      mutationSummaries: [
        {
          profileId: 'proofgraph-evaluator',
          covered: true,
          killedCount: 4,
          survivorCount: 1,
          excludedCount: 0,
          survivors: [
            {
              mutantId: '7',
              location: 'src/audit/proofgraph/evaluate.ts',
              mutatorName: 'ConditionalExpression',
              status: 'Survived',
            },
          ],
          projectionDigest: 'a'.repeat(64),
        },
      ],
    });
    expect(summary.mutation).toHaveLength(1);
    expect(summary.mutation[0]).toMatchObject({
      profileId: 'proofgraph-evaluator',
      survivorCount: 1,
      killedCount: 4,
    });
    expect(summary.mutation[0]!.survivors[0]!.mutantId).toBe('7');
  });

  it('reports no mutation entries when nothing was recorded', () => {
    expect(summarizeProofGraph(stateWith([]), NOW).mutation).toEqual([]);
  });

  it('lists an unsourced claim as an unresolved assumption with a reason', () => {
    const state = makeState('IMPL_VALIDATION', {
      implementation: IMPL,
      proofContract: {
        version: 'contract.v2',
        claims: [{ ...claim(), provenance: null, evidenceRefs: [] }],
      },
    });
    const summary = summarizeProofGraph(state, NOW);
    expect(summary.unresolvedAssumptions).toHaveLength(1);
    expect(summary.unresolvedAssumptions[0]).toMatchObject({
      claimId: CLAIM,
      verificationState: 'NOT_VERIFIED',
    });
    expect(summary.unresolvedAssumptions[0]!.reason).toContain('no approved governing authority');
  });

  it('does not list a PROVEN claim as unresolved', () => {
    const summary = summarizeProofGraph(
      stateWith([
        {
          attemptId: ATT,
          scope: 'implementation',
          implementationId: '00000000-0000-4000-8000-0000000000aa',
          implementationDigest: IMPL_DIGEST,
          executionObservation: TEST_EXECUTION_OBSERVATION,
          result: attemptResult(true),
        },
      ]),
      NOW,
    );
    expect(summary.counts.PROVEN).toBe(1);
    expect(summary.unresolvedAssumptions).toEqual([]);
  });

  it('explains a STALE claim as superseded rather than merely unproven', () => {
    const summary = summarizeProofGraph(
      stateWith([
        {
          attemptId: ATT,
          scope: 'implementation',
          implementationId: '00000000-0000-4000-8000-0000000000aa',
          implementationDigest: 'old-digest',
          executionObservation: TEST_EXECUTION_OBSERVATION,
          result: attemptResult(true),
        },
      ]),
      NOW,
    );
    expect(summary.unresolvedAssumptions[0]!.reason).toContain('superseded revision');
  });

  it('does not prove a claim when one attempt carries both evidence roles', () => {
    const dualRoleClaim = {
      ...claim(),
      requiredEvidence: {
        positive: ['executed_test' as const],
        adversarial: ['counterexample' as const],
      },
      counterexampleRefs: [{ kind: 'validation_attempt' as const, attemptId: ATT }],
      counterexampleRequirement: {
        kind: 'assertion' as const,
        checkId: 'test',
        assertion: { providerId: 'junit' as const, localId: 'com.example.Test#case' },
      },
    };
    const state = makeState('IMPL_VALIDATION', {
      implementation: IMPL,
      proofContract: { version: 'contract.v2', claims: [dualRoleClaim] },
      validationAttempts: [
        {
          attemptId: ATT,
          scope: 'implementation',
          implementationId: '00000000-0000-4000-8000-0000000000aa',
          implementationDigest: IMPL_DIGEST,
          executionObservation: TEST_EXECUTION_OBSERVATION,
          result: {
            ...attemptResult(true),
            assertionExtraction: {
              status: 'extracted' as const,
              attemptId: ATT,
              providerId: 'junit' as const,
              format: 'junit_xml' as const,
              bindingCapability: 'assertion' as const,
              reportDigests: [SHA],
              assertions: [
                {
                  assertion: {
                    providerId: 'junit',
                    localId: 'com.example.Test#case',
                  },
                  providerId: 'junit',
                  status: 'passed' as const,
                  testName: 'case',
                  suiteName: 'com.example.Test',
                },
              ],
              summary: {
                assertionCount: 1,
                passedCount: 1,
                failedCount: 0,
                erroredCount: 0,
                skippedCount: 0,
                suiteInfrastructureError: false,
              },
            },
          },
        },
      ],
    });

    const summary = summarizeProofGraph(state, NOW);

    expect(summary.projection.claims[0]!.verificationState).toBe('NOT_VERIFIED');
    expect(summary.claimDiagnostics.get(CLAIM)).toBe('evidence_role_collision');
  });

  it('projects the persisted role-collision coverage cause when the shared ref was removed', () => {
    // Materialization removes the shared counterexample ref and records the
    // cause in `proofContractCoverage`; the diagnostic projection must carry
    // that already-determined cause without re-detecting the collision.
    const adversarialClaim = {
      ...claim(),
      requiredEvidence: {
        positive: ['executed_test' as const],
        adversarial: ['counterexample' as const],
      },
    };
    const summary = summarizeProofGraph(
      makeState('IMPL_VALIDATION', {
        implementation: IMPL,
        proofContract: { version: 'contract.v2', claims: [adversarialClaim] },
        proofContractCoverage: [{ claimId: CLAIM, cause: 'evidence_role_collision' }],
        validationAttempts: [
          {
            attemptId: ATT,
            scope: 'implementation',
            implementationId: '00000000-0000-4000-8000-0000000000aa',
            implementationDigest: IMPL_DIGEST,
            executionObservation: TEST_EXECUTION_OBSERVATION,
            result: attemptResult(true),
          },
        ],
      }),
      NOW,
    );

    expect(summary.projection.claims[0]!.verificationState).toBe('NOT_VERIFIED');
    expect(summary.claimDiagnostics.get(CLAIM)).toBe('evidence_role_collision');
  });
});

describe('summarizePersistedProofGraph contract coverage', () => {
  const CONTRACT_CLAIM_A = '00000000-0000-4000-8000-0000000000a1';
  const CONTRACT_CLAIM_B = '00000000-0000-4000-8000-0000000000b1';
  const EXTRA_CLAIM = '00000000-0000-4000-8000-0000000000e1';

  function declaredClaim(claimId: string) {
    return {
      claimId,
      statement: 'declared contract claim',
      signalClass: 'fact' as const,
      critical: false,
      provenance: AUTHORITY_REF,
      evidenceRefs: [],
      counterexampleRefs: [],
    };
  }

  function projectedClaim(claimId: string, overrides: Partial<ProofClaim> = {}): ProofClaim {
    return {
      ...declaredClaim(claimId),
      verificationState: 'PROVEN',
      ...overrides,
    };
  }

  function persistedState(
    claims: ProofClaim[],
    contractClaimIds: readonly string[] = [CONTRACT_CLAIM_A],
  ): SessionState {
    return makeState('EVIDENCE_REVIEW', {
      proofContract: {
        version: 'contract.v2',
        claims: contractClaimIds.map(declaredClaim),
      },
      proofGraph: { version: 'proofgraph.v2', claims, evaluatedAt: NOW },
    });
  }

  it('reports PROVEN coverage when every declared contract claim is present and proven', () => {
    const summary = summarizePersistedProofGraph(
      persistedState([projectedClaim(CONTRACT_CLAIM_A)]),
    );
    expect(summary.coverage).toBe('PROVEN');
  });

  it('does not report PROVEN when a declared contract claim is missing from the projection', () => {
    const summary = summarizePersistedProofGraph(persistedState([]));
    expect(summary.coverage).toBe('NOT_VERIFIED');
    expect(summary.contractClaimCount).toBe(1);
  });

  it('does not report PROVEN when a declared contract claim appears twice', () => {
    const summary = summarizePersistedProofGraph(
      persistedState([projectedClaim(CONTRACT_CLAIM_A), projectedClaim(CONTRACT_CLAIM_A)]),
    );
    expect(summary.coverage).toBe('NOT_VERIFIED');
  });

  it('does not report PROVEN when an undeclared governing authority claim is projected', () => {
    const summary = summarizePersistedProofGraph(
      persistedState([projectedClaim(CONTRACT_CLAIM_A), projectedClaim(EXTRA_CLAIM)]),
    );
    expect(summary.coverage).toBe('NOT_VERIFIED');
  });

  it('does not report PROVEN when an undeclared approved_ticket claim is projected', () => {
    const summary = summarizePersistedProofGraph(
      persistedState([
        projectedClaim(CONTRACT_CLAIM_A),
        projectedClaim(EXTRA_CLAIM, {
          provenance: { kind: 'approved_ticket', ticketDigest: 'ticket-digest' },
        }),
      ]),
    );
    expect(summary.coverage).toBe('NOT_VERIFIED');
  });

  it('does not report PROVEN when an undeclared plan_adr_section claim is projected', () => {
    const summary = summarizePersistedProofGraph(
      persistedState([
        projectedClaim(CONTRACT_CLAIM_A),
        projectedClaim(EXTRA_CLAIM, {
          provenance: {
            kind: 'plan_adr_section',
            artifactKind: 'plan',
            artifactDigest: 'artifact-digest',
            sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Section' }],
            excerptDigest: 'excerpt-digest',
          },
        }),
      ]),
    );
    expect(summary.coverage).toBe('NOT_VERIFIED');
  });

  it('keeps PROVEN when an advisory hypothesis claim is additionally projected', () => {
    const summary = summarizePersistedProofGraph(
      persistedState([
        projectedClaim(CONTRACT_CLAIM_A),
        projectedClaim(EXTRA_CLAIM, { signalClass: 'hypothesis', provenance: null }),
      ]),
    );
    expect(summary.coverage).toBe('PROVEN');
    expect(summary.hypothesisCount).toBe(1);
  });

  it('does not report PROVEN when a declared contract claim is not proven', () => {
    const summary = summarizePersistedProofGraph(
      persistedState([projectedClaim(CONTRACT_CLAIM_A, { verificationState: 'UNPROVEN' })]),
    );
    expect(summary.coverage).toBe('NOT_VERIFIED');
  });

  it('does not report PROVEN when a second declared contract claim is missing', () => {
    const summary = summarizePersistedProofGraph(
      persistedState([projectedClaim(CONTRACT_CLAIM_A)], [CONTRACT_CLAIM_A, CONTRACT_CLAIM_B]),
    );
    expect(summary.coverage).toBe('NOT_VERIFIED');
    expect(summary.contractClaimCount).toBe(2);
  });

  it('reports NOT_DECLARED without a contract regardless of projected claims', () => {
    const state = makeState('EVIDENCE_REVIEW', {
      proofGraph: {
        version: 'proofgraph.v2',
        claims: [projectedClaim(CONTRACT_CLAIM_A)],
        evaluatedAt: NOW,
      },
    });
    expect(summarizePersistedProofGraph(state).coverage).toBe('NOT_DECLARED');
  });
});
