/** R4 native boundary research/counterexamples, NOT reviewer-assurance acceptance.
 * Post-product test hooks are deliberately privileged; no unprivileged exploit
 * or all-provider byte-attestation is claimed. Four required contracts unchanged. */
import { afterEach, describe, expect, it } from 'vitest';
import { readState } from '../adapters/persistence.js';
import { seedStrictPlanSession } from '../integration/plugin-host-task-diagnostics-test-helpers.js';
import { withTestEnv } from '../integration/test-helpers.js';
import { writeStateWithArtifacts } from '../integration/tools/helpers.js';
import {
  createToolResultProbe,
  RESULT_SENTINEL,
  LONG_RESULT_END,
  type ResultProbeMode,
} from './opencode-reviewer-tool-result-test-helpers.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
let probe: Awaited<ReturnType<typeof createToolResultProbe>> | undefined;
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

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function toolWire(body: Record<string, unknown>) {
  return (Array.isArray(body.messages) ? body.messages : [])
    .map(record)
    .filter((message) => message.role === 'tool');
}
function modelResult(messages: unknown, id: string): Record<string, unknown> | undefined {
  if (!Array.isArray(messages)) return undefined;
  return messages
    .map(record)
    .flatMap((message) => (Array.isArray(message.content) ? message.content.map(record) : []))
    .find((part) => part.type === 'tool-result' && part.id === id);
}
function text(content: unknown): string {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .map(record)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}
async function run(mode: ResultProbeMode) {
  const result = await runSeededReview(mode);
  if (!probe) throw new Error('Native result probe was not initialized');
  const invocation = result.reviewAssurance!.invocations[0];
  expect(invocation, JSON.stringify(result.reviewAssurance)).toBeDefined();
  if (!invocation) throw new Error('The boundary counterprobe did not reach evidence binding');
  const observations = (await probe.resultObservations()).filter(
    (entry) => entry.sessionID === invocation.childSessionId,
  );
  const after = observations.find((entry) => entry.hook === 'r4.after.released');
  const success = observations.find(
    (entry) =>
      entry.hook === 'r4.success' && entry.id === after?.id && entry.messageID === after?.messageID,
  );
  expect(after).toBeDefined();
  expect(success).toBeDefined();
  const original = observations.find(
    (entry) =>
      entry.hook === 'r4.after.original' &&
      entry.id === after!.id &&
      entry.messageID === after!.messageID,
  );
  expect(text(original!.result!.content)).toContain(probe.sentinel);
  expect(
    observations.filter(
      (entry) =>
        entry.hook === 'r4.success' &&
        entry.id === after!.id &&
        entry.messageID === after!.messageID,
    ),
  ).toHaveLength(1);
  const history = await probe.history(invocation.childSessionId);
  const owner = history.find(
    (message) => message.type === 'assistant' && message.id === after!.messageID,
  );
  const tool =
    owner?.type === 'assistant'
      ? owner.content.find((part) => part.type === 'tool' && part.id === after!.id)
      : undefined;
  if (tool?.type !== 'tool' || tool.state.status !== 'completed')
    throw new Error('Missing exact completed native read');
  const request = probe.calls.filter((call) => call.phase === 'review')[1];
  if (!request) throw new Error('Missing actual second reviewer provider request');
  const wire = toolWire(request.body).find((message) => message.tool_call_id === tool.id);
  expect(wire).toBeDefined();
  expect(success).toMatchObject({ id: tool.id, messageID: owner!.id });
  expect(success!.data!.content).toEqual(tool.state.content);
  const contextOriginal = observations.find(
    (entry) => entry.hook === 'r4.context.original' && modelResult(entry.messages, tool.id),
  );
  const contextReleased = observations.find(
    (entry) => entry.hook === 'r4.context.released' && modelResult(entry.messages, tool.id),
  );
  expect(contextOriginal).toBeDefined();
  expect(contextReleased).toBeDefined();
  const first = tool.state.content[0];
  const expectedResult =
    tool.state.content.length === 1 && first?.type === 'text'
      ? { type: 'text', value: first.text }
      : { type: 'content', value: tool.state.content };
  expect(modelResult(contextOriginal!.messages, tool.id)).toMatchObject({
    id: tool.id,
    name: 'read',
    result: expectedResult,
  });
  const http = observations.find(
    (entry) =>
      entry.hook === 'r4.http' &&
      toolWire(record(entry.data?.body)).some((message) => message.tool_call_id === tool.id),
  );
  expect(http).toBeDefined();
  expect(
    toolWire(record(http!.data!.body)).find((message) => message.tool_call_id === tool.id),
  ).toEqual(wire);
  expect(result.reviewAssurance!.obligations[0]!.status).toBe('fulfilled');
  return {
    result,
    observations,
    after: after!,
    success: success!,
    content: tool.state.content,
    tool,
    wire: wire!,
    request,
    contextReleased: contextReleased!,
  };
}

/** Same real product flow for positives, rejection tests and explicit residual probes. */
async function runSeededReview(mode: ResultProbeMode) {
  probe = await createToolResultProbe(mode);
  restore = withTestEnv({ OPENCODE_CONFIG_DIR: probe.env.OPENCODE_CONFIG_DIR! });
  const sessionID = await probe.session();
  const seeded = await seedStrictPlanSession(probe.project, sessionID);
  const state = (await readState(seeded.sessDir))!;
  await writeStateWithArtifacts(seeded.sessDir, state);
  await probe.client.rpc.call({
    location: probe.location,
    rpcID: 'flowguard-component-activation',
    method: 'seed',
    input: {
      sessionID,
      policyDigest: state.policySnapshot.hash,
      worktreeRoot: state.binding.worktree,
    },
  });
  await probe.run(sessionID, 'positive');
  // The probe really reached the replacement point; the refusal is not vacuous.
  expect(
    (await probe.resultObservations()).some((entry) => entry.hook === 'r4.after.original'),
  ).toBe(true);
  return (await readState(seeded.sessDir))!;
}
describe.skipIf(!LIVE)('R4 native result-boundary integrity', () => {
  it('correlates the actual read after-hook, normalized success event, history and provider result', async () => {
    const h = await run('observe');
    expect(Array.isArray(h.after.result!.content)).toBe(true);
    expect(Array.isArray(h.content)).toBe(true);
    expect(h.content).toEqual(h.after.result!.content);
    expect(h.wire.content).toBe(text(h.content));
    expect(modelResult(h.contextReleased.messages, h.tool.id)).toMatchObject({
      result: { type: 'text', value: text(h.content) },
    });
    expect(h.observations.some((entry) => entry.hook === 'r4.http')).toBe(true);
    expect(probe!.providerErrors).toEqual([]);
  }, 120_000);

  it.each([
    ['after-mutation', RESULT_SENTINEL],
    ['truncate', LONG_RESULT_END],
    ['context-mutation', RESULT_SENTINEL],
  ] as const)(
    'rejects a privileged later %s replacement before it reaches the model or binds evidence',
    async (mode, marker) => {
      const result = await runSeededReview(mode);
      expect(result.reviewAssurance!.invocations).toEqual([]);
      expect(result.reviewAssurance!.obligations[0]!.status).not.toBe('fulfilled');
      const reviewBodies = probe!.calls
        .filter((call) => call.phase !== 'parent')
        .map((call) => JSON.stringify(call.body));
      expect(reviewBodies.length).toBeGreaterThan(0);
      for (const body of reviewBodies) expect(body).not.toContain(marker);
      expect(probe!.serializations()).toBe(0);
    },
    120_000,
  );

  it.each([
    ['dynamic-context-mutation', 'r4.dynamic.replaced'],
    ['http-mutation', 'r4.http.replaced'],
  ] as const)(
    'documents the still-open privileged %s counterexample, not an assurance PASS',
    async (mode, hook) => {
      const result = await runSeededReview(mode);
      const invocation = result.reviewAssurance!.invocations[0];
      expect(invocation).toBeDefined();
      expect(result.reviewAssurance!.obligations[0]!.status).toBe('fulfilled');
      expect((await probe!.resultObservations()).some((entry) => entry.hook === hook)).toBe(true);
      const reviewBodies = probe!.calls.filter((call) => call.phase === 'review');
      expect(reviewBodies.some((call) => JSON.stringify(call.body).includes(RESULT_SENTINEL))).toBe(
        true,
      );
      expect(JSON.stringify(await probe!.history(invocation!.childSessionId))).not.toContain(
        RESULT_SENTINEL,
      );
      expect(probe!.serializations()).toBe(1);
      expect(probe!.providerErrors).toEqual([]);
    },
    120_000,
  );
});
