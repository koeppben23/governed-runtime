/** Canonical semantic-port failures, capture fences and durable execution closure.
 * Not a simulated native V2 reviewer release or installed-host provenance proof. */
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ReviewerExecutionWatchdog } from './reviewer-execution-watchdog.js';
import { createReviewerExecutionFailurePersister } from './reviewer-execution-failure.js';
import { createTestWorkspace } from './test-helpers.js';
import { createReviewClient } from './opencode-v2-test-helpers.js';
import { seedStrictPlanSession } from './plugin-host-task-diagnostics-test-helpers.js';
import { readState } from '../adapters/persistence.js';
import {
  completedReviewMessages,
  createReviewRuntime,
  REVIEW_TEST_PROOF_GRAPH_AUTHORITIES,
} from './reviewer-capture-test-helpers.js';
import {
  nativeReviewTaskBefore,
  nativeReviewTaskAfter,
} from './review/dispatch/native-task-review.js';
import { onFlowGuardToolAfter } from './review/enforcement/enforcement.js';
import { isTerminalPhase } from '../machine/topology.js';
import {
  resolveReviewDispatchAuthority,
  reviewObligationResponseFields,
} from './review/dispatch/dispatch-authority.js';
import type { ReviewerExecutionFailure } from './review/types.js';

const CHILD = 'child-A';
const CALL = 'call-A';
const classified = {
  type: 'provider',
  message: 'Unsupported value for reasoning_effort: none. Only supports low or high.',
};
type Outcome =
  | 'classified-thrown'
  | 'classified-message'
  | 'throw'
  | 'old-envelope'
  | 'empty'
  | 'unknown-message';

async function setup(outcome: Outcome) {
  const ws = await createTestWorkspace();
  try {
    const sessionID = randomUUID();
    const { sessDir, obligationId } = await seedStrictPlanSession(ws.tmpDir, sessionID);
    const client = createReviewClient({
      listAgents: vi.fn(async () => [{ id: 'flowguard-reviewer' }]),
      getSession: vi.fn(async (sessionId) => ({
        sessionId,
        parentSessionId: sessionID,
        directory: ws.tmpDir,
      })),
      readHistory: vi.fn(async () => completedReviewMessages(CHILD)),
      interrupt: vi.fn(async () => true),
      quiescence: vi.fn(async () => 'unknown' as const),
      reviewerCall: vi.fn(async () => CALL),
      executeReviewerPrompt: vi.fn(async () => {
        if (outcome === 'classified-thrown') throw classified;
        if (outcome === 'classified-message') return { info: { error: classified } };
        if (outcome === 'throw') throw new Error('transport failed during serialization');
        if (outcome === 'old-envelope') return { error: new Error('old SDK response envelope') };
        if (outcome === 'unknown-message')
          return { info: { error: { type: 'unknown', message: 'host disconnected' } } };
        return {};
      }),
    });
    const runtime = createReviewRuntime(ws.tmpDir, client);
    const authority = resolveReviewDispatchAuthority(
      (await readState(sessDir))!.reviewAssurance,
      obligationId,
    );
    if (authority.kind !== 'ok') throw new Error(authority.reason);
    onFlowGuardToolAfter(
      runtime.ws.getEnforcementState(sessionID),
      'flowguard_plan',
      {},
      JSON.stringify({
        phase: 'PLAN',
        reviewMode: 'subagent',
        ...reviewObligationResponseFields(authority.authority),
        reviewDispatch: { required: true },
      }),
      { now: new Date().toISOString(), isTerminalPhase },
    );
    await nativeReviewTaskBefore(
      runtime,
      { tool: 'task', sessionID, callID: CALL },
      { args: { subagent_type: 'flowguard-reviewer', prompt: 'untrusted' } },
      async () => undefined,
      REVIEW_TEST_PROOF_GRAPH_AUTHORITIES,
    );
    const identity = { parentSessionId: sessionID, callId: CALL, childSessionId: CHILD };
    const output = { title: '', output: '', metadata: { sessionId: CHILD } };
    const complete = () =>
      nativeReviewTaskAfter(
        runtime,
        { tool: 'task', sessionID, callID: CALL, args: { subagent_type: 'flowguard-reviewer' } },
        output,
      );
    return { ws, sessionID, sessDir, obligationId, runtime, client, identity, output, complete };
  } catch (error) {
    await ws.cleanup();
    throw error;
  }
}

it.each(['classified-thrown', 'classified-message'] as const)(
  'retains the exact child fence after terminal %s failure without fabricated completion',
  async (outcome) => {
    const h = await setup(outcome);
    try {
      await h.complete();
      expect(h.output.output).toContain('STRUCTURED_REVIEW_EXECUTION_MODE_INCOMPATIBLE');
      const capture = h.runtime.orchestratorDeps.reviewerCapture!;
      expect(await capture.reconcileOnIdle(h.client, CHILD)).toBe(false);
      expect(() => capture.beforeTool({ sessionID: CHILD, tool: 'read' })).toThrow();
      const state = (await readState(h.sessDir))!;
      expect(state.reviewAssurance!.dispatches[0]?.dispatchStatus).toBe('outcome_unknown');
      expect(state.reviewAssurance!.attempts[0]?.status).toBe('stale');
      expect(state.reviewAssurance!.invocations).toEqual([]);
    } finally {
      await h.ws.cleanup();
    }
  },
);

it.each(['throw', 'old-envelope', 'empty', 'unknown-message'] as const)(
  'persists unknown %s execution before removing monitoring, retaining quarantine and the capacity lock',
  async (outcome) => {
    const h = await setup(outcome);
    const persist = createReviewerExecutionFailurePersister({
      ws: h.runtime.ws,
      orchestratorDeps: h.runtime.orchestratorDeps,
      log: { error: vi.fn() },
    });
    const failures = new Map<string, ReviewerExecutionFailure>();
    const watchdog = new ReviewerExecutionWatchdog({
      client: h.client,
      config: {
        toolTimeoutMs: 30_000,
        reviewTimeoutMs: 480_000,
        serializationTimeoutMs: 60_000,
        executionTimeoutMs: 600_000,
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      persistFailure: persist,
      failures,
    });
    const finish = vi.spyOn(watchdog, 'finishTask');
    try {
      watchdog.onTaskAuthorized(h.sessionID, CALL);
      await expect(h.complete()).rejects.toThrow(
        /transport failed|execution outcome|SDK response envelopes/,
      );
      expect(finish).not.toHaveBeenCalled();
      await expect(watchdog.failTask(h.identity)).resolves.toBe(true);
      expect(finish).not.toHaveBeenCalled();
      const capture = h.runtime.orchestratorDeps.reviewerCapture!;
      expect(await capture.reconcileOnIdle(h.client, CHILD)).toBe(false);
      expect(() => capture.beforeTool({ sessionID: CHILD, tool: 'read' })).toThrow();
      const state = (await readState(h.sessDir))!;
      expect(state.reviewAssurance!.obligations[0]).toMatchObject({
        status: 'blocked',
        blockedCode: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
      });
      expect(state.reviewAssurance!.attempts[0]).toMatchObject({
        status: 'stale',
        childSessionId: CHILD,
      });
      expect(state.reviewAssurance!.dispatches[0]?.dispatchStatus).toBe('outcome_unknown');
      expect(state.reviewAssurance!.capacityLock?.code).toBe('REVIEWER_EXECUTION_OUTCOME_UNKNOWN');
      expect(state.reviewAssurance!.invocations).toEqual([]);
      const closure = state.pendingAuditOperations.filter(
        (operation) =>
          operation.kind === 'semantic' && operation.semantic.event === 'review:obligation_blocked',
      );
      expect(closure).toHaveLength(1);
      await expect(
        nativeReviewTaskBefore(
          h.runtime,
          { tool: 'task', sessionID: h.sessionID, callID: 'retry' },
          { args: { subagent_type: 'flowguard-reviewer' } },
          async () => undefined,
          REVIEW_TEST_PROOF_GRAPH_AUTHORITIES,
        ),
      ).rejects.toThrow('REVIEW_CAPACITY_REQUIRES_NEW_USER_COMMAND');
    } finally {
      watchdog.completeTask(CALL);
      finish.mockRestore();
      await h.ws.cleanup();
    }
  },
);
