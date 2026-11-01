/** Native host wire mechanics only: admission is not FlowGuard completion/capture proof. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REVIEWER_AGENT } from '../templates/mandates.js';
import { ReviewerFindingsInput } from '../state/evidence-review-input.js';
import { createNativeHostProbe } from './opencode-native-test-helpers.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
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
  attestation: { toolObligationId: '11111111-1111-4111-8111-111111111111' },
};
describe.skipIf(!LIVE)('OpenCode structured reviewer wire contract (live, pinned host)', () => {
  let probe: Awaited<ReturnType<typeof createNativeHostProbe>>;
  beforeAll(async () => {
    probe = await createNativeHostProbe({
      agent: REVIEWER_AGENT,
      script: () => ({ text: JSON.stringify(findings) }),
    });
  }, 180_000);
  afterAll(async () => {
    await probe?.close();
  });
  it('preserves native admission identity and model selection without inventing response parentID', async () => {
    const agent = await probe.client.agent.get({
      location: probe.location,
      agentID: 'flowguard-reviewer',
    });
    expect(agent.data).toMatchObject({ id: 'flowguard-reviewer', mode: 'subagent' });
    const parent = await probe.session();
    const child = await probe.client.session.create({
      location: probe.location,
      parentID: parent.id,
      agent: 'flowguard-reviewer',
      title: 'Bounded host-wire probe',
      model: { providerID: 'capture', id: 'probe', variant: 'chosen' },
    });
    expect(child.parentID).toBe(parent.id);
    const id = 'msg_flowguard_native_wire_request';
    const admitted = await probe.client.session.prompt({
      sessionID: child.id,
      id,
      text: 'Serialize the review as one JSON object.',
    });
    expect(admitted).toMatchObject({ id, sessionID: child.id, type: 'user' });
    expect(admitted).not.toHaveProperty('info');
    await probe.client.session.wait(
      { sessionID: child.id },
      { signal: AbortSignal.timeout(60_000) },
    );
    const history = await probe.client.session.context({ sessionID: child.id });
    expect(history.some((message) => message.type === 'user' && message.id === id)).toBe(true);
    const assistants = history.filter((message) => message.type === 'assistant');
    expect(assistants).toHaveLength(1);
    const assistant = assistants[0]!;
    expect(assistant).toMatchObject({
      finish: 'stop',
      agent: 'flowguard-reviewer',
      model: { providerID: 'capture', id: 'probe', variant: 'chosen' },
    });
    expect(assistant).not.toHaveProperty('parentID');
    const parts = assistant.content.filter((part) => part.type === 'text');
    expect(parts).toHaveLength(1);
    expect(ReviewerFindingsInput.safeParse(JSON.parse(parts[0]!.text)).success).toBe(true);
    const requests = probe.requests.filter((request) => request.sessionID === child.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.model).toBe('probe');
    expect(requests[0]!.body.reasoning_effort).toBe('high');
    expect(requests[0]!.body.tool_choice).not.toBe('required');
    expect(JSON.stringify(requests[0]!.body.tools)).not.toContain('StructuredOutput');
    expect(probe.errors).toEqual([]);
    // This single controlled turn is not an exact request-to-terminal proof
    // under concurrent admission, reuse, restart or late tool activity.
  });
});
