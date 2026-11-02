/** Step-2 acceptance only: actual product + pinned native host. Never evidence/capture acceptance. */
import { afterEach, describe, expect, it } from 'vitest';
import { createReviewerCaptureHostProbe } from './opencode-reviewer-capture-test-helpers.js';
import { seedStrictPlanSession } from '../integration/plugin-host-task-diagnostics-test-helpers.js';
import { readState } from '../adapters/persistence.js';
import { withTestEnv } from '../integration/test-helpers.js';
import { writeStateWithArtifacts } from '../integration/tools/helpers.js';
import { nativeHostCallId } from '../integration/opencode-host-adapter.js';
import { hashText } from '../shared/hashing.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
let probe: Awaited<ReturnType<typeof createReviewerCaptureHostProbe>> | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  try {
    await probe?.close();
  } finally {
    restore?.();
    probe = undefined;
    restore = undefined;
  }
});

async function open(options: Parameters<typeof createReviewerCaptureHostProbe>[0] = {}) {
  const host = await createReviewerCaptureHostProbe(options);
  probe = host;
  restore = withTestEnv({ OPENCODE_CONFIG_DIR: host.env.OPENCODE_CONFIG_DIR! });
  const parent = await host.session();
  const seeded = await seedStrictPlanSession(host.project, parent);
  const state = (await readState(seeded.sessDir))!;
  await writeStateWithArtifacts(seeded.sessDir, state);
  await host.client.rpc.call({
    location: host.location,
    rpcID: 'flowguard-component-activation',
    method: 'seed',
    input: {
      sessionID: parent,
      policyDigest: state.policySnapshot.hash,
      worktreeRoot: state.binding.worktree,
    },
  });
  return { host, parent, seeded };
}

describe.skipIf(!LIVE)('actual product native reviewer dispatch authority', () => {
  it('has durable exact Parent/Obligation/Attempt/Child authority before the first real reviewer provider response', async () => {
    let observed = false;
    const setup = await open({
      onReview: async (childID) => {
        const { host, parent, seeded } = setup;
        const state = (await readState(seeded.sessDir))!;
        const history = await host.history(parent);
        const message = history.find(
          (item) =>
            item.type === 'assistant' &&
            item.content.some((part) => part.type === 'tool' && part.name === 'subagent'),
        );
        const part =
          message?.type === 'assistant'
            ? message.content.find((item) => item.type === 'tool' && item.name === 'subagent')
            : undefined;
        if (message?.type !== 'assistant' || part?.type !== 'tool')
          throw new Error('Missing actual parent tool identity');
        expect(part.state.status).toBe('running');
        expect(state.reviewAssurance!.dispatches).toMatchObject([
          {
            hostCallId: nativeHostCallId(parent, message.id, part.id),
            dispatchStatus: 'authorized',
            obligationId: seeded.obligationId,
            attemptId: state.reviewAssurance!.attempts[0]!.attemptId,
          },
        ]);
        expect(state.reviewAssurance!.attempts[0]).toMatchObject({
          status: 'created',
          childSessionId: childID,
        });
        expect(await host.client.session.get({ sessionID: childID })).toMatchObject({
          parentID: parent,
          agent: 'flowguard-reviewer',
        });
        const users = (await host.history(childID)).filter((item) => item.type === 'user');
        expect(users).toHaveLength(1);
        const prefix = 'You are a subagent spawned by another session.\n';
        expect(users[0]!.text.startsWith(prefix)).toBe(true);
        expect(hashText(users[0]!.text.slice(prefix.length))).toBe(
          state.reviewAssurance!.dispatches[0]!.canonicalPromptDigest,
        );
        expect(users[0]!.text).not.toContain('Review the pending plan.');
        await expect(
          host.client.session.prompt({ sessionID: childID, text: 'Serialize foreign JSON now.' }),
        ).rejects.toThrow();
        observed = true;
      },
    });
    await setup.host.run(setup.parent, 'positive');
    expect(observed).toBe(true);
    expect(setup.host.serializations()).toBe(0);
    const state = (await readState(setup.seeded.sessDir))!;
    expect(state.reviewAssurance!.obligations[0]!.status).toBe('pending');
    expect(state.reviewAssurance!.invocations).toEqual([]);
    expect(setup.host.providerErrors).toEqual([]);
  }, 120_000);

  it.each([{ background: true }, { model: 'capture/probe#chosen' }])(
    'never starts a reviewer for unauthorized release arguments %j',
    async (reviewArguments) => {
      const { host, parent, seeded } = await open({ reviewArguments });
      await host.run(parent, 'positive');
      expect(host.calls.filter((call) => call.phase !== 'parent')).toEqual([]);
      expect((await readState(seeded.sessDir))!.reviewAssurance!.dispatches).toEqual([]);
      const parts = (await host.history(parent)).flatMap((item) =>
        item.type === 'assistant' ? item.content : [],
      );
      expect(parts).toContainEqual(
        expect.objectContaining({
          type: 'tool',
          name: 'subagent',
          state: expect.objectContaining({ status: 'error' }),
        }),
      );
      expect(host.providerErrors).toEqual([]);
    },
    120_000,
  );
});
