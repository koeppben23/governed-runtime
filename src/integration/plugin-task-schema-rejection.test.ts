import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readState: vi.fn(),
  buildHostTaskEvidence: vi.fn(),
  updateAttemptStatus: vi.fn(),
  strictBlockedOutput: vi.fn((code: string, detail: Record<string, unknown>) =>
    JSON.stringify({ code, detail }),
  ),
}));

vi.mock('../adapters/persistence.js', () => ({ readState: mocks.readState }));
vi.mock('./review/host-task-policy.js', () => ({
  buildHostTaskChallengeContract: () => undefined,
}));
vi.mock('./review/evidence-binding.js', () => ({
  buildHostTaskEvidence: mocks.buildHostTaskEvidence,
}));
vi.mock('./review/assurance.js', () => ({
  appendInvocationEvidence: (state: unknown) => state,
  ensureReviewAssurance: (state: unknown) => state,
  fulfillObligation: (state: unknown) => state,
  staleObligationAttempts: (state: unknown) => state,
  updateAttemptStatus: mocks.updateAttemptStatus,
}));
vi.mock('./review/obligation-settlement.js', () => ({
  settleReviewObligationAfterAttempt: (state: unknown) => state,
}));
vi.mock('./plugin-helpers.js', () => ({
  strictBlockedOutput: mocks.strictBlockedOutput,
}));
vi.mock('./review/enforcement/rejection-policy.js', () => ({
  bindOutcomeToRejectionReason: (outcome: string) =>
    outcome === 'schema_invalid' ? 'schema_invalid' : null,
}));
vi.mock('./review/schema-error-fingerprint.js', () => ({
  schemaErrorFingerprintOf: () => 'f'.repeat(64),
}));

import { handleHostTaskEvidence } from './plugin-task-evidence.js';

const ATTEMPT = {
  attemptId: '22222222-2222-4222-8222-222222222222',
  obligationId: '11111111-1111-4111-8111-111111111111',
};

function assuranceState() {
  return {
    assuranceSchemaVersion: 'review-assurance.v6',
    obligations: [{ obligationId: ATTEMPT.obligationId, status: 'pending' }],
    invocations: [],
    attempts: [ATTEMPT],
    dispatches: [],
  };
}

describe('host-task schema rejection boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readState.mockResolvedValue({
      phase: 'PLAN',
      policySnapshot: { reviewInvocationPolicy: 'host_task_required' },
      reviewAssurance: assuranceState(),
    });
    mocks.updateAttemptStatus.mockImplementation((state: unknown) => state);
    mocks.buildHostTaskEvidence.mockReturnValue({
      evidence: null,
      attempt: ATTEMPT,
      bindOutcome: 'schema_invalid',
      diagnostic: {
        message: 'Reviewer output failed schema validation before binding',
        schemaErrors: [
          'nonBlockingIssues.designChallenges: Unrecognized keys: "nonBlockingIssues", "designChallenges"',
        ],
        schemaIssueKeys: [
          {
            path: 'nonBlockingIssues.designChallenges',
            code: 'unrecognized_keys',
            message: 'Unrecognized keys: "nonBlockingIssues", "designChallenges"',
          },
        ],
      },
    });
  });

  it('classifies schema-invalid reviewer output and audits the rejection', async () => {
    let semanticFactory:
      | ((state: { phase: string }, occurredAt: string) => readonly Record<string, unknown>[])
      | undefined;
    const ws = {
      getSessionDir: () => '/session',
      getEnforcementState: () => ({}),
      updateReviewAssurance: vi.fn(
        async (
          _dir: string,
          update: (state: Record<string, unknown>) => Record<string, unknown>,
          semantic?: typeof semanticFactory,
        ) => {
          update({ phase: 'PLAN', reviewAssurance: assuranceState() });
          semanticFactory = semantic;
        },
      ),
    };
    const hookOutput: { output?: string } = {};

    await handleHostTaskEvidence(
      {
        ws: ws as never,
        log: { info: vi.fn(), warn: vi.fn() },
        logError: vi.fn(),
      },
      'host-session',
      'reviewer-child-session',
      '2026-09-11T20:19:13.244Z',
      hookOutput,
    );

    const blocked = JSON.parse(hookOutput.output ?? '{}') as {
      code?: string;
      detail?: Record<string, unknown>;
    };
    expect(blocked.code).toBe('ENVELOPE_SCHEMA_INVALID');
    expect(blocked.code).not.toBe('HOST_SUBAGENT_TASK_REQUIRED');
    expect(blocked.detail?.bindOutcome).toBe('schema_invalid');
    expect(blocked.detail?.nextAction).toContain('Re-run the originating FlowGuard command');

    expect(semanticFactory).toBeTypeOf('function');
    const events = semanticFactory?.({ phase: 'PLAN' }, '2026-09-11T20:19:13.244Z') ?? [];
    expect(events).toEqual([
      expect.objectContaining({
        phase: 'PLAN',
        event: 'review:attempt_rejected',
        detail: expect.objectContaining({
          obligationId: ATTEMPT.obligationId,
          attemptId: ATTEMPT.attemptId,
          bindOutcome: 'schema_invalid',
          rejectionReason: 'schema_invalid',
          schemaErrorFingerprint: 'f'.repeat(64),
        }),
      }),
    ]);
  });
});

