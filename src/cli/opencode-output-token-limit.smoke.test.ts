/** Final native provider-wire budgets; no removed V1 env-cap rewrite is certified. */
import { afterEach, describe, expect, it } from 'vitest';
import { REVIEWER_AGENT } from '../templates/mandates.js';
import { createNativeHostProbe } from './opencode-native-test-helpers.js';
import {
  COMPONENT_ACTIVATION_SETUP,
  seedNativeActiveScope,
} from './opencode-activation-test-helpers.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
let probe: Awaited<ReturnType<typeof createNativeHostProbe>> | undefined;
afterEach(async () => {
  await probe?.close();
  probe = undefined;
});
describe.skipIf(!LIVE)('native output budgets reach the provider unchanged', () => {
  it.each([65_536, 32_000])(
    'preserves an explicit native provider-body budget of %i on the final wire',
    async (cap) => {
      probe = await createNativeHostProbe({ body: { max_tokens: cap }, modelOutput: 131_072 });
      const session = await probe.session();
      await probe.prompt(session.id);
      expect(probe.requests).toHaveLength(1);
      expect(probe.requests[0]!.body.max_tokens).toBe(cap);
      expect(probe.errors).toEqual([]);
    },
  );
  it('a fresh FlowGuard plugin leaves the ordinary parent native budget unchanged', async () => {
    const budgets: unknown[] = [];
    for (const product of [false, true]) {
      probe = await createNativeHostProbe({ product });
      const session = await probe.session();
      await probe.prompt(session.id, 'Reply with OK.');
      expect(probe.requests).toHaveLength(1);
      budgets.push(probe.requests[0]!.body.max_tokens);
      await probe.close();
      probe = undefined;
    }
    // This native compatible provider omits max_tokens unless explicitly set.
    // The two explicit-wire controls above prove the capture is not vacuous.
    expect(budgets[0]).toBeUndefined();
    expect(budgets[1]).toBe(budgets[0]);
  });
  it.each([
    {
      output: 131_072,
      config: '{"schemaVersion":"v1","reviewer":{"outputTokenMax":65536}}',
      label: 'non-default retired reviewer cap',
    },
    {
      output: 32_768,
      config: '{"schemaVersion":"v1","reviewer":{"toolTimeoutMs":45000}}',
      label: 'non-default retired watchdog budget',
    },
    { output: 131_072, config: '{"schemaVersion":"invalid"}', label: 'malformed FlowGuard config' },
  ])(
    'blocks a $label before any reviewer request reaches the provider',
    async ({ output, config }) => {
      probe = await createNativeHostProbe({
        product: true,
        productTestSetup: COMPONENT_ACTIVATION_SETUP,
        agent: REVIEWER_AGENT,
        modelOutput: output,
        flowguardConfig: config,
      });
      const session = await probe.session('flowguard-reviewer');
      await seedNativeActiveScope(probe, session.id);
      // ACTIVE runtime creation fails closed with CONFIG_INVALID in the first
      // governed hook (prompt admission), so the host refuses the prompt itself.
      await expect(
        probe.prompt(session.id, 'FLOWGUARD_LARGE_CONTEXT_MARKER'),
        probe.output(),
      ).rejects.toThrow();
      expect(probe.requests).toEqual([]);
    },
  );
  it('control: an earlier-installer config admits the same prompt and blocks only the unauthorized reviewer', async () => {
    probe = await createNativeHostProbe({
      product: true,
      productTestSetup: COMPONENT_ACTIVATION_SETUP,
      agent: REVIEWER_AGENT,
      modelOutput: 131_072,
      flowguardConfig:
        '{"schemaVersion":"v1","reviewer":{"outputTokenMax":"host","toolTimeoutMs":30000,"reviewTimeoutMs":480000,"serializationTimeoutMs":60000,"executionTimeoutMs":600000}}',
    });
    const session = await probe.session('flowguard-reviewer');
    await seedNativeActiveScope(probe, session.id);
    await probe.prompt(session.id, 'FLOWGUARD_LARGE_CONTEXT_MARKER');
    expect(probe.requests).toEqual([]);
    const history = await probe.client.session.context({ sessionID: session.id });
    const terminal = history.find(
      (message) => message.type === 'idle' && message.outcome === 'failed',
    );
    expect(terminal, JSON.stringify(history)).toBeDefined();
    expect(JSON.stringify(terminal)).not.toContain('CONFIG_INVALID');
  });
});
