/** Native mechanics, NOT FlowGuard reviewer acceptance or a transport proof
 * format. Product reviewer gates and all four required positives stay intact. */
import { randomUUID } from 'node:crypto';
import type { SessionMessageInfo } from '@opencode/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReviewerTransportProbe } from './opencode-reviewer-transport-test-helpers.js';
import { nativeHostCallId } from '../integration/opencode-host-adapter.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
let probe: Awaited<ReturnType<typeof createReviewerTransportProbe>> | undefined;
afterEach(async () => {
  await probe?.close();
  probe = undefined;
});

function nativeTask(history: readonly SessionMessageInfo[]) {
  const message = history.find(
    (entry) =>
      entry.type === 'assistant' &&
      entry.content.some((part) => part.type === 'tool' && part.name === 'subagent'),
  );
  const part =
    message?.type === 'assistant'
      ? message.content.find((entry) => entry.type === 'tool' && entry.name === 'subagent')
      : undefined;
  if (message?.type !== 'assistant' || part?.type !== 'tool')
    throw new Error('Missing native task');
  return { message, part };
}

async function nativeReview(mode: 'positive' | 'tool' = 'positive') {
  const host = await createReviewerTransportProbe(mode);
  probe = host;
  const parent = await host.start();
  let settled = false;
  const running = host.prompt(parent.id).finally(() => {
    settled = true;
  });
  try {
    await vi.waitFor(
      () => expect(host.requests.some((request) => request.sessionID !== parent.id)).toBe(true),
      { timeout: 30_000 },
    );
    const childID = host.requests.find((request) => request.sessionID !== parent.id)!.sessionID;
    expect(await host.client.session.get({ sessionID: childID })).toMatchObject({
      parentID: parent.id,
      agent: 'flowguard-reviewer',
      model: { providerID: 'capture', id: 'probe', variant: 'chosen' },
    });
    // The held provider response is an actual in-flight child; the foreground
    // native task and parent have not completed merely because progress exists.
    expect(settled).toBe(false);
    const pending = nativeTask(await host.client.session.context({ sessionID: parent.id }));
    expect(pending.part.state.status).toBe('running');
    const before = await host.client.session.context({ sessionID: childID });
    expect(before.filter((message) => message.type === 'user')).toEqual([
      expect.objectContaining({
        text: `You are a subagent spawned by another session.\n${host.reviewText}`,
      }),
    ]);
    host.releaseReview();
    await running;
    const task = nativeTask(await host.client.session.context({ sessionID: parent.id }));
    expect(task.message.id).toBe(pending.message.id);
    expect(task.part.id).toBe(pending.part.id);
    expect(task.part.state).toMatchObject({
      status: 'completed',
      metadata: { sessionID: childID, status: 'completed' },
    });
    const baseline = await host.client.session.context({ sessionID: childID });
    expect(baseline.at(-1)).toMatchObject({ type: 'idle', outcome: 'succeeded' });
    const review = baseline.filter((message) => message.type === 'assistant');
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ finish: 'stop', time: { completed: expect.any(Number) } });
    expect(review[0]).not.toHaveProperty('parentID');
    const identity = nativeHostCallId(parent.id, task.message.id, task.part.id);
    await vi.waitFor(async () => {
      expect(
        (await host.observations()).some((entry) => {
          const event = entry.event;
          return (
            event?.type === 'session.tool.progress' &&
            nativeHostCallId(event.data.sessionID, event.data.assistantMessageID, event.data.id) ===
              identity &&
            event.data.metadata.sessionID === childID
          );
        }),
      ).toBe(true);
    });
    expect(
      (await host.client.plugin.list({ location: host.location })).data.some(
        (plugin) => plugin.id === 'flowguard',
      ),
    ).toBe(false);
    return { host, parentID: parent.id, childID, baseline };
  } finally {
    host.releaseReview();
    await running;
  }
}

async function admitCapture(
  host: Awaited<ReturnType<typeof createReviewerTransportProbe>>,
  childID: string,
) {
  const requestID = `msg_${randomUUID().replaceAll('-', '')}`;
  const admitted = await host.client.session.prompt({
    sessionID: childID,
    id: requestID,
    text: host.captureText,
  });
  expect(admitted).toMatchObject({ id: requestID, sessionID: childID, type: 'user' });
  await vi.waitFor(() => expect(host.captureRequests()).toBe(1), { timeout: 30_000 });
  return requestID;
}

describe.skipIf(!LIVE)('pinned native foreground reviewer-to-same-child mechanism', () => {
  it('observes foreground completion, exact same-child admission and one normal terminal capture window', async () => {
    const { host, childID, baseline } = await nativeReview();
    const requestID = await admitCapture(host, childID);
    const admittedHistory = await host.client.session.context({ sessionID: childID });
    expect(
      admittedHistory.some(
        (message) =>
          message.type === 'user' && message.id === requestID && message.text === host.captureText,
      ),
    ).toBe(true);
    const inFlight = admittedHistory
      .slice(baseline.length)
      .filter((message) => message.type === 'assistant');
    expect(inFlight.every((message) => message.time.completed === undefined)).toBe(true);
    host.releaseCapture();
    await host.client.session.wait({ sessionID: childID }, { signal: AbortSignal.timeout(30_000) });
    const history = await host.client.session.context({ sessionID: childID });
    expect(history.slice(0, baseline.length)).toEqual(baseline);
    const window = history.slice(baseline.length);
    expect(window.map((message) => message.type)).toEqual(['user', 'assistant', 'idle']);
    expect(window[0]).toMatchObject({ id: requestID, text: host.captureText });
    const response = window[1];
    expect(response).toMatchObject({
      type: 'assistant',
      agent: 'flowguard-reviewer',
      model: { providerID: 'capture', id: 'probe', variant: 'chosen' },
      finish: 'stop',
      time: { completed: expect.any(Number) },
      content: [{ type: 'text', text: host.payload }],
    });
    expect(response).not.toHaveProperty('parentID');
    expect(window[2]).toMatchObject({ outcome: 'succeeded' });
    const observations = (await host.observations()).filter(
      (entry) => entry.input?.sessionID === childID && entry.input.capture,
    );
    expect(observations.filter((entry) => entry.hook === 'prompt')).toMatchObject([
      { input: { messageID: requestID, text: host.captureText } },
    ]);
    expect(observations.filter((entry) => entry.hook === 'context')).toHaveLength(1);
    const modelRequests = observations.filter((entry) => entry.hook === 'model.request');
    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0]).toMatchObject({
      input: { kind: 'primary', model: { providerID: 'capture', id: 'probe', variant: 'chosen' } },
    });
    expect(modelRequests[0]!.input!.keys).not.toContain('messageID');
    const wire = host.requests.filter((request) => request.sessionID === childID).at(-1)!.body;
    expect(wire.model).toBe('probe');
    expect(wire.reasoning_effort).toBe('high');
    expect(wire.tools).toBeUndefined();
    expect(wire.tool_choice).not.toBe('required');
    expect(JSON.stringify(wire)).not.toContain('StructuredOutput');
    expect(host.errors).toEqual([]);
  }, 120_000);

  it('exposes interleaved foreign admission instead of correlating the latest answer to the capture request', async () => {
    const { host, childID, baseline } = await nativeReview();
    const requestID = await admitCapture(host, childID);
    const foreignID = `msg_${randomUUID().replaceAll('-', '')}`;
    await host.client.session.prompt({
      sessionID: childID,
      id: foreignID,
      text: 'Foreign concurrent input.',
      delivery: 'queue',
    });
    host.releaseCapture();
    await host.client.session.wait({ sessionID: childID }, { signal: AbortSignal.timeout(30_000) });
    const history = await host.client.session.context({ sessionID: childID });
    expect(history.slice(0, baseline.length)).toEqual(baseline);
    const users = history.slice(baseline.length).filter((message) => message.type === 'user');
    expect(users.map((message) => message.id)).toEqual([requestID, foreignID]);
    expect(host.captureRequests()).toBeGreaterThan(1);
    expect(
      history.slice(baseline.length).filter((message) => message.type === 'assistant'),
    ).toHaveLength(2);
    expect(host.errors).toEqual([]);
  }, 120_000);

  it('observes a real unoffered read attempt at the before-hook and prevents its result from reaching the provider', async () => {
    const { host, childID, baseline } = await nativeReview('tool');
    await admitCapture(host, childID);
    host.releaseCapture();
    await host.client.session.wait({ sessionID: childID }, { signal: AbortSignal.timeout(30_000) });
    const attempted = (await host.observations()).filter(
      (entry) =>
        entry.hook === 'tool.before' && entry.input?.sessionID === childID && entry.input.capture,
    );
    expect(attempted).toMatchObject([{ input: { tool: 'read' } }]);
    const history = await host.client.session.context({ sessionID: childID });
    const parts = history
      .slice(baseline.length)
      .flatMap((message) => (message.type === 'assistant' ? message.content : []));
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        name: 'read',
        state: expect.objectContaining({
          status: 'error',
          error: expect.objectContaining({
            message: expect.stringContaining('Fixture capture tool attempt'),
          }),
        }),
      }),
    );
    expect(host.captureRequests()).toBe(2);
    expect(JSON.stringify(host.requests)).not.toContain(host.sentinel);
    expect(parts).toContainEqual(expect.objectContaining({ type: 'text', text: host.payload }));
    // Later valid-looking JSON cannot erase the actual attempt or extra step.
    expect(
      history.slice(baseline.length).filter((message) => message.type === 'assistant'),
    ).toHaveLength(2);
    expect(host.errors).toEqual([]);
  }, 120_000);

  it('records interruption of the exact admitted capture as non-success without declaring recovery quiescence', async () => {
    const { host, childID, baseline } = await nativeReview();
    const requestID = await admitCapture(host, childID);
    expect(
      await host.client.session.interrupt({ sessionID: childID, resume: false }),
    ).toMatchObject({ interrupted: true });
    await host.client.session.wait({ sessionID: childID }, { signal: AbortSignal.timeout(30_000) });
    const history = await host.client.session.context({ sessionID: childID });
    expect(history.slice(0, baseline.length)).toEqual(baseline);
    const window = history.slice(baseline.length);
    expect(window[0]).toMatchObject({ type: 'user', id: requestID });
    expect(window.at(-1)).toMatchObject({ type: 'idle', outcome: 'interrupted' });
    // Depending on host scheduling, an interrupted request may persist an
    // explicit aborted assistant row or no assistant row at all. Neither is a
    // successful completion; a normal stop/complete row is always invalid here.
    for (const message of window) {
      if (message.type !== 'assistant' || message.error === undefined) continue;
      expect(message.error.type).toBe('aborted');
    }
    expect(
      window.some(
        (message) =>
          message.type === 'assistant' && message.finish === 'stop' && message.error === undefined,
      ),
    ).toBe(false);
    expect(host.errors).toEqual([]);
  }, 120_000);

  it('exposes manual compaction admitted during capture instead of claiming an uninterrupted history window', async () => {
    const { host, childID } = await nativeReview();
    await admitCapture(host, childID);
    const compacted = await host.client.session.compact({ sessionID: childID, delivery: 'queue' });
    expect(compacted).toMatchObject({ sessionID: childID, type: 'compaction' });
    host.releaseCapture();
    await host.client.session.wait({ sessionID: childID }, { signal: AbortSignal.timeout(30_000) });
    const history = await host.client.session.context({ sessionID: childID });
    expect(history).toContainEqual(
      expect.objectContaining({ type: 'compaction', status: 'completed' }),
    );
    const requests = (await host.observations()).filter(
      (entry) =>
        entry.hook === 'model.request' && entry.input?.sessionID === childID && entry.input.capture,
    );
    expect(requests.some((entry) => entry.input?.kind === 'compaction')).toBe(true);
    // context() is the latest projection. This control exposes a checkpoint;
    // it does not assume that absence there proves absence from older history.
    expect(host.errors).toEqual([]);
  }, 120_000);
});
