/**
 * @module rails/review-decision-reduced-ceremony.test
 * @description Approval-gate contract for the reduced-ceremony waiver and the
 * preserved governance-override path.
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
import type { SessionState } from '../state/schema.js';
import { TEST_EXECUTION_OBSERVATION } from '../state/evidence-test-constants.js';
import {
  enforceImplementationReviewSubject,
  type ReviewDecisionInput,
} from './review-decision-gates.js';

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
        ? '00000000-0000-4000-8000-0000000000f1'
        : '00000000-0000-4000-8000-0000000000f2',
    scope: 'implementation' as const,
    implementationId: DOC_IMPL.implementationId,
    implementationDigest: DOC_IMPL.digest,
    executionObservation: TEST_EXECUTION_OBSERVATION,
    result: { ...base, checkId, passed: true } as (typeof VALIDATION_PASSED)[number],
  };
}

function reducedState(): SessionState {
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
      escalatedTaskClass: 'TRIVIAL',
      touchedSurfaces: ['docs/usage-notes.md'],
      riskTriggers: [],
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
      escalatedTaskClass: 'TRIVIAL',
      computedMinimumTaskClass: 'TRIVIAL',
      touchedSurfaces: ['docs/usage-notes.md'],
      implementationId: DOC_IMPL.implementationId,
      implementationDigest: DOC_IMPL.digest,
      policyDigest: policySnapshot.hash,
      verificationBasis: {
        checkIds: ['test', 'lint'],
        attempts: [
          {
            checkId: 'test',
            attemptId: '00000000-0000-4000-8000-0000000000f1',
            executedAt: VALIDATION_PASSED[0]!.executedAt,
          },
          {
            checkId: 'lint',
            attemptId: '00000000-0000-4000-8000-0000000000f2',
            executedAt: VALIDATION_PASSED[1]!.executedAt,
          },
        ],
      },
      decidedAt: '2026-01-02T00:00:00.000Z',
    },
  });
}

const input: ReviewDecisionInput = {
  verdict: 'approve',
  rationale: 'ship it',
  decisionIdentity: {
    actorId: 'approver',
    actorEmail: null,
    actorSource: 'unknown',
    actorAssurance: 'best_effort',
  },
};

describe('reduced-ceremony approval gate', () => {
  it('BAD: a normal approval without review and without waiver is blocked', () => {
    const state = makeState('EVIDENCE_REVIEW', { implementation: DOC_IMPL });

    expect(enforceImplementationReviewSubject(state, input)).toMatchObject({
      code: 'IMPLEMENTATION_REVIEW_EVIDENCE_REQUIRED',
    });
  });

  it('HAPPY: a valid waiver with a matching worktree attestation approves, without one it fails closed', () => {
    const state = reducedState();

    expect(enforceImplementationReviewSubject(state, input)).toMatchObject({
      code: 'IMPLEMENTATION_REVIEW_SUBJECT_MISMATCH',
    });
    expect(
      enforceImplementationReviewSubject(state, {
        ...input,
        subjectAttestation: { kind: 'ok', digest: DOC_IMPL.digest },
      }),
    ).toBeNull();
    expect(
      enforceImplementationReviewSubject(state, {
        ...input,
        subjectAttestation: {
          kind: 'subject_changed',
          expected: DOC_IMPL.digest,
          actual: 'other-digest',
        },
      }),
    ).toMatchObject({ code: 'IMPLEMENTATION_REVIEW_SUBJECT_MISMATCH' });
  });

  it('BAD: a detached waiver (digest mismatch) cannot be approved', () => {
    const state = reducedState();
    const detached: SessionState = {
      ...state,
      implementation: { ...DOC_IMPL, digest: 'different-digest' },
    };

    expect(
      enforceImplementationReviewSubject(detached, {
        ...input,
        subjectAttestation: { kind: 'ok', digest: 'different-digest' },
      }),
    ).toMatchObject({ code: 'IMPLEMENTATION_REVIEW_EVIDENCE_REQUIRED' });
  });

  it('BAD: the governance override still requires a real review result', () => {
    expect(
      enforceImplementationReviewSubject(reducedState(), {
        ...input,
        verdict: 'approve_with_governance_override',
        subjectAttestation: { kind: 'ok', digest: DOC_IMPL.digest },
      }),
    ).toMatchObject({ code: 'IMPLEMENTATION_REVIEW_EVIDENCE_REQUIRED' });
  });
});
