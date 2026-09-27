/**
 * @module machine/reduced-ceremony-guard.test
 * @description Pure machine-guard invariants for reduced ceremony: the digest
 * triangle alone is not risk authority. A stale or escalated assessment, a
 * blocked risk gate, a non-TRIVIAL claim or a mismatched basis must all fail
 * closed without duplicating the integration classifier.
 *
 * @test-policy HAPPY, BAD, EDGE
 */

import { describe, expect, it } from 'vitest';

import {
  IMPL_EVIDENCE,
  makeState,
  POLICY_SNAPSHOT,
  VALIDATION_PASSED,
  VERIFICATION_CANDIDATES,
} from '../fixtures.js';
import type {
  ImplementationRiskAssessment,
  ReducedCeremonyDecision,
  SessionState,
} from '../state/schema.js';
import { TEST_EXECUTION_OBSERVATION } from '../state/evidence-test-constants.js';
import { reducedCeremonyReady } from './guards.js';

const DOC_IMPL = {
  ...IMPL_EVIDENCE,
  changedFiles: ['docs/usage-notes.md'],
  domainFiles: [],
};

const TEST_ATTEMPT_ID = '00000000-0000-4000-8000-0000000000a1';
const LINT_ATTEMPT_ID = '00000000-0000-4000-8000-0000000000a2';

function attempt(checkId: string) {
  const base = VALIDATION_PASSED[checkId === 'test' ? 0 : 1]!;
  return {
    attemptId: checkId === 'test' ? TEST_ATTEMPT_ID : LINT_ATTEMPT_ID,
    scope: 'implementation' as const,
    implementationId: DOC_IMPL.implementationId,
    implementationDigest: DOC_IMPL.digest,
    executionObservation: TEST_EXECUTION_OBSERVATION,
    result: { ...base, checkId, passed: true },
  };
}

const RISK_ASSESSMENT: ImplementationRiskAssessment = {
  computedMinimumTaskClass: 'TRIVIAL',
  touchedSurfaces: [],
  riskTriggers: [],
  assessedFrom: 'implementation_changed_files',
  assessedFileCount: 1,
  implementationDigest: DOC_IMPL.digest,
};

const POLICY = {
  ...POLICY_SNAPSHOT,
  allowReducedCeremony: true,
  requireHumanGates: true,
  effectiveGateBehavior: 'human_gated' as const,
};

const DECISION: ReducedCeremonyDecision = {
  profile: 'reduced',
  reason: 'POST_IMPL_VERIFIED_TRIVIAL',
  claimedTaskClass: 'TRIVIAL',
  computedMinimumTaskClass: 'TRIVIAL',
  touchedSurfaces: [],
  implementationId: DOC_IMPL.implementationId,
  implementationDigest: DOC_IMPL.digest,
  policyDigest: POLICY.hash,
  verificationBasis: {
    checkIds: ['test', 'lint'],
    attempts: [
      { checkId: 'test', attemptId: TEST_ATTEMPT_ID, executedAt: VALIDATION_PASSED[0]!.executedAt },
      { checkId: 'lint', attemptId: LINT_ATTEMPT_ID, executedAt: VALIDATION_PASSED[1]!.executedAt },
    ],
  },
  decidedAt: '2026-01-02T00:00:00.000Z',
};

function boundState(overrides: Partial<SessionState> = {}): SessionState {
  return makeState('IMPL_VALIDATION', {
    claimedTaskClass: 'TRIVIAL',
    verificationCandidates: VERIFICATION_CANDIDATES,
    implementation: DOC_IMPL,
    implementationRiskAssessment: RISK_ASSESSMENT,
    activeChecks: ['test', 'lint'],
    implValidation: VALIDATION_PASSED,
    validationAttempts: [attempt('test'), attempt('lint')],
    policySnapshot: POLICY,
    reducedCeremony: DECISION,
    ...overrides,
  });
}

describe('reducedCeremonyReady binding invariants', () => {
  it('HAPPY: accepts only the fully bound decision', () => {
    expect(reducedCeremonyReady(boundState())).toBe(true);
  });

  it('BAD: a HIGH-RISK assessment rejects the decision', () => {
    const state = boundState({
      implementationRiskAssessment: { ...RISK_ASSESSMENT, computedMinimumTaskClass: 'HIGH-RISK' },
    });
    expect(reducedCeremonyReady(state)).toBe(false);
  });

  it('BAD: a changed assessment digest rejects the decision', () => {
    const state = boundState({
      implementationRiskAssessment: { ...RISK_ASSESSMENT, implementationDigest: 'other' },
    });
    expect(reducedCeremonyReady(state)).toBe(false);
  });

  it('BAD: a blocked risk gate rejects the decision', () => {
    const state = boundState({
      riskGate: {
        status: 'blocked',
        code: 'RISK_CLASSIFICATION_MISMATCH',
        message: 'blocked',
        blockedAt: '2026-01-02T00:00:00.000Z',
        lastDecisionId: 'RISK-1',
      },
    });
    expect(reducedCeremonyReady(state)).toBe(false);
  });

  it('BAD: a non-TRIVIAL claim rejects the decision', () => {
    expect(reducedCeremonyReady(boundState({ claimedTaskClass: 'STANDARD' }))).toBe(false);
  });

  it('BAD: a decision with a non-TRIVIAL computed class rejects', () => {
    const state = boundState({
      reducedCeremony: { ...DECISION, computedMinimumTaskClass: 'HIGH-RISK' },
    });
    expect(reducedCeremonyReady(state)).toBe(false);
  });

  it('BAD: a decision claimed as STANDARD rejects', () => {
    const state = boundState({ reducedCeremony: { ...DECISION, claimedTaskClass: 'STANDARD' } });
    expect(reducedCeremonyReady(state)).toBe(false);
  });

  it('BAD: disabled policy flags reject the decision', () => {
    expect(
      reducedCeremonyReady(
        boundState({ policySnapshot: { ...POLICY, allowReducedCeremony: false } }),
      ),
    ).toBe(false);
    expect(
      reducedCeremonyReady(boundState({ policySnapshot: { ...POLICY, requireHumanGates: false } })),
    ).toBe(false);
  });

  it('EDGE: a basis that no longer matches the canonical evidence rejects', () => {
    const state = boundState({
      reducedCeremony: {
        ...DECISION,
        verificationBasis: {
          ...DECISION.verificationBasis,
          attempts: DECISION.verificationBasis.attempts.map((entry, index) =>
            index === 0 ? { ...entry, attemptId: '00000000-0000-4000-8000-0000000000ff' } : entry,
          ),
        },
      },
    });
    expect(reducedCeremonyReady(state)).toBe(false);
  });

  it('EDGE: a changed policy hash rejects the decision', () => {
    const state = boundState({ reducedCeremony: { ...DECISION, policyDigest: 'b'.repeat(64) } });
    expect(reducedCeremonyReady(state)).toBe(false);
  });
});
