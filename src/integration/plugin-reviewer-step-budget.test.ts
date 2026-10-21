/**
 * @module integration/plugin-reviewer-step-budget.test
 * @description Native-transport regressions for reviewer task completion,
 * asserted against the PERSISTED review authority:
 * - a child the host stopped at its configured step budget is closed
 *   terminally with its original code, never consumed as a verdict and never
 *   re-armed automatically;
 * - the real 2026-10-19 plan-review child (token-truncated, `finish: "length"`,
 *   no final answer) is never serialized: no invocation, no findings, no
 *   fulfilled/bound attempt; the spent attempt is staled and the obligation is
 *   blocked with a persistent capacity lock instead of being re-armed;
 * - an aborted child is never restarted automatically.
 *
 * @test-policy BAD, CORNER
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { FlowGuardAuditPlugin } from './plugin.js';
import { createBootableHostClient, createTestWorkspace } from './test-helpers.js';
import { readState } from '../adapters/persistence.js';
import { TEST_EXECUTION_OBSERVATION } from '../state/evidence-test-constants.js';
import { _resetAgentResolutionCache } from './review/dispatch/agent-resolution.js';
import {
  resolveReviewDispatchAuthority,
  reviewObligationResponseFields,
} from './review/dispatch/dispatch-authority.js';
import { REVIEWER_STEP_LIMIT } from '../templates/mandates-reviewer-criteria.js';
import { readFileSync } from 'node:fs';
import {
  seedStrictPlanSession,
  seedStrictImplementationSession as seedImplementation,
} from './plugin-host-task-diagnostics-test-helpers.js';

const CHILD_SESSION_ID = 'child-session-step-budget';
const CALL_ID = 'call-step-budget-1';

function mockInput(worktree: string, overrides: Record<string, unknown> = {}) {
  return {
    project: {} as unknown,
    client: createBootableHostClient(),
    $: {} as unknown,
    directory: worktree,
    worktree,
    serverUrl: new URL('http://localhost:3000'),
    ...overrides,
  } as unknown as Parameters<typeof FlowGuardAuditPlugin>[0];
}

function nativeFindings(obligationId: string): Record<string, unknown> {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    attestation: { toolObligationId: obligationId },
  };
}

function step(finish: string, toolCall: boolean) {
  return {
    info: { role: 'assistant', finish },
    parts: toolCall ? [{ type: 'tool' }] : [{ type: 'text', text: 'Final review answer.' }],
  };
}

async function dispatchReviewerTask(
  hooks: Awaited<ReturnType<typeof FlowGuardAuditPlugin>>,
  sessionID: string,
  callID = CALL_ID,
) {
  const output: { args: Record<string, unknown> } = {
    args: { subagent_type: 'flowguard-reviewer', prompt: 'agent-authored prompt' },
  };
  await hooks['tool.execute.before']!({ tool: 'task', sessionID, callID }, output);
  return output;
}

async function completeReviewerTask(
  hooks: Awaited<ReturnType<typeof FlowGuardAuditPlugin>>,
  sessionID: string,
  callID = CALL_ID,
) {
  const output: { title: string; output: string; metadata: Record<string, unknown> } = {
    title: 'task',
    output: 'Free-form reviewer transcript text is not findings authority.',
    metadata: { sessionId: CHILD_SESSION_ID },
  };
  await hooks['tool.execute.after']!(
    { tool: 'task', sessionID, callID, args: { subagent_type: 'flowguard-reviewer' } },
    output,
  );
  return output;
}

describe('native reviewer step-budget recovery', () => {
  beforeEach(() => {
    _resetAgentResolutionCache();
  });

  it('closes at the host step limit without serialization or a fresh attempt', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessionID = crypto.randomUUID();
      const { sessDir, obligationId } = await seedImplementation(ws.tmpDir, sessionID);
      const exhaustedTranscript = {
        data: [
          { info: { role: 'user' } },
          ...Array.from({ length: REVIEWER_STEP_LIMIT - 1 }, () => step('tool-calls', true)),
          step('stop', false),
        ],
      };
      const structuredPrompt = vi.fn(async () => ({
        data: { info: { structured: nativeFindings(obligationId) } },
      }));
      const agents = vi.fn(async () => ({ data: [{ id: 'flowguard-reviewer' }] }));
      // The generated SDK client reads `_client` through `this`; a detached
      // `messages` method must throw, exactly like the real host client.
      const sessionClient = {
        _client: { transport: 'host' },
        transcript: exhaustedTranscript as unknown,
        async messages(this: { _client?: unknown; transcript: unknown }) {
          if (this._client === undefined) {
            throw new TypeError("Cannot read properties of undefined (reading '_client')");
          }
          return this.transcript as never;
        },
        prompt: structuredPrompt,
      };
      const hooks = await FlowGuardAuditPlugin(
        mockInput(ws.tmpDir, {
          client: { app: { log: async () => {}, agents }, session: sessionClient },
        }),
      );

      const authority = resolveReviewDispatchAuthority(
        (await readState(sessDir))!.reviewAssurance,
        obligationId,
      );
      expect(authority.kind).toBe('ok');
      if (authority.kind !== 'ok') return;
      const dispatchOutput = {
        title: 'implement',
        output: JSON.stringify({
          phase: 'IMPL_REVIEW',
          reviewMode: 'subagent',
          ...reviewObligationResponseFields(authority.authority),
          reviewDispatch: { required: true },
        }),
        metadata: {},
      };
      await hooks['tool.execute.after']!(
        { tool: 'flowguard_implement', sessionID, callID: 'c1', args: {} },
        dispatchOutput,
      );
      await dispatchReviewerTask(hooks, sessionID);
      const first = await completeReviewerTask(hooks, sessionID);

      const blocked = JSON.parse(String(first.output)) as Record<string, unknown>;
      expect(blocked).toMatchObject({
        error: true,
        code: 'REVIEWER_STEP_BUDGET_EXHAUSTED',
      });
      expect(blocked.reviewRetry).toBeUndefined();
      expect(structuredPrompt).not.toHaveBeenCalled();

      const state = (await readState(sessDir))!;
      expect(state.reviewAssurance!.obligations[0]?.status).toBe('blocked');
      expect(state.reviewAssurance!.obligations[0]?.blockedCode).toBe(
        'REVIEWER_STEP_BUDGET_EXHAUSTED',
      );
      expect(state.reviewAssurance!.attempts).toHaveLength(1);
      expect(state.reviewAssurance!.attempts[0]?.status).toBe('stale');
      expect(state.reviewAssurance!.capacityLock).toMatchObject({
        code: 'REVIEWER_STEP_BUDGET_EXHAUSTED',
        obligationId,
      });
    } finally {
      await ws.cleanup();
    }
  });

  it('fails closed when required host messages evidence is unavailable', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessionID = crypto.randomUUID();
      const { sessDir, obligationId } = await seedImplementation(ws.tmpDir, sessionID, {
        maxReviewerAttempts: 2,
      });
      const structuredPrompt = vi.fn(async () => ({
        data: { info: { structured: nativeFindings(obligationId) } },
      }));
      const agents = vi.fn(async () => ({ data: [{ id: 'flowguard-reviewer' }] }));
      const hooks = await FlowGuardAuditPlugin(
        mockInput(ws.tmpDir, {
          client: {
            app: { log: async () => {}, agents },
            session: { prompt: structuredPrompt },
          },
        }),
      );

      const authority = resolveReviewDispatchAuthority(
        (await readState(sessDir))!.reviewAssurance,
        obligationId,
      );
      expect(authority.kind).toBe('ok');
      if (authority.kind !== 'ok') return;
      await hooks['tool.execute.after']!(
        { tool: 'flowguard_implement', sessionID, callID: 'c1', args: {} },
        {
          title: 'implement',
          output: JSON.stringify({
            phase: 'IMPL_REVIEW',
            reviewMode: 'subagent',
            ...reviewObligationResponseFields(authority.authority),
            reviewDispatch: { required: true },
          }),
          metadata: {},
        },
      );
      await dispatchReviewerTask(hooks, sessionID);
      const completed = await completeReviewerTask(hooks, sessionID);
      const blocked = JSON.parse(String(completed.output)) as Record<string, unknown>;

      expect(blocked).toMatchObject({ error: true, code: 'REVIEWER_COMPLETION_UNVERIFIABLE' });
      expect(blocked.reviewRetry).toBeUndefined();
      // The serialization prompt is what could turn an unknown review into a
      // bound one; it must never run without verified host evidence.
      expect(structuredPrompt).not.toHaveBeenCalled();

      const state = await readState(sessDir);
      expect(state?.reviewAssurance?.invocations ?? []).toHaveLength(0);
      expect(
        (state?.reviewAssurance?.attempts ?? []).filter((attempt) => attempt.status === 'bound'),
      ).toHaveLength(0);
      expect(state?.reviewAssurance?.obligations[0]?.status).toBe('pending');
      // The abandoned attempt is staled atomically, so a manual re-run can
      // re-arm the same frozen obligation instead of dead-ending.
      const attempts = state?.reviewAssurance?.attempts ?? [];
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe('stale');
    } finally {
      await ws.cleanup();
    }
  });
});

const OCT19_TRUNCATED = JSON.parse(
  readFileSync(
    new URL(
      './review/dispatch/__fixtures__/reviewer-plan-2026-10-19-pre-followup-redacted.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as unknown;

const ABORTED_TRANSCRIPT = {
  data: [
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
  ],
};

/**
 * Boot the plugin over a seeded session whose reviewer child returns the given
 * host messages, register the pending review through the owning tool's
 * after-hook, and complete one native reviewer Task.
 */
async function runReviewerTask(input: {
  readonly kind: 'plan' | 'implement';
  readonly maxReviewerAttempts?: number;
  readonly messages: unknown;
}) {
  const ws = await createTestWorkspace();
  const sessionID = crypto.randomUUID();
  const seeded =
    input.kind === 'plan'
      ? await seedStrictPlanSession(ws.tmpDir, sessionID)
      : await seedImplementation(ws.tmpDir, sessionID, {
          maxReviewerAttempts: input.maxReviewerAttempts ?? 2,
        });
  const { sessDir, obligationId } = seeded;
  const structuredPrompt = vi.fn(async () => ({
    data: { info: { structured: nativeFindings(obligationId) } },
  }));
  const agents = vi.fn(async () => ({ data: [{ id: 'flowguard-reviewer' }] }));
  const hooks = await FlowGuardAuditPlugin(
    mockInput(ws.tmpDir, {
      client: {
        app: { log: async () => {}, agents },
        session: { prompt: structuredPrompt, messages: vi.fn(async () => input.messages) },
      },
    }),
  );
  const before = (await readState(sessDir))!;
  const authority = resolveReviewDispatchAuthority(before.reviewAssurance, obligationId);
  if (authority.kind !== 'ok') throw new Error(`no dispatch authority: ${authority.reason}`);
  await hooks['tool.execute.after']!(
    {
      tool: input.kind === 'plan' ? 'flowguard_plan' : 'flowguard_implement',
      sessionID,
      callID: 'c1',
      args: {},
    },
    {
      title: input.kind,
      output: JSON.stringify({
        phase: input.kind === 'plan' ? 'PLAN' : 'IMPL_REVIEW',
        reviewMode: 'subagent',
        ...reviewObligationResponseFields(authority.authority),
        reviewDispatch: { required: true },
      }),
      metadata: {},
    },
  );
  await dispatchReviewerTask(hooks, sessionID);
  const completed = await completeReviewerTask(hooks, sessionID);
  const after = (await readState(sessDir))!;
  return {
    ws,
    sessionID,
    hooks,
    obligationId,
    initialAttemptId: before.reviewAssurance!.attempts[0]!.attemptId,
    before,
    after,
    structuredPrompt,
    output: JSON.parse(String(completed.output)) as Record<string, unknown>,
  };
}

/** Nothing was accepted: no invocation, no findings, no fulfilled/bound authority. */
function expectNothingAccepted(
  run: Awaited<ReturnType<typeof runReviewerTask>>,
  kind: 'plan' | 'implement',
) {
  const assurance = run.after.reviewAssurance!;
  expect(run.structuredPrompt).not.toHaveBeenCalled();
  expect(assurance.invocations).toHaveLength(0);
  expect(assurance.attempts.filter((attempt) => attempt.status === 'bound')).toHaveLength(0);
  const obligation = assurance.obligations.find((o) => o.obligationId === run.obligationId)!;
  expect(obligation.status).not.toBe('fulfilled');
  expect(obligation.status).not.toBe('consumed');
  expect(obligation.invocationId).toBeNull();
  expect(obligation.fulfilledAt).toBeNull();
  if (kind === 'plan') {
    expect(run.after.plan?.reviewFindings).toEqual(run.before.plan?.reviewFindings);
    expect(run.after.selfReview).toEqual(run.before.selfReview);
  } else {
    expect(run.after.implReviewFindings).toEqual(run.before.implReviewFindings);
  }
  // The spent release is abandoned, never completed.
  expect(assurance.dispatches.every((d) => d.dispatchStatus === 'outcome_unknown')).toBe(true);
}

describe('native reviewer task completion (persisted authority)', () => {
  beforeEach(() => {
    _resetAgentResolutionCache();
  });

  it.each(['plan', 'implement'] as const)(
    '%s: the truncated 2026-10-19 child is terminal, never accepted or re-armed',
    async (kind) => {
      const run = await runReviewerTask({ kind, messages: OCT19_TRUNCATED });
      try {
        expect(run.output).toMatchObject({ error: true, code: 'REVIEWER_OUTPUT_TRUNCATED' });
        expect(run.output.reviewRetry).toBeUndefined();
        expectNothingAccepted(run, kind);
        const attempts = run.after.reviewAssurance!.attempts;
        expect(attempts).toHaveLength(1);
        expect(attempts[0]?.attemptId).toBe(run.initialAttemptId);
        expect(attempts[0]?.status).toBe('stale');
        expect(run.after.reviewAssurance!.obligations[0]?.status).toBe('blocked');
        expect(run.after.reviewAssurance!.obligations[0]?.blockedCode).toBe(
          'REVIEWER_OUTPUT_TRUNCATED',
        );
        expect(run.after.reviewAssurance!.capacityLock).toMatchObject({
          code: 'REVIEWER_OUTPUT_TRUNCATED',
          obligationId: run.obligationId,
        });
      } finally {
        await run.ws.cleanup();
      }
    },
  );

  it('holds the capacity lock across run_check, implementation verdict, and plugin restart', async () => {
    const run = await runReviewerTask({ kind: 'plan', messages: OCT19_TRUNCATED });
    try {
      for (const tool of ['flowguard_run_check', 'flowguard_review_implementation']) {
        await expect(
          run.hooks['tool.execute.before']!(
            { tool, sessionID: run.sessionID, callID: `locked-${tool}` },
            { args: {} },
          ),
        ).rejects.toThrow(/REVIEW_CAPACITY_REQUIRES_NEW_USER_COMMAND/);
      }

      // A fresh plugin boot reads the persisted lock, not process memory.
      const restarted = await FlowGuardAuditPlugin(mockInput(run.ws.tmpDir));
      await expect(
        restarted['tool.execute.before']!(
          { tool: 'flowguard_plan', sessionID: run.sessionID, callID: 'restart-plan' },
          { args: {} },
        ),
      ).rejects.toThrow(/REVIEW_CAPACITY_REQUIRES_NEW_USER_COMMAND/);
    } finally {
      await run.ws.cleanup();
    }
  });

  it('a truncated child with an exhausted attempt budget blocks without a fresh attempt', async () => {
    const run = await runReviewerTask({
      kind: 'implement',
      maxReviewerAttempts: 0,
      messages: OCT19_TRUNCATED,
    });
    try {
      expect(run.output).toMatchObject({ error: true, code: 'REVIEWER_OUTPUT_TRUNCATED' });
      expect(run.output.reviewRetry).toBeUndefined();
      expect(run.structuredPrompt).not.toHaveBeenCalled();
      const assurance = run.after.reviewAssurance!;
      expect(assurance.invocations).toHaveLength(0);
      expect(assurance.attempts).toHaveLength(1);
      expect(assurance.attempts[0]?.status).toBe('stale');
      expect(assurance.obligations[0]?.status).toBe('blocked');
      expect(assurance.capacityLock).toMatchObject({
        code: 'REVIEWER_OUTPUT_TRUNCATED',
        obligationId: run.obligationId,
      });
    } finally {
      await run.ws.cleanup();
    }
  });

  it('an aborted child is terminal and never restarted automatically', async () => {
    const run = await runReviewerTask({ kind: 'implement', messages: ABORTED_TRANSCRIPT });
    try {
      expect(run.output).toMatchObject({ error: true, code: 'REVIEWER_TASK_ABORTED' });
      expect(run.output.reviewRetry).toBeUndefined();
      expectNothingAccepted(run, 'implement');
      const attempts = run.after.reviewAssurance!.attempts;
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe('stale');
      expect(run.after.reviewAssurance!.obligations[0]?.status).toBe('pending');
    } finally {
      await run.ws.cleanup();
    }
  });
});
