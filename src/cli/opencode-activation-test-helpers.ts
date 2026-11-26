/** Explicit component admission around real product hooks. Never installed by
 * FlowGuard and never evidence of operator UI provenance or accepted decisions. */
import type { NativeHostProbe } from './opencode-native-test-helpers.js';
import { canonicalBinding, withTestEnv } from '../integration/test-helpers.js';
import { makeState } from '../fixtures.js';
import { writeState } from '../adapters/persistence.js';
import { sessionDir } from '../adapters/workspace/index.js';

export const COMPONENT_ACTIVATION_SETUP = `
const { Rpc } = await import('@opencode/plugin/rpc');
const { randomUUID } = await import('node:crypto');
const { commitGovernanceActivation, confirmGovernanceActivationAudit } = await import(${JSON.stringify(new URL('../../dist/adapters/governance-activation.js', import.meta.url).href)});
const Fixture = Rpc.define({ id: 'flowguard-component-activation', methods: { seed: {
  input: { type: 'object', properties: { sessionID: { type: 'string' }, policyDigest: { type: 'string' }, worktreeRoot: { type: 'string' } }, required: ['sessionID','policyDigest','worktreeRoot'], additionalProperties: false },
  output: { type: 'boolean' }, errors: {}
} }, events: {} });
const registration = await ctx.rpc.register(Fixture, { seed: async ({ sessionID, policyDigest, worktreeRoot }) => {
  const decisionId = 'component-fixture-' + randomUUID();
  const request = { action: 'start', expectedRevision: 0, sessionId: sessionID, rootSessionId: sessionID,
    activationId: randomUUID(), generation: 1, directory: ctx.location.directory, worktreeRoot,
    policyDigest, parentDispatch: null };
  const writer = { store: ctx.storage, withLock: async (_id, run) => run(), authorize: async () => ({ kind: 'authorized', decisionId, source: 'host_command',
    actor: { actorId: 'component-fixture', actorEmail: null, actorDisplayName: null, actorSource: 'env', actorAssurance: 'best_effort' } }) };
  let activationId;
  for (const input of [request, { ...request, action: 'activate', expectedRevision: 1 }]) {
    const result = await commitGovernanceActivation(writer, input);
    if (result.kind !== 'committed') throw new Error(result.reason);
    activationId = result.record.activationId;
  }
  await confirmGovernanceActivationAudit(ctx.storage, { sessionId: sessionID, activationId });
  return true;
} });
return () => registration.dispose();
`;

export async function seedNativeActiveScope(
  probe: NativeHostProbe,
  sessionID: string,
  phase: Parameters<typeof makeState>[0] = 'TICKET',
): Promise<void> {
  const restore = withTestEnv({
    OPENCODE_CONFIG_DIR: probe.env.OPENCODE_CONFIG_DIR!,
    FLOWGUARD_REQUIRE_TEST_CONFIG_DIR: '1',
  });
  let policyDigest: string;
  let worktreeRoot: string;
  try {
    const binding = await canonicalBinding(probe.project, sessionID);
    const state = makeState(phase, { binding });
    await writeState(sessionDir(binding.fingerprint, sessionID), state);
    policyDigest = state.policySnapshot.hash;
    worktreeRoot = binding.worktree;
  } finally {
    restore();
  }
  await probe.client.rpc.call({
    location: probe.location,
    rpcID: 'flowguard-component-activation',
    method: 'seed',
    input: { sessionID, policyDigest, worktreeRoot },
  });
}
