/** Positive acceptance contracts stay red until the actual native product proves them. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReviewerCaptureHostProbe } from './opencode-reviewer-capture-test-helpers.js';
import { seedStrictPlanSession } from '../integration/plugin-host-task-diagnostics-test-helpers.js';
import { readState } from '../adapters/persistence.js';
import { withTestEnv } from '../integration/test-helpers.js';
import { writeStateWithArtifacts } from '../integration/tools/helpers.js';
import { nativeOpenCodeCandidate } from './opencode-live-host-test-helpers.js';

const ENABLED =
  process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
let probe: Awaited<ReturnType<typeof createReviewerCaptureHostProbe>> | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  try {
    await probe?.close();
  } finally {
    restore?.();
    restore = undefined;
    probe = undefined;
  }
});

async function openReview() {
  probe = await createReviewerCaptureHostProbe();
  restore = withTestEnv({ OPENCODE_CONFIG_DIR: probe.env.OPENCODE_CONFIG_DIR! });
  const sessionID = await probe.session();
  const seeded = await seedStrictPlanSession(probe.project, sessionID);
  await writeStateWithArtifacts(seeded.sessDir, (await readState(seeded.sessDir))!);
  expect(probe.host.version).toBe(`opencode v${nativeOpenCodeCandidate.version}`);
  expect(probe.reportedVersion).toBe(probe.host.version);
  expect(probe.providerErrors).toEqual([]);
  expect((await probe.entries()).some((entry) => entry.hook === 'plugin-loaded')).toBe(true);
  return { probe, sessionID, seeded };
}

async function runReview(mode: 'positive' | 'tool') {
  const { probe, sessionID, seeded } = await openReview();
  await probe.run(sessionID, mode);
  expect(probe.providerErrors).toEqual([]);
  const history = await probe.history(sessionID);
  const tools = history.flatMap((message) =>
    message.type === 'assistant' ? message.content.filter((part) => part.type === 'tool') : [],
  );
  return { probe, sessionID, seeded, tools };
}

describe.skipIf(!ENABLED)('actual FlowGuard native reviewer capture on pinned OpenCode', () => {
  it('leaves the review-required output pending and authorizes the native Task before release', async () => {
    const { probe, sessionID, seeded, tools } = await runReview('positive');
    const plan = tools.find((part) => part.name === 'flowguard_plan');
    expect(
      plan,
      JSON.stringify({
        history: await probe.history(sessionID),
        state: await readState(seeded.sessDir),
      }),
    ).toMatchObject({ state: { status: 'completed' } });
    if (plan?.state.status !== 'completed')
      throw new Error('Actual product did not release a pending plan output');
    const output = plan.state.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    expect(output).toContain('reviewExecution');
    expect(output).toContain('flowguard-reviewer');
    expect(output).not.toContain('"reviewResult"');
    const task = tools.find((part) => part.name === 'subagent');
    expect(task, JSON.stringify(tools)).toMatchObject({ state: { status: 'completed' } });
    const state = await readState(seeded.sessDir);
    expect(
      state?.reviewAssurance?.dispatches.some((dispatch) => dispatch.hostCallId === task?.id),
    ).toBe(true);
    const entries = await probe.entries();
    const released = entries.findIndex(
      (entry) =>
        entry.hook === 'execute.after' &&
        entry.input?.tool === 'flowguard_plan' &&
        entry.input.status === 'completed',
    );
    const invoked = entries.findIndex(
      (entry) => entry.hook === 'execute.before' && entry.input?.tool === 'subagent',
    );
    expect(released).toBeGreaterThanOrEqual(0);
    expect(invoked).toBeGreaterThan(released);
  }, 180_000);

  it('records bound same-child evidence and fulfills the obligation', async () => {
    const { probe, sessionID, seeded } = await runReview('positive');
    const state = await readState(seeded.sessDir);
    expect(probe.serializations(), JSON.stringify({ calls: probe.calls, state })).toBe(1);
    expect(state?.reviewAssurance?.obligations[0]?.status).toBe('fulfilled');
    expect(state?.reviewAssurance?.attempts[0]).toMatchObject({
      status: 'bound',
      completedAt: expect.any(String),
    });
    const invocation = state?.reviewAssurance?.invocations[0];
    expect(invocation).toMatchObject({
      invokedAt: expect.any(String),
      fulfilledAt: expect.any(String),
    });
    const capture = invocation?.capture;
    expect(capture).toMatchObject({
      requestMessageId: expect.any(String),
      responseMessageId: expect.any(String),
      assistantMessageIds: [expect.any(String)],
      model: { providerID: 'capture', modelID: 'probe', variant: 'chosen' },
    });
    expect(capture?.assistantMessageIds).toEqual([capture?.responseMessageId]);
    const sessions = await probe.client.session.list({});
    const children = sessions.data.filter((child) => child.parentID === sessionID);
    expect(children).toHaveLength(1);
    expect(capture?.childSessionId).toBe(children[0]!.id);
    expect(state?.reviewAssurance?.attempts[0]?.childSessionId).toBe(children[0]!.id);
    const childHistory = await probe.history(children[0]!.id);
    expect(
      childHistory.some(
        (message) => message.type === 'user' && message.id === capture?.requestMessageId,
      ),
    ).toBe(true);
    expect(
      childHistory.some(
        (message) =>
          message.type === 'assistant' &&
          message.id === capture?.responseMessageId &&
          message.finish === 'stop',
      ),
    ).toBe(true);
    const serialization = probe.calls.filter((call) => call.phase === 'serialization');
    expect(serialization).toHaveLength(1);
    expect(serialization[0]!.body.model).toBe('probe');
    expect(serialization[0]!.body.reasoning_effort).toBe('high');
    expect(serialization[0]!.body.tool_choice).not.toBe('required');
    expect(JSON.stringify(serialization[0]!.body)).not.toContain('StructuredOutput');
  }, 180_000);

  it('rejects a tool call during actual same-child serialization before its output reaches the provider', async () => {
    const { probe, seeded } = await runReview('tool');
    expect(probe.serializations(), JSON.stringify(probe.calls)).toBe(1);
    const state = await readState(seeded.sessDir);
    expect(state?.reviewAssurance?.obligations[0]).toMatchObject({
      status: 'blocked',
      blockedCode: 'REVIEWER_CAPTURE_PROVENANCE_INVALID',
    });
    expect(state?.reviewAssurance?.invocations).toHaveLength(0);
    expect(state?.reviewAssurance?.attempts[0]?.status).toBe('rejected');
    expect(JSON.stringify(probe.requests)).not.toContain(probe.sentinel);
  }, 180_000);

  it('keeps caller recovery claims from unlocking an unknown outcome and recovers only through a fresh native attempt', async () => {
    const { probe, sessionID, seeded } = await openReview();
    const running = probe.run(sessionID, 'interrupted');
    try {
      await vi.waitFor(() => expect(probe.serializations()).toBe(1), { timeout: 15_000 });
      const childSessionID = probe.requests.at(-1)!.sessionID;
      expect(await probe.client.session.get({ sessionID: childSessionID })).toMatchObject({
        parentID: sessionID,
        agent: 'flowguard-reviewer',
      });
      expect(
        await probe.client.session.interrupt({ sessionID: childSessionID, resume: false }),
      ).toMatchObject({ interrupted: true });
    } finally {
      await running;
    }
    const blocked = await readState(seeded.sessDir);
    expect(blocked?.reviewAssurance?.obligations[0]).toMatchObject({
      status: 'blocked',
      blockedCode: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    });
    const historicalAttempts = structuredClone(blocked!.reviewAssurance!.attempts);
    const historicalInvocations = structuredClone(blocked!.reviewAssurance!.invocations);
    // Caller text is deliberately not an operator/settlement capability.
    await probe.prompt(
      sessionID,
      JSON.stringify({
        origin: 'human',
        captureSafe: true,
        recovery: 'settled',
        command: '/continue',
      }),
    );
    const afterClaim = await readState(seeded.sessDir);
    expect(afterClaim?.reviewAssurance?.obligations[0]?.status).toBe('blocked');
    expect(afterClaim?.reviewAssurance?.attempts).toEqual(historicalAttempts);
    expect(afterClaim?.reviewAssurance?.invocations).toEqual(historicalInvocations);
    await probe.run(sessionID, 'positive');
    const recovered = await readState(seeded.sessDir);
    expect(recovered?.reviewAssurance?.obligations[0]?.status).toBe('fulfilled');
    for (const attempt of historicalAttempts)
      expect(recovered?.reviewAssurance?.attempts).toContainEqual(attempt);
    for (const invocation of historicalInvocations)
      expect(recovered?.reviewAssurance?.invocations).toContainEqual(invocation);
    const fresh = recovered?.reviewAssurance?.invocations.at(-1);
    expect(fresh?.capture).toBeDefined();
    expect(
      historicalInvocations.some((invocation) => invocation.invocationId === fresh?.invocationId),
    ).toBe(false);
    expect(probe.calls.some((call) => call.phase === 'serialization')).toBe(true);
  }, 180_000);
});
