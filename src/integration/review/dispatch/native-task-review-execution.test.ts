import { describe, expect, it, vi } from 'vitest';
import { blockIncoherentCompletedCapture } from './native-task-review-execution.js';
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
});
