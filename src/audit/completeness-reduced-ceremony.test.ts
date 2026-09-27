/**
 * @module audit/completeness-reduced-ceremony.test
 * @description Truthfulness of the evidence-backed implementation-review waiver.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, expect, it } from 'vitest';

import {
  IMPL_EVIDENCE,
  makeState,
  POLICY_SNAPSHOT,
  VALIDATION_PASSED,
  VERIFICATION_CANDIDATES,
} from '../fixtures.js';
import { TEST_EXECUTION_OBSERVATION } from '../state/evidence-test-constants.js';
import { evaluateCompleteness } from './completeness.js';

const DOC_IMPL = {
  ...IMPL_EVIDENCE,
  changedFiles: ['docs/usage-notes.md'],
  domainFiles: [],
};

function attempt(checkId: string) {
  const base = VALIDATION_PASSED[checkId === 'test' ? 0 : 1]!;
  return {
    attemptId:
      checkId === 'test'
        ? '00000000-0000-4000-8000-0000000000e1'
        : '00000000-0000-4000-8000-0000000000e2',
    scope: 'implementation' as const,
    implementationId: DOC_IMPL.implementationId,
    implementationDigest: DOC_IMPL.digest,
    executionObservation: TEST_EXECUTION_OBSERVATION,
    result: { ...base, checkId, passed: true } as (typeof VALIDATION_PASSED)[number],
  };
}

function reducedState() {
  const policySnapshot = {
    ...POLICY_SNAPSHOT,
    allowReducedCeremony: true,
    requireHumanGates: true,
    effectiveGateBehavior: 'human_gated' as const,
  };
  return makeState('EVIDENCE_REVIEW', {
    claimedTaskClass: 'TRIVIAL',
    verificationCandidates: VERIFICATION_CANDIDATES,
    implementation: DOC_IMPL,
    implementationRiskAssessment: {
      computedMinimumTaskClass: 'TRIVIAL',
      effectiveTaskClass: 'TRIVIAL',
      declaredTaskClass: null,
      declarationKind: 'absent' as const,
      ticketDigest: null,
      touchedSurfaces: [],
      assessedFrom: 'implementation_changed_files',
      assessedFileCount: 1,
      implementationDigest: DOC_IMPL.digest,
    },
    activeChecks: ['test', 'lint'],
    implValidation: VALIDATION_PASSED,
    validationAttempts: [attempt('test'), attempt('lint')],
    policySnapshot,
    reducedCeremony: {
      profile: 'reduced',
      reason: 'POST_IMPL_VERIFIED_TRIVIAL',
      effectiveTaskClass: 'TRIVIAL',
      declaredTaskClass: null,
      declarationKind: 'absent' as const,
      ticketDigest: null,
      computedMinimumTaskClass: 'TRIVIAL',
      touchedSurfaces: [],
      implementationId: DOC_IMPL.implementationId,
      implementationDigest: DOC_IMPL.digest,
      policyDigest: policySnapshot.hash,
      verificationBasis: {
        checkIds: ['test', 'lint'],
        attempts: [
          {
            checkId: 'test',
            attemptId: '00000000-0000-4000-8000-0000000000e1',
            executedAt: VALIDATION_PASSED[0]!.executedAt,
          },
          {
            checkId: 'lint',
            attemptId: '00000000-0000-4000-8000-0000000000e2',
            executedAt: VALIDATION_PASSED[1]!.executedAt,
          },
        ],
      },
      decidedAt: '2026-01-02T00:00:00.000Z',
    },
  });
}

function slot(report: ReturnType<typeof evaluateCompleteness>, name: string) {
  return report.slots.find((entry) => entry.slot === name);
}

describe('reduced-ceremony completeness waiver', () => {
  it('HAPPY: reports the review slot as waived, never as complete or missing', () => {
    const report = evaluateCompleteness(reducedState());

    expect(slot(report, 'implReview')?.status).toBe('waived');
    expect(slot(report, 'implReview')?.detail).toContain('reduced ceremony');
    expect(report.summary.waived).toBe(1);
  });

  it('BAD: a detached waiver (digest mismatch) is missing, not waived', () => {
    const state = reducedState();
    const report = evaluateCompleteness({
      ...state,
      implementation: { ...DOC_IMPL, digest: 'different-digest' },
    });

    expect(slot(report, 'implReview')?.status).toBe('missing');
  });

  it('BAD: the implementation-validation slot is never waivable', () => {
    const state = reducedState();
    const report = evaluateCompleteness({
      ...state,
      implementation: { ...DOC_IMPL, digest: 'different-digest' },
      implValidation: [],
    });

    expect(slot(report, 'implValidation')?.status).not.toBe('waived');
  });
});
