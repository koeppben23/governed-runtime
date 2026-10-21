import { describe, expect, it, vi } from 'vitest';

const { readState, abandonAndBlockByHostCall } = vi.hoisted(() => ({
  readState: vi.fn(),
  abandonAndBlockByHostCall: vi.fn(),
}));
vi.mock('./durable-dispatch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./durable-dispatch.js')>()),
  abandonAndBlockByHostCall,
}));
vi.mock('../../../adapters/persistence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../adapters/persistence.js')>()),
  readState,
}));

import {
  blockIncoherentCompletedCapture,
  guardPreBindReview,
  reconcileExpiredAuthorizedDispatchesOrThrow,
} from './native-task-review-execution.js';
import type { NativeReviewTransportRuntime } from './native-task-review-types.js';

function runtime() {
  const blockReviewOutcome = vi.fn(
    async (_ctx, _id, _code, _detail, output: { output: string }) => {
      output.output = JSON.stringify({ error: true, code: 'SUBAGENT_VERDICT_FINDINGS_INCOHERENT' });
    },
  );
  const pending = new Map([
    [
      'flowguard_plan',
      {
        tool: 'flowguard_plan',
        requestedAt: 'now',
        obligationId: '11111111-1111-4111-8111-111111111111',
        attemptId: '22222222-2222-4222-8222-222222222222',
      },
    ],
  ]);
  const value = {
    orchestratorDeps: { blockReviewOutcome },
    ws: { getEnforcementState: () => ({ pendingReviews: pending }) },
  } as unknown as NativeReviewTransportRuntime;
  return { value, blockReviewOutcome, pending };
}

function input(overallVerdict: string, blockingIssues: readonly unknown[]) {
  const host = runtime();
  return {
    host,
    input: {
      runtime: host.value,
      sessDir: '/tmp',
      sessionId: 'parent',
      phase: 'PLAN',
      obligationId: '11111111-1111-4111-8111-111111111111',
      prepared: { overallVerdict, blockingIssues },
      output: { output: '', title: '', metadata: {} },
    },
  };
}

describe('terminal incoherent review capture', () => {
  it('blocks accept with blocking issues and clears the pending review', async () => {
    const h = input('accept', [{ message: 'blocking' }]);
    await expect(blockIncoherentCompletedCapture(h.input)).resolves.toBe(true);
    expect(h.host.blockReviewOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'parent', phase: 'PLAN' }),
      h.input.obligationId,
      'SUBAGENT_VERDICT_FINDINGS_INCOHERENT',
      expect.any(Object),
      h.input.output,
    );
    expect(h.host.pending.size).toBe(0);
  });

  it('does not block coherent or non-accept captures', async () => {
    for (const [verdict, blocking] of [
      ['accept', []],
      ['changes_requested', [{ message: 'x' }]],
    ] as const) {
      const h = input(verdict, blocking);
      await expect(blockIncoherentCompletedCapture(h.input)).resolves.toBe(false);
      expect(h.host.blockReviewOutcome).not.toHaveBeenCalled();
    }
  });

  it('blocks a late bind after the terminal execution lock is persisted', async () => {
    readState.mockResolvedValue({
      reviewAssurance: {
        capacityLock: { code: 'REVIEWER_EXECUTION_TIMEOUT', obligationId: 'obl-1' },
        obligations: [
          {
            obligationId: 'obl-1',
            status: 'blocked',
            blockedCode: 'REVIEWER_EXECUTION_TIMEOUT',
          },
        ],
      },
    });
    const output = { output: '', title: '', metadata: {} };
    await expect(
      guardPreBindReview({
        runtime: {} as NativeReviewTransportRuntime,
        sessDir: '/tmp',
        obligationId: 'obl-1',
        output,
      }),
    ).resolves.toBe(true);
    expect(output.output).toContain('REVIEWER_EXECUTION_TIMEOUT');
  });

  it('reconciles an expired authorized dispatch after restart before a new review', async () => {
    abandonAndBlockByHostCall.mockResolvedValue({ kind: 'blocked' });
    const runtime = {
      reviewerExecutionTimeoutMs: 1,
      orchestratorDeps: {},
      ws: { resolveSessionAuthority: async () => ({ status: 'resolved' }) },
    } as unknown as NativeReviewTransportRuntime;
    const state = {
      reviewAssurance: {
        dispatches: [
          {
            dispatchStatus: 'authorized',
            dispatchAuthorizedAt: new Date(0).toISOString(),
            hostCallId: 'call-1',
          },
        ],
      },
    } as never;
    await expect(
      reconcileExpiredAuthorizedDispatchesOrThrow(runtime, 'parent', '/tmp', state),
    ).rejects.toMatchObject({ code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN' });
    expect(abandonAndBlockByHostCall).toHaveBeenCalledWith(
      runtime.orchestratorDeps,
      '/tmp',
      'call-1',
      'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    );
  });
});
