/** Persisted canonical completion/capacity contracts through semantic host ports.
 * Historical transcripts retain their bytes; they do not prove V2 execution. */
import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FlowGuardAuditPlugin } from './plugin.js';
import { createTestWorkspace } from './test-helpers.js';
import { createReviewClient, createV2Host, v2ToolEvent } from './opencode-v2-test-helpers.js';
import { readState } from '../adapters/persistence.js';
import {
  resolveReviewDispatchAuthority,
  reviewObligationResponseFields,
} from './review/dispatch/dispatch-authority.js';
import { REVIEWER_STEP_LIMIT } from '../templates/mandates-reviewer-criteria.js';
import {
  seedStrictPlanSession,
  seedStrictImplementationSession,
} from './plugin-host-task-diagnostics-test-helpers.js';
import {
  createReviewRuntime,
  REVIEW_TEST_PROOF_GRAPH_AUTHORITIES,
} from './reviewer-capture-test-helpers.js';
import {
  nativeReviewTaskBefore,
  nativeReviewTaskAfter,
} from './review/dispatch/native-task-review.js';
import { onFlowGuardToolAfter } from './review/enforcement/enforcement.js';
import { isTerminalPhase } from '../machine/topology.js';

const CHILD = 'child-step-budget';
const CALL = 'call-step-budget';
const OCT19 = JSON.parse(
  readFileSync(
    new URL(
      './review/dispatch/__fixtures__/reviewer-plan-2026-10-19-pre-followup-redacted.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { data: unknown };
function step(finish: string, tool = false) {
  return {
    info: { role: 'assistant', finish },
    parts: tool ? [{ type: 'tool' }] : [{ type: 'text', text: 'Final answer.' }],
  };
}
const ABORTED = [
  { info: { role: 'user' } },
  step('tool-calls', true),
  {
    info: {
      role: 'assistant',
      finish: 'stop',
      error: { name: 'MessageAbortedError', data: { message: 'aborted by user' } },
    },
    parts: [{ type: 'text', text: 'Partial.' }],
  },
];

async function runReviewerTask(input: {
  kind: 'plan' | 'implement';
  history?: unknown;
  maxReviewerAttempts?: number;
}) {
  const ws = await createTestWorkspace();
  try {
    const sessionID = crypto.randomUUID();
    const seeded =
      input.kind === 'plan'
        ? await seedStrictPlanSession(ws.tmpDir, sessionID)
        : await seedStrictImplementationSession(ws.tmpDir, sessionID, {
            maxReviewerAttempts: input.maxReviewerAttempts ?? 2,
          });
    const structuredPrompt = vi.fn(async () => {
      throw new Error('Incomplete reviews must not be serialized');
    });
    const client = createReviewClient({
      executeReviewerPrompt: structuredPrompt,
      readHistory:
        input.history === undefined
          ? vi.fn().mockRejectedValue(new Error('history unavailable'))
          : vi.fn(async () => input.history),
    });
    const runtime = createReviewRuntime(ws.tmpDir, client);
    const before = (await readState(seeded.sessDir))!;
    const authority = resolveReviewDispatchAuthority(before.reviewAssurance, seeded.obligationId);
    if (authority.kind !== 'ok') throw new Error(authority.reason);
    const tool = input.kind === 'plan' ? 'flowguard_plan' : 'flowguard_implement';
    const response = JSON.stringify({
      phase: input.kind === 'plan' ? 'PLAN' : 'IMPL_REVIEW',
      reviewMode: 'subagent',
      ...reviewObligationResponseFields(authority.authority),
      reviewDispatch: { required: true },
    });
    onFlowGuardToolAfter(runtime.ws.getEnforcementState(sessionID), tool, {}, response, {
      now: new Date().toISOString(),
      isTerminalPhase,
    });
    await nativeReviewTaskBefore(
      runtime,
      { tool: 'task', sessionID, callID: CALL },
      { args: { subagent_type: 'flowguard-reviewer', prompt: 'untrusted' } },
      async () => undefined,
      REVIEW_TEST_PROOF_GRAPH_AUTHORITIES,
    );
    const result = { title: '', output: 'Not findings authority.', metadata: { sessionId: CHILD } };
    await nativeReviewTaskAfter(
      runtime,
      { tool: 'task', sessionID, callID: CALL, args: { subagent_type: 'flowguard-reviewer' } },
      result,
    );
    return {
      ws,
      runtime,
      sessionID,
      ...seeded,
      before,
      after: (await readState(seeded.sessDir))!,
      structuredPrompt,
      output: JSON.parse(result.output) as Record<string, unknown>,
    };
  } catch (error) {
    await ws.cleanup();
    throw error;
  }
}

function expectNothingAccepted(
  run: Awaited<ReturnType<typeof runReviewerTask>>,
  kind: 'plan' | 'implement',
) {
  const assurance = run.after.reviewAssurance!;
  expect(run.structuredPrompt).not.toHaveBeenCalled();
  expect(assurance.invocations).toHaveLength(0);
  expect(assurance.attempts.filter((attempt) => attempt.status === 'bound')).toHaveLength(0);
  const obligation = assurance.obligations.find((item) => item.obligationId === run.obligationId)!;
  expect(obligation.status).not.toBe('fulfilled');
  expect(obligation.status).not.toBe('consumed');
  expect(obligation.invocationId).toBeNull();
  expect(obligation.fulfilledAt).toBeNull();
  if (kind === 'plan') {
    expect(run.after.plan?.reviewFindings).toEqual(run.before.plan?.reviewFindings);
    expect(run.after.selfReview).toEqual(run.before.selfReview);
  } else expect(run.after.implReviewFindings).toEqual(run.before.implReviewFindings);
  expect(
    assurance.dispatches.every((dispatch) => dispatch.dispatchStatus === 'outcome_unknown'),
  ).toBe(true);
}

describe('canonical reviewer completion and persisted capacity', () => {
  it('closes a configured host-step-limit stop without serialization or a fresh attempt', async () => {
    const history = [
      { info: { role: 'user' } },
      ...Array.from({ length: REVIEWER_STEP_LIMIT - 1 }, () => step('tool-calls', true)),
      step('stop'),
    ];
    const run = await runReviewerTask({ kind: 'implement', history });
    try {
      expect(run.output).toMatchObject({ error: true, code: 'REVIEWER_STEP_BUDGET_EXHAUSTED' });
      expect(run.output.reviewRetry).toBeUndefined();
      expectNothingAccepted(run, 'implement');
      expect(run.after.reviewAssurance!.obligations[0]).toMatchObject({
        status: 'blocked',
        blockedCode: 'REVIEWER_STEP_BUDGET_EXHAUSTED',
      });
      expect(run.after.reviewAssurance!.attempts).toHaveLength(1);
      expect(run.after.reviewAssurance!.attempts[0]?.status).toBe('stale');
      expect(run.after.reviewAssurance!.capacityLock).toMatchObject({
        code: 'REVIEWER_STEP_BUDGET_EXHAUSTED',
        obligationId: run.obligationId,
      });
    } finally {
      await run.ws.cleanup();
    }
  });

  it('never serializes unavailable history or manufactures fulfilled/bound authority', async () => {
    const run = await runReviewerTask({ kind: 'implement' });
    try {
      expect(run.output).toMatchObject({ error: true, code: 'REVIEWER_COMPLETION_UNVERIFIABLE' });
      expect(run.output.reviewRetry).toBeUndefined();
      expectNothingAccepted(run, 'implement');
      expect(run.after.reviewAssurance!.obligations[0]?.status).toBe('pending');
      expect(run.after.reviewAssurance!.attempts).toHaveLength(1);
      expect(run.after.reviewAssurance!.attempts[0]?.status).toBe('stale');
    } finally {
      await run.ws.cleanup();
    }
  });

  it.each(['plan', 'implement'] as const)(
    '%s: preserves the real truncated 2026-10-19 transcript outcome without re-arming',
    async (kind) => {
      const run = await runReviewerTask({ kind, history: OCT19.data });
      try {
        expect(run.output).toMatchObject({ error: true, code: 'REVIEWER_OUTPUT_TRUNCATED' });
        expect(run.output.reviewRetry).toBeUndefined();
        expectNothingAccepted(run, kind);
        expect(run.after.reviewAssurance!.attempts).toHaveLength(1);
        expect(run.after.reviewAssurance!.attempts[0]?.attemptId).toBe(
          run.before.reviewAssurance!.attempts[0]?.attemptId,
        );
        expect(run.after.reviewAssurance!.attempts[0]?.status).toBe('stale');
        expect(run.after.reviewAssurance!.obligations[0]).toMatchObject({
          status: 'blocked',
          blockedCode: 'REVIEWER_OUTPUT_TRUNCATED',
        });
        expect(run.after.reviewAssurance!.capacityLock).toMatchObject({
          code: 'REVIEWER_OUTPUT_TRUNCATED',
          obligationId: run.obligationId,
        });
      } finally {
        await run.ws.cleanup();
      }
    },
  );

  it('retains the durable capacity lock across check/verdict tools and native plugin reload', async () => {
    const run = await runReviewerTask({ kind: 'plan', history: OCT19.data });
    let dispose: (() => void | Promise<void>) | undefined;
    try {
      const native = createV2Host(run.ws.tmpDir);
      dispose = (await FlowGuardAuditPlugin.setup(native.ctx)) || undefined;
      for (const tool of [
        'flowguard_run_check',
        'flowguard_review_implementation',
        'flowguard_plan',
      ]) {
        await expect(
          native.before(
            v2ToolEvent({ tool, sessionID: run.sessionID, id: `locked-${tool}`, input: {} }),
          ),
        ).rejects.toThrow('REVIEW_CAPACITY_REQUIRES_NEW_USER_COMMAND');
      }
      expect((await readState(run.sessDir))!.reviewAssurance!.capacityLock).toEqual(
        run.after.reviewAssurance!.capacityLock,
      );
    } finally {
      await dispose?.();
      await run.ws.cleanup();
    }
  });

  it('does not grant another attempt when truncation closes an exhausted budget', async () => {
    const run = await runReviewerTask({
      kind: 'implement',
      history: OCT19.data,
      maxReviewerAttempts: 0,
    });
    try {
      expect(run.output).toMatchObject({ error: true, code: 'REVIEWER_OUTPUT_TRUNCATED' });
      expect(run.output.reviewRetry).toBeUndefined();
      expectNothingAccepted(run, 'implement');
      expect(run.after.reviewAssurance!.attempts).toHaveLength(1);
      expect(run.after.reviewAssurance!.attempts[0]?.status).toBe('stale');
      expect(run.after.reviewAssurance!.obligations[0]?.status).toBe('blocked');
    } finally {
      await run.ws.cleanup();
    }
  });

  it('treats an aborted canonical transcript as terminal and never restarts it', async () => {
    const run = await runReviewerTask({ kind: 'implement', history: ABORTED });
    try {
      expect(run.output).toMatchObject({ error: true, code: 'REVIEWER_TASK_ABORTED' });
      expect(run.output.reviewRetry).toBeUndefined();
      expectNothingAccepted(run, 'implement');
      expect(run.after.reviewAssurance!.attempts).toHaveLength(1);
      expect(run.after.reviewAssurance!.attempts[0]?.status).toBe('stale');
      expect(run.after.reviewAssurance!.obligations[0]?.status).toBe('pending');
    } finally {
      await run.ws.cleanup();
    }
  });
});
