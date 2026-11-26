/** Actual pinned host + product hooks; component activation is not StartGovernance proof. */
import { afterEach, describe, expect, it } from 'vitest';
import { createReviewerCaptureHostProbe } from './opencode-reviewer-capture-test-helpers.js';
import { seedStrictPlanSession } from '../integration/plugin-host-task-diagnostics-test-helpers.js';
import { readState } from '../adapters/persistence.js';
import { withTestEnv } from '../integration/test-helpers.js';
import { writeStateWithArtifacts } from '../integration/tools/helpers.js';

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

describe.skipIf(!LIVE)('native initial-review sequence provenance', () => {
  it('rejects real synthetic input during the initial review without serializing or binding evidence', async () => {
    let injectedChild: string | undefined;
    probe = await createReviewerCaptureHostProbe({
      onReview: async (child) => {
        if (injectedChild !== undefined) return;
        injectedChild = child;
        await probe!.client.session.synthetic({
          sessionID: child,
          text: 'FOREIGN_INITIAL_REVIEW_INPUT',
          delivery: 'steer',
        });
      },
    });
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
    expect(injectedChild).toBeDefined();
    expect(probe.serializations()).toBe(0);
    const result = (await readState(seeded.sessDir))!;
    expect(result.reviewAssurance!.invocations).toEqual([]);
    expect(result.reviewAssurance!.obligations[0]!.status).not.toBe('fulfilled');
    const history = await probe.history(injectedChild!);
    expect(history).toContainEqual(
      expect.objectContaining({ type: 'synthetic', text: 'FOREIGN_INITIAL_REVIEW_INPUT' }),
    );
    expect(probe.calls.filter((call) => call.phase === 'review')).toHaveLength(1);
  }, 120_000);

  it('binds multiple real model steps and a permitted read before exclusive JSON serialization', async () => {
    probe = await createReviewerCaptureHostProbe({ initialRead: true });
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
    const result = (await readState(seeded.sessDir))!;
    expect(result.reviewAssurance!.obligations[0]!.status).toBe('fulfilled');
    expect(result.reviewAssurance!.invocations).toHaveLength(1);
    expect(probe.calls.filter((call) => call.phase === 'review')).toHaveLength(2);
    expect(probe.serializations()).toBe(1);
    const invocation = result.reviewAssurance!.invocations[0]!;
    const history = await probe.history(invocation.childSessionId);
    const assistants = history.filter((message) => message.type === 'assistant');
    expect(assistants).toHaveLength(3);
    expect(assistants[0]).toMatchObject({
      finish: 'tool-calls',
      content: [
        expect.objectContaining({
          type: 'tool',
          name: 'read',
          state: expect.objectContaining({ status: 'completed' }),
        }),
      ],
    });
    expect(assistants[1]).toMatchObject({ finish: 'stop' });
    expect(assistants[2]).toMatchObject({
      finish: 'stop',
      id: invocation.capture.responseMessageId,
    });
    expect(probe.providerErrors).toEqual([]);
  }, 120_000);
});
