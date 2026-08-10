/**
 * @module audit/proofgraph/summary.test
 * @description End-to-end pure vertical: contract + validation ledger -> summary (#762).
 */
import { describe, it, expect } from 'vitest';
import { summarizeProofGraph } from './summary.js';
import { makeState, IMPL_EVIDENCE } from '../../fixtures.js';
import type { SessionState } from '../../state/schema.js';

const NOW = '2026-01-01T00:00:00.000Z';
const CLAIM = '00000000-0000-4000-8000-000000000001';
const ATT = '00000000-0000-4000-8000-0000000000aa';
const IMPL_DIGEST = IMPL_EVIDENCE.candidate.contentDigest;
const SHA = 'a'.repeat(64);
const AUTHORITY_REF = {
  kind: 'canonical_authority' as const,
  authorityId: 'ticket',
  digest: 'authority',
};

function attemptResult(passed: boolean) {
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
    outcome: (passed ? 'supported' : 'inconclusive') as 'supported' | 'inconclusive',
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
    implementation: IMPL_EVIDENCE,
    proofContract: { version: 'contract.v1', claims: [claim()] },
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
          implementationDigest: IMPL_DIGEST,
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
          implementationDigest: 'old-digest',
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
      implementationDigest: digest,
      result: { ...attemptResult(passed), checkId },
    };
  }

  function stateWithCounterexample(cxDigest: string): SessionState {
    return makeState('IMPL_VALIDATION', {
      implementation: IMPL_EVIDENCE,
      proofContract: {
        version: 'contract.v1',
        claims: [
          {
            ...claim(),
            counterexampleRefs: [{ kind: 'validation_attempt' as const, attemptId: CX_ATT }],
            counterexampleRequirement: {
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
      implementation: IMPL_EVIDENCE,
      proofContract: {
        version: 'contract.v1',
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
          implementationDigest: IMPL_DIGEST,
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
          implementationDigest: 'old-digest',
          result: attemptResult(true),
        },
      ]),
      NOW,
    );
    expect(summary.unresolvedAssumptions[0]!.reason).toContain('superseded revision');
  });
});
