/**
 * @module integration/plugin-reviewer-step-budget.test
 * @description Native-transport regression: a reviewer child that the host
 * stopped at its configured step budget is re-armed on the same frozen
 * obligation instead of being consumed as an `unable_to_review` verdict.
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
import { seedStrictImplementationSession } from './plugin-host-task-diagnostics-test-helpers.js';
import { REVIEWER_STEP_LIMIT } from '../templates/mandates-reviewer-criteria.js';

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
    parts: toolCall ? [{ type: 'tool' }] : [{ type: 'text' }],
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

  it('re-arms at the host step limit and binds the fresh attempt', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessionID = crypto.randomUUID();
      const { sessDir, obligationId } = await seedStrictImplementationSession(
        ws.tmpDir,
        sessionID,
        { maxReviewerAttempts: 2 },
      );
      const exhaustedTranscript = {
        data: [
          { info: { role: 'user' } },
          ...Array.from({ length: REVIEWER_STEP_LIMIT - 1 }, () => step('tool-calls', true)),
          step('stop', false),
        ],
      };
      const healthyTranscript = {
        data: [{ info: { role: 'user' } }, step('tool-calls', true), step('stop', false)],
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

      const retry = JSON.parse(String(first.output)) as Record<string, unknown>;
      expect(retry.reviewRetry).toMatchObject({
        code: 'REVIEWER_STEP_BUDGET_EXHAUSTED',
        obligationId,
        retryable: true,
      });
      // The exhausted child was never serialized; the retry gets a fresh attempt.
      expect(structuredPrompt).not.toHaveBeenCalled();

      sessionClient.transcript = healthyTranscript;
      const retryAttemptId = String((retry.reviewRetry as Record<string, unknown>).attemptId);
      await dispatchReviewerTask(hooks, sessionID, 'call-step-budget-2');
      const second = await completeReviewerTask(hooks, sessionID, 'call-step-budget-2');
      const completed = JSON.parse(String(second.output)) as Record<string, unknown>;
      expect(completed.reviewDispatch).toEqual({
        required: true,
        completed: true,
        verdict: 'accept',
      });
      const state = await readState(sessDir);
      expect(state?.reviewAssurance?.obligations[0]?.status).toBe('fulfilled');
      expect(
        state?.reviewAssurance?.attempts.find((a) => a.attemptId === retryAttemptId)?.status,
      ).toBe('bound');
    } finally {
      await ws.cleanup();
    }
  });

  it('fails closed when required host messages evidence is unavailable', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessionID = crypto.randomUUID();
      const { sessDir, obligationId } = await seedStrictImplementationSession(
        ws.tmpDir,
        sessionID,
        { maxReviewerAttempts: 2 },
      );
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

      expect(blocked).toMatchObject({ error: true, code: 'REVIEWER_STEP_BUDGET_UNVERIFIABLE' });
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
