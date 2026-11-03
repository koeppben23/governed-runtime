/** Product composition + real workflow/outbox persistence, mocked host execution.
 * These tests do not establish native-host provenance or restart recovery. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readState } from '../adapters/persistence.js';
import { createTestWorkspace } from './test-helpers.js';
import { seedStrictPlanSession } from './plugin-host-task-diagnostics-test-helpers.js';
import { createWorkspace } from './plugin-workspace.js';
import { createV2Host, v2ToolEvent, createReviewClient } from './opencode-v2-test-helpers.js';
import { createNativeReviewerAuthority } from './plugin-native-review.js';
import { OpenCodeGovernance, type NativeBefore } from './opencode-governance.js';
import { OpenCodeHostAdapter } from './opencode-host-adapter.js';
import { registerPendingReviewForAttempt } from './review/enforcement/enforcement.js';
import { resolveReviewContinuation } from '../state/review-continuation.js';
import { plan } from './tools/index.js';
import { writeStateWithArtifacts } from './tools/helpers.js';

const model = { providerID: 'component', id: 'review', variant: 'selected' };
const idle = { type: 'idle', outcome: 'succeeded' };
const assistant = (id: string) => ({
  type: 'assistant',
  id,
  agent: 'flowguard-reviewer',
  model,
  finish: 'stop',
  time: { completed: Date.now() },
  content: [{ type: 'text', text: 'review' }],
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const ws = await createTestWorkspace();
  cleanup.push(() => ws.cleanup());
  const seeded = await seedStrictPlanSession(ws.tmpDir, 'root');
  const state = (await readState(seeded.sessDir))!;
  const host = createV2Host(ws.tmpDir);
  await host.seedActive('root', state.policySnapshot.hash);
  host.sessionGet.mockImplementation(async ({ sessionID }) => ({
    id: sessionID,
    location: { directory: ws.tmpDir },
    ...(sessionID === 'child' ? { parentID: 'root', agent: 'flowguard-reviewer' } : {}),
  }));
  const workspace = createWorkspace({ auditWorktree: ws.tmpDir });
  registerPendingReviewForAttempt(
    workspace.getEnforcementState('root'),
    'flowguard_plan',
    {
      obligationId: seeded.obligationId,
      attemptId: state.reviewAssurance!.attempts[0]!.attemptId,
    },
    new Date().toISOString(),
  );
  const log = { info: vi.fn(), warn: vi.fn() };
  const runtime = {
    ws: workspace,
    orchestratorDeps: {
      updateReviewAssurance: workspace.updateReviewAssurance,
      resolveSessionAuthority: workspace.resolveSessionAuthority,
      blockReviewOutcome: workspace.blockReviewOutcome,
      getEnforcementState: workspace.getEnforcementState,
      client: createReviewClient(),
      log,
    },
    log,
    logError: vi.fn(),
    reviewerExecutionTimeoutMs: 600000,
    reviewerOutputCapFailures: new Map(),
  };
  const reviewer = createNativeReviewerAuthority(host.ctx, async () => runtime as never);
  const controller = new AbortController();
  cleanup.push(async () => controller.abort());
  const governance = new OpenCodeGovernance(
    host.ctx,
    new OpenCodeHostAdapter(host.ctx, controller.signal),
    controller.signal,
    reviewer,
  );
  const root = await governance.resolve('root');
  if (root.kind !== 'active') throw new Error('fixture root unavailable');
  const call = v2ToolEvent({
    sessionID: 'root',
    tool: 'subagent',
    id: 'call',
    input: { agent: 'flowguard-reviewer', description: 'review', prompt: 'untrusted' },
  }) as NativeBefore;
  await governance.authorizeDispatch(root.scope, call);
  await governance.observeProgress({
    type: 'session.tool.progress',
    id: 'receipt',
    created: 1,
    data: {
      sessionID: 'root',
      assistantMessageID: 'message',
      id: 'call',
      metadata: { sessionID: 'child', status: 'running' },
    },
  } as never);
  const child = await governance.resolve('child');
  if (child.kind !== 'active') throw new Error('fixture child unavailable');
  const text = `You are a subagent spawned by another session.\n${(call.input as { prompt: string }).prompt}`;
  const user = { type: 'user', id: 'msg_user', text, files: [] };
  await reviewer.prompt(child.scope, {
    sessionID: 'child',
    messageID: user.id,
    prompt: { text },
  } as never);
  host.sessionContext.mockResolvedValue([user]);
  await reviewer.context(child.scope, { tools: {} });
  await reviewer.request(child.scope, {
    sessionID: 'child',
    agent: 'flowguard-reviewer',
    kind: 'primary',
    model,
  } as never);
  let history: unknown[] = [user, assistant('msg_review'), idle];
  host.sessionContext.mockImplementation(async () => history);
  const findings = {
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
    attestation: { toolObligationId: seeded.obligationId },
  };
  const controls = { payload: JSON.stringify(findings), tool: false, wrongModel: false };
  host.prompt.mockImplementation(async (raw) => {
    const input = raw as { id: string; text: string; sessionID: string };
    await reviewer.prompt(child.scope, {
      sessionID: input.sessionID,
      messageID: input.id,
      prompt: { text: input.text },
    } as never);
    await reviewer.context(child.scope, { tools: {} });
    await reviewer.request(child.scope, {
      sessionID: input.sessionID,
      agent: 'flowguard-reviewer',
      kind: 'primary',
      model: controls.wrongModel ? { ...model, id: 'foreign' } : model,
    } as never);
    if (controls.tool)
      await reviewer.beforeTool(child.scope, {
        agent: 'flowguard-reviewer',
        tool: 'read',
        sessionID: child.scope.sessionId,
        input: {},
      });
    history = [
      ...history,
      { ...user, id: input.id, text: input.text },
      { ...assistant('msg_serialized'), content: [{ type: 'text', text: controls.payload }] },
      idle,
    ];
    return { id: input.id, type: 'user' };
  });
  const wait = vi.fn(async () => {});
  Object.assign(host.context.session, { wait });
  const event = {
    ...call,
    status: 'completed',
    result: { content: 'raw native result', metadata: { sessionID: 'child' } },
  };
  return {
    ws,
    seeded,
    host,
    workspace,
    runtime,
    reviewer,
    governance,
    root: root.scope,
    child: child.scope,
    event,
    controls,
    wait,
    setHistory: (value: unknown[]) => {
      history = value;
    },
    history: () => history,
  };
}

describe('native capture composition with durable evidence', () => {
  it('keeps the lease through the durable commit then projects the exact invocation', async () => {
    const h = await fixture();
    await h.reviewer.capture(h.root, h.event);
    const state = (await readState(h.seeded.sessDir))!;
    expect(state.reviewAssurance!.obligations[0]!.status).toBe('fulfilled');
    expect(state.reviewAssurance!.dispatches[0]!.dispatchStatus).toBe('completed');
    expect(state.reviewAssurance!.attempts[0]!.status).toBe('bound');
    expect(state.reviewAssurance!.invocations).toHaveLength(1);
    expect(JSON.parse(h.event.result.content)).toMatchObject({
      reviewDispatch: { completed: true, verdict: 'accept' },
      reviewExecution: { childSessionId: 'child' },
    });
    expect(h.event.result.metadata).toHaveProperty('flowguardReviewExecution');
    expect(h.host.prompt).toHaveBeenCalledTimes(1);
  });

  it('R1/R3 refuses an extra completed assistant before serialization or evidence', async () => {
    const h = await fixture();
    const original = h.history();
    h.setHistory([original[0], assistant('msg_foreign'), ...original.slice(1)]);
    await h.reviewer.capture(h.root, h.event);
    expect(h.host.prompt).not.toHaveBeenCalled();
    expect((await readState(h.seeded.sessDir))!.reviewAssurance!.invocations).toEqual([]);
    expect(h.event.result.content).toContain('REVIEWER_EXECUTION_OUTCOME_UNKNOWN');
  });

  it.each(['tool', 'wrongModel', 'invalidJson', 'wrongObligation', 'invalidFindings'])(
    'fails %s closed and never writes invocation evidence',
    async (mode) => {
      const h = await fixture();
      if (mode === 'tool') h.controls.tool = true;
      if (mode === 'wrongModel') h.controls.wrongModel = true;
      if (mode === 'invalidJson') h.controls.payload = 'not JSON';
      if (mode === 'wrongObligation')
        h.controls.payload = h.controls.payload.replace(
          h.seeded.obligationId,
          '22222222-2222-4222-8222-222222222222',
        );
      if (mode === 'invalidFindings') h.controls.payload = '{}';
      await h.reviewer.capture(h.root, h.event);
      const state = (await readState(h.seeded.sessDir))!;
      expect(state.reviewAssurance!.invocations).toEqual([]);
      expect(state.reviewAssurance!.attempts[0]!.status).toBe('rejected');
      expect(h.event.result.content).toContain('REVIEWER_CAPTURE_PROVENANCE_INVALID');
    },
  );

  it.each(['prompt', 'wait', 'history', 'persistence'])(
    'keeps an unknown %s outcome blocked without invoking a second reviewer',
    async (phase) => {
      const h = await fixture();
      if (phase === 'prompt')
        h.host.prompt.mockRejectedValueOnce(new Error('injected prompt failure'));
      if (phase === 'wait') h.wait.mockRejectedValueOnce(new Error('injected wait failure'));
      if (phase === 'history')
        h.host.sessionContext.mockRejectedValueOnce(new Error('injected context failure'));
      if (phase === 'persistence')
        vi.spyOn(h.runtime.orchestratorDeps, 'updateReviewAssurance').mockRejectedValueOnce(
          new Error('injected evidence write failure'),
        );
      await h.reviewer.capture(h.root, h.event);
      const state = (await readState(h.seeded.sessDir))!;
      expect(state.reviewAssurance!.invocations).toEqual([]);
      expect(state.reviewAssurance!.obligations[0]!.status).toBe('blocked');
      expect(h.event.result.content).toContain('REVIEWER_EXECUTION_OUTCOME_UNKNOWN');
    },
  );

  it('R2 retains committed evidence on a projection error without repeating serialization', async () => {
    const h = await fixture();
    h.runtime.log.info.mockImplementationOnce(() => {
      throw new Error('injected projection failure');
    });
    await expect(h.reviewer.capture(h.root, h.event as never)).rejects.toThrow(
      'injected projection',
    );
    const state = (await readState(h.seeded.sessDir))!;
    expect(state.reviewAssurance!.obligations[0]!.status).toBe('fulfilled');
    expect(resolveReviewContinuation(state.reviewAssurance, 'plan').kind).toBe('awaiting_verdict');
    await expect(h.reviewer.capture(h.root, h.event as never)).rejects.toHaveProperty(
      'code',
      'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    );
    expect(h.host.prompt).toHaveBeenCalledTimes(1);
    expect((await readState(h.seeded.sessDir))!.reviewAssurance).toEqual(state.reviewAssurance);
  });

  it('R2 completes the review from committed evidence after a restart without another reviewer', async () => {
    const h = await fixture();
    // Like the native smoke seed: materialize the derived artifacts of the seeded state.
    await writeStateWithArtifacts(h.seeded.sessDir, (await readState(h.seeded.sessDir))!);
    h.runtime.log.info.mockImplementationOnce(() => {
      throw new Error('injected projection failure');
    });
    await expect(h.reviewer.capture(h.root, h.event as never)).rejects.toThrow(
      'injected projection',
    );
    const committed = (await readState(h.seeded.sessDir))!;
    const invocation = committed.reviewAssurance!.invocations[0]!;
    expect(invocation).toMatchObject({ transportVersion: 6, consumedByObligationId: null });

    // Restart: no plugin runtime, capture fence, pending review or reviewer
    // child survives. Only the persisted state and the canonical tool remain.
    const result = await plan.execute(
      { reviewVerdict: 'accept' },
      {
        sessionID: 'root',
        messageID: 'msg_after_restart',
        agent: 'build',
        directory: h.ws.tmpDir,
        worktree: h.ws.tmpDir,
        abort: new AbortController().signal,
        metadata: () => {},
      },
    );
    expect(String(result)).not.toContain('"error":true');
    const completed = (await readState(h.seeded.sessDir))!.reviewAssurance!;
    expect(completed.obligations[0]).toMatchObject({ status: 'consumed' });
    expect(completed.invocations).toHaveLength(1);
    expect(completed.invocations[0]).toMatchObject({
      invocationId: invocation.invocationId,
      consumedByObligationId: committed.reviewAssurance!.obligations[0]!.obligationId,
    });
    expect(h.host.prompt).toHaveBeenCalledTimes(1);
  });

  it('reopens an unknown outcome only after a later user turn and a settled child', async () => {
    const h = await fixture();
    h.wait.mockRejectedValueOnce(new Error('injected wait failure'));
    await h.reviewer.capture(h.root, h.event);
    const blocked = (await readState(h.seeded.sessDir))!;
    expect(blocked.reviewAssurance!.capacityLock?.code).toBe('REVIEWER_EXECUTION_OUTCOME_UNKNOWN');
    const parent: unknown[] = [
      { type: 'user', id: 'msg_u1' },
      { type: 'assistant', id: 'message' },
    ];
    h.host.sessionContext.mockImplementation(async (input) =>
      (input as { sessionID: string }).sessionID === 'root' ? parent : h.history(),
    );
    const retry = (input: Record<string, unknown>) => ({
      agent: 'build',
      tool: 'flowguard_plan',
      sessionID: 'root',
      input,
    });

    // Caller text or a retry in the same turn never reopens.
    await h.reviewer.beforeTool(h.root, retry({ recovery: 'settled' }));
    await expect(
      h.reviewer.beforeTool(h.root, retry({ reviewRecovery: 'retry_transport' })),
    ).rejects.toHaveProperty('code', 'REVIEW_CAPACITY_REQUIRES_NEW_USER_COMMAND');
    expect((await readState(h.seeded.sessDir))!.reviewAssurance).toEqual(blocked.reviewAssurance);
    expect(h.host.interrupt).not.toHaveBeenCalled();

    parent.push({ type: 'user', id: 'msg_u2' });
    await h.reviewer.beforeTool(h.root, retry({ reviewRecovery: 'retry_transport' }));
    const reopened = (await readState(h.seeded.sessDir))!.reviewAssurance!;
    expect(h.host.interrupt).toHaveBeenCalledWith({ sessionID: 'child', resume: false });
    expect(reopened.capacityLock).toBeNull();
    expect(reopened.obligations[0]).toMatchObject({ status: 'pending', blockedCode: null });
    expect(reopened.attempts).toEqual(blocked.reviewAssurance!.attempts);
    expect(reopened.dispatches).toEqual(blocked.reviewAssurance!.dispatches);
    expect(resolveReviewContinuation(reopened, 'plan').kind).toBe('interrupted_dispatch');
  });
});
