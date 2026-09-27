/**
 * @module integration/tools/validation/ceremony-decision.test
 * @description Negative-path contract for the post-check ceremony decision.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../verification/implementation-subject.js', () => ({
  reattestImplementationSubject: vi.fn(),
  flowguardReportArtifacts: vi.fn(() => []),
}));

import { reattestImplementationSubject } from '../../../verification/implementation-subject.js';
import {
  IMPL_EVIDENCE,
  makeState,
  POLICY_SNAPSHOT,
  VALIDATION_FAILED,
  VALIDATION_PASSED,
  VERIFICATION_CANDIDATES,
} from '../../../fixtures.js';
import { TEST_EXECUTION_OBSERVATION } from '../../../state/evidence-test-constants.js';
import { ceremonyAuditIntent, decidePostCheckCeremony } from './ceremony-decision.js';

const mockedReattest = vi.mocked(reattestImplementationSubject);

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
    verificationCandidates: VERIFICATION_CANDIDATES,
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
    mockedReattest.mockReset();
    mockedReattest.mockResolvedValue({ kind: 'ok', digest: DOC_IMPL.digest });
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

  it('BAD: PASS results with invalidated attempts stay pending, never a final denial', async () => {
    const state = baseState({
      implValidation: VALIDATION_PASSED,
      validationAttempts: [],
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
    mockedReattest.mockResolvedValue({
      kind: 'subject_changed',
      expected: DOC_IMPL.digest,
      actual: 'different-digest',
    });
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

  it('BAD: policy-disabled ceremony decides full without touching the worktree', async () => {
    // The re-attestation serves the reduced path only: a statically ineligible
    // cycle must never gain a new worktree-derived block (e.g. from
    // FlowGuard's own per-attempt report files on the full-ceremony default).
    mockedReattest.mockRejectedValue(new Error('must not re-attest'));
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

    expect(mockedReattest).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('decided');
    if (outcome.kind !== 'decided') return;
    expect(outcome.decision.profile).toBe('full');
    expect(outcome.decision.reason).toBe('POLICY_REDUCED_CEREMONY_DISABLED');
    expect(outcome.state.reducedCeremony).toBeNull();
  });

  it('HAPPY: an eligible cycle passes the candidate-bound report artifacts to re-attestation', async () => {
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
    expect(mockedReattest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reattestImplementationSubject).mock.calls[0]?.[0]).toMatchObject({
      worktree: '/tmp/worktree',
      frozenFiles: DOC_IMPL.changedFiles,
      ignoredArtifacts: [],
    });
  });

  it('BAD: an ineligible claim decides full without re-attesting unchanged bytes', async () => {
    mockedReattest.mockRejectedValue(new Error('must not re-attest'));
    const state = baseState({
      implValidation: VALIDATION_PASSED,
      validationAttempts: [attempt('test', true), attempt('lint', true)],
      claimedTaskClass: 'STANDARD',
    });
    const outcome = await decidePostCheckCeremony({
      state,
      worktree: '/tmp/worktree',
      digest: passthroughDigest,
      now: '2026-01-02T00:00:00.000Z',
    });

    expect(mockedReattest).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('decided');
    if (outcome.kind !== 'decided') return;
    expect(outcome.decision.profile).toBe('full');
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

describe('ceremonyAuditIntent', () => {
  const decision = {
    profile: 'reduced' as const,
    reason: 'POST_IMPL_VERIFIED_TRIVIAL',
    claimedTaskClass: 'TRIVIAL' as const,
    computedMinimumTaskClass: 'TRIVIAL' as const,
    touchedSurfaces: [],
    riskTriggers: [],
    implementationId: DOC_IMPL.implementationId,
    implementationDigest: DOC_IMPL.digest,
    policyDigest: 'a'.repeat(64),
    verificationBasis: {
      checkIds: ['test'],
      attempts: [
        {
          checkId: 'test',
          attemptId: '00000000-0000-4000-8000-0000000000f1',
          executedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    },
    decidedAt: '2026-01-02T00:00:00.000Z',
  };

  it('records an applied decision with its exact binding', () => {
    const intents = ceremonyAuditIntent(decision, '2026-01-02T00:00:00.000Z', DOC_IMPL, true);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      phase: 'IMPL_VALIDATION',
      event: 'reduced_ceremony_applied',
      detail: {
        status: 'applied',
        implementationId: DOC_IMPL.implementationId,
        implementationDigest: DOC_IMPL.digest,
        checkIds: ['test'],
        attemptIds: ['00000000-0000-4000-8000-0000000000f1'],
      },
    });
  });

  it('records a denial with its structured reason', () => {
    const intents = ceremonyAuditIntent(
      {
        profile: 'full',
        reason: 'VERIFICATION_EVIDENCE_INCOMPLETE',
        claimedTaskClass: 'TRIVIAL',
        computedMinimumTaskClass: 'TRIVIAL',
        touchedSurfaces: [],
        riskTriggers: [],
      },
      '2026-01-02T00:00:00.000Z',
      DOC_IMPL,
      true,
    );
    expect(intents).toMatchObject([
      {
        event: 'reduced_ceremony_denied',
        detail: {
          status: 'ineligible',
          reason: 'VERIFICATION_EVIDENCE_INCOMPLETE',
          implementationId: DOC_IMPL.implementationId,
          implementationDigest: DOC_IMPL.digest,
        },
      },
    ]);
  });

  it('records nothing when no decision was evaluated (aborted cycle)', () => {
    expect(ceremonyAuditIntent(null, '2026-01-02T00:00:00.000Z', null, true)).toEqual([]);
  });

  it('emits nothing when the decision is not new (same generation recheck)', () => {
    expect(ceremonyAuditIntent(decision, '2026-01-02T00:00:00.000Z', DOC_IMPL, false)).toEqual([]);
  });
});
