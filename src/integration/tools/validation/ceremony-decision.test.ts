/**
 * @module integration/tools/validation/ceremony-decision.test
 * @description Negative-path contract for the post-check ceremony decision.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../verification/implementation-subject.js', () => ({
  computeImplementationDigest: vi.fn(),
}));

import { computeImplementationDigest } from '../../../verification/implementation-subject.js';
import {
  IMPL_EVIDENCE,
  makeState,
  POLICY_SNAPSHOT,
  VALIDATION_FAILED,
  VALIDATION_PASSED,
} from '../../../fixtures.js';
import { TEST_EXECUTION_OBSERVATION } from '../../../state/evidence-test-constants.js';
import { decidePostCheckCeremony } from './ceremony-decision.js';

const mockedDigest = vi.mocked(computeImplementationDigest);

/** Documentation-only implementation: TRIVIAL under the general classifier. */
const DOC_IMPL = {
  ...IMPL_EVIDENCE,
  changedFiles: ['docs/usage-notes.md'],
  domainFiles: [],
};

function attempt(checkId: string, passed: boolean) {
  const base = passed ? VALIDATION_PASSED[checkId === 'test' ? 0 : 1]! : VALIDATION_FAILED[0]!;
  return {
    attemptId:
      checkId === 'test'
        ? '00000000-0000-4000-8000-0000000000d1'
        : '00000000-0000-4000-8000-0000000000d2',
    scope: 'implementation' as const,
    implementationId: DOC_IMPL.implementationId,
    implementationDigest: DOC_IMPL.digest,
    executionObservation: TEST_EXECUTION_OBSERVATION,
    result: { ...base, checkId, passed } as (typeof VALIDATION_PASSED)[number],
  };
}

function baseState(overrides: Record<string, unknown> = {}) {
  return makeState('IMPL_VALIDATION', {
    claimedTaskClass: 'TRIVIAL',
    implementation: DOC_IMPL,
    activeChecks: ['test', 'lint'],
    policySnapshot: {
      ...POLICY_SNAPSHOT,
      allowReducedCeremony: true,
      requireHumanGates: true,
      effectiveGateBehavior: 'human_gated',
    },
    ...overrides,
  });
}

const passthroughDigest = (text: string) => text;

describe('decidePostCheckCeremony', () => {
  beforeEach(() => {
    mockedDigest.mockReset();
    mockedDigest.mockResolvedValue(DOC_IMPL.digest);
  });

  it('HAPPY: decides reduced only with the complete check set, bound bytes and policy', async () => {
    const state = baseState({
      implValidation: VALIDATION_PASSED,
      validationAttempts: [attempt('test', true), attempt('lint', true)],
    });
    const outcome = await decidePostCheckCeremony({
      state,
      worktree: '/tmp/worktree',
      digest: passthroughDigest,
      now: '2026-01-02T00:00:00.000Z',
    });

    expect(outcome.kind).toBe('decided');
    if (outcome.kind !== 'decided') return;
    expect(outcome.decision.profile).toBe('reduced');
    expect(outcome.state.reducedCeremony).toMatchObject({
      profile: 'reduced',
      reason: 'POST_IMPL_VERIFIED_TRIVIAL',
      implementationId: DOC_IMPL.implementationId,
      implementationDigest: DOC_IMPL.digest,
      policyDigest: state.policySnapshot.hash,
    });
    expect(outcome.state.reducedCeremony?.verificationBasis.checkIds).toEqual(['test', 'lint']);
  });

  it('BAD: an incomplete check set produces no decision', async () => {
    const state = baseState({
      implValidation: [VALIDATION_PASSED[0]!],
      validationAttempts: [attempt('test', true)],
    });
    const outcome = await decidePostCheckCeremony({
      state,
      worktree: '/tmp/worktree',
      digest: passthroughDigest,
      now: '2026-01-02T00:00:00.000Z',
    });

    expect(outcome.kind).toBe('skipped');
    if (outcome.kind !== 'skipped') return;
    expect(outcome.state.reducedCeremony).toBeNull();
  });

  it('BAD: a failing latest result clears any earlier decision and never decides', async () => {
    const state = baseState({
      implValidation: [VALIDATION_PASSED[0]!, VALIDATION_FAILED[0]!],
      validationAttempts: [attempt('test', true), attempt('lint', false)],
    });
    const outcome = await decidePostCheckCeremony({
      state,
      worktree: '/tmp/worktree',
      digest: passthroughDigest,
      now: '2026-01-02T00:00:00.000Z',
    });

    expect(outcome.kind).toBe('skipped');
    if (outcome.kind !== 'skipped') return;
    expect(outcome.state.reducedCeremony).toBeNull();
  });

  it('BAD: worktree bytes that no longer match the frozen digest fail closed', async () => {
    mockedDigest.mockResolvedValue('different-digest');
    const state = baseState({
      implValidation: VALIDATION_PASSED,
      validationAttempts: [attempt('test', true), attempt('lint', true)],
    });
    const outcome = await decidePostCheckCeremony({
      state,
      worktree: '/tmp/worktree',
      digest: passthroughDigest,
      now: '2026-01-02T00:00:00.000Z',
    });

    expect(outcome).toMatchObject({ kind: 'subject_changed', expected: DOC_IMPL.digest });
  });

  it('BAD: policy-disabled ceremony decides full with the denial reason', async () => {
    const state = baseState({
      implValidation: VALIDATION_PASSED,
      validationAttempts: [attempt('test', true), attempt('lint', true)],
      policySnapshot: {
        ...POLICY_SNAPSHOT,
        allowReducedCeremony: false,
        requireHumanGates: true,
      },
    });
    const outcome = await decidePostCheckCeremony({
      state,
      worktree: '/tmp/worktree',
      digest: passthroughDigest,
      now: '2026-01-02T00:00:00.000Z',
    });

    expect(outcome.kind).toBe('decided');
    if (outcome.kind !== 'decided') return;
    expect(outcome.decision.profile).toBe('full');
    expect(outcome.decision.reason).toBe('POLICY_REDUCED_CEREMONY_DISABLED');
    expect(outcome.state.reducedCeremony).toBeNull();
  });

  it('CORNER: solo without human gates is never eligible', async () => {
    const state = baseState({
      implValidation: VALIDATION_PASSED,
      validationAttempts: [attempt('test', true), attempt('lint', true)],
      policySnapshot: {
        ...POLICY_SNAPSHOT,
        allowReducedCeremony: true,
        requireHumanGates: false,
      },
    });
    const outcome = await decidePostCheckCeremony({
      state,
      worktree: '/tmp/worktree',
      digest: passthroughDigest,
      now: '2026-01-02T00:00:00.000Z',
    });

    expect(outcome.kind).toBe('decided');
    if (outcome.kind !== 'decided') return;
    expect(outcome.decision.reason).toBe('POLICY_HUMAN_GATE_REQUIRED_FOR_REDUCED_CEREMONY');
  });
});
