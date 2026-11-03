/** Real product composition with explicit host-boundary fixtures, not native provenance proof. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FlowGuardAuditPlugin } from './plugin.js';
import { AutonomousStartRequest, AutonomousStartResult } from './opencode-governance-rpc.js';
import { createV2Host, v2ToolEvent } from './opencode-v2-test-helpers.js';
import { createTestWorkspace, withTestEnv, type TestWorkspace } from './test-helpers.js';
import { readConfig, writeRepoConfig } from '../adapters/persistence-config.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import {
  governanceActivationKeys,
  resolveGovernanceActivation,
} from '../adapters/governance-activation.js';
import {
  freezePolicySnapshot,
  createPolicySnapshot,
  resolvePolicyFromSnapshot,
} from '../config/policy-snapshot.js';
import { writeState } from '../adapters/persistence.js';
import * as actors from '../adapters/actor-context.js';
import { FlowGuardConfigSchema } from '../config/flowguard-config.js';
import { hashText } from '../shared/hashing.js';
import { resolveHydratePolicy, hydrate } from './tools/index.js';
import * as audit from '../adapters/persistence-audit.js';
import { verifyChain } from '../audit/integrity.js';

let ws: TestWorkspace;
let host: ReturnType<typeof createV2Host>;
const disposers: Array<() => Promise<void>> = [];
beforeEach(async () => {
  ws = await createTestWorkspace();
  host = createV2Host(ws.tmpDir);
});
afterEach(async () => {
  try {
    for (const dispose of disposers.splice(0).reverse()) await dispose();
  } finally {
    vi.restoreAllMocks();
    await ws.cleanup();
  }
});
async function configure(enabled = true, minimumActorAssurance = 'best_effort') {
  await writeRepoConfig(
    ws.tmpDir,
    FlowGuardConfigSchema.parse({
      schemaVersion: 'v1',
      governance: { autonomousActivation: { enabled, minimumActorAssurance } },
    }),
  );
}
async function open() {
  const cleanup = await FlowGuardAuditPlugin.setup(host.ctx);
  if (!cleanup) throw new Error('Expected plugin cleanup');
  disposers.push(async () => {
    await cleanup();
  });
}
async function request(sessionID = randomUUID()) {
  const before = await resolveSessionAuthority({ root: ws.tmpDir, sessionId: sessionID });
  if (before.status === 'unavailable') throw new Error(before.reason);
  const resolved = await resolveHydratePolicy(null, await readConfig(before.worktreeRoot), {});
  return {
    sessionID,
    worktreeRoot: before.worktreeRoot,
    policyDigest: freezePolicySnapshot(
      resolved.policyResolution,
      new Date().toISOString(),
      hashText,
    ).hash,
  };
}
async function start(input: AutonomousStartRequest) {
  const result = AutonomousStartResult.parse(
    await host.rpcMethods.get('StartGovernance')!(AutonomousStartRequest.parse(input)),
  );
  if (result.kind === 'blocked') throw new Error(`${result.code}: ${result.reason}`);
  return result;
}
async function authority(sessionID: string) {
  return resolveGovernanceActivation(host.activation.store, sessionID);
}
async function workflow(sessionID: string) {
  const value = await resolveSessionAuthority({ root: ws.tmpDir, sessionId: sessionID });
  if (value.status !== 'resolved') throw new Error('Expected workflow');
  return value;
}

describe('explicit autonomous root Start', () => {
  it('defaults to disabled and rejects unknown assurance and caller-supplied authority', () => {
    expect(
      FlowGuardConfigSchema.parse({ schemaVersion: 'v1' }).governance.autonomousActivation,
    ).toEqual({ enabled: false, minimumActorAssurance: 'idp_verified' });
    expect(() =>
      FlowGuardConfigSchema.parse({
        schemaVersion: 'v1',
        governance: { autonomousActivation: { minimumActorAssurance: 'human' } },
      }),
    ).toThrow();
    expect(() =>
      AutonomousStartRequest.parse({
        sessionID: 'root',
        worktreeRoot: '/',
        policyDigest: 'a'.repeat(64),
        actorAssurance: 'idp_verified',
      }),
    ).toThrow();
  });
  it.each(['disabled', 'weak actor', 'child', 'worktree', 'policy', 'location'])(
    'rejects %s before hydrate or activation effects',
    async (failure) => {
      await configure(
        failure !== 'disabled',
        failure === 'weak actor' ? 'idp_verified' : 'best_effort',
      );
      const input = await request();
      if (failure === 'child')
        host.sessionGet.mockResolvedValue({
          id: input.sessionID,
          location: { directory: ws.tmpDir },
          parentID: 'parent',
        });
      if (failure === 'worktree') input.worktreeRoot += '/foreign';
      if (failure === 'policy') input.policyDigest = '0'.repeat(64);
      if (failure === 'location') host.context.location.directory = ws.tmpDir + '/foreign';
      const hydration = vi.spyOn(hydrate, 'execute');
      await open();
      await expect(start(input)).rejects.toThrow('GOVERNANCE_AUTHORITY_BLOCKED');
      expect(hydration).not.toHaveBeenCalled();
      expect(await authority(input.sessionID)).toEqual({ kind: 'inactive', record: null });
      expect(host.activation.values.size).toBe(0);
    },
  );
  it('activates, audits and confirms the canonically resolved autonomous actor exactly once', async () => {
    await configure();
    await open();
    const input = await request();
    const first = await start(input);
    const hydration = vi.spyOn(hydrate, 'execute');
    expect(await start(input)).toEqual({ ...(first as object), kind: 'already_active' });
    expect(hydration).not.toHaveBeenCalled();
    expect(await authority(input.sessionID)).toMatchObject({
      kind: 'active',
      record: {
        decisionSource: 'autonomous',
        policyDigest: input.policyDigest,
        worktreeRoot: input.worktreeRoot,
      },
    });
    const trail = await audit.readAuditTrail((await workflow(input.sessionID)).sessDir);
    expect(trail.filter((event) => event.event === 'governance:activated')).toMatchObject([
      { detail: { channel: 'autonomous' }, actorInfo: { assurance: 'best_effort' } },
    ]);
    expect(verifyChain(trail).valid).toBe(true);
    expect(
      host.activation.values.get(governanceActivationKeys(input.sessionID).audit),
    ).toMatchObject({ activationId: (first as { activationId: string }).activationId });
    await expect(host.before(v2ToolEvent({ sessionID: input.sessionID }))).resolves.toBeUndefined();
  });
  it.each([true, false])(
    'serializes mixed starts, autonomous first: %s',
    async (autonomousFirst) => {
      await configure();
      await open();
      const input = await request();
      const hydration = vi.spyOn(hydrate, 'execute');
      await Promise.all(
        autonomousFirst
          ? [start(input), host.command('start', input.sessionID)]
          : [host.command('start', input.sessionID), start(input)],
      );
      expect(hydration).toHaveBeenCalledOnce();
      expect(
        [...host.activation.values.keys()].filter((key) => key.includes('/revisions/')),
      ).toHaveLength(2);
      expect(
        (await audit.readAuditTrail((await workflow(input.sessionID)).sessDir)).filter(
          (event) => event.event === 'governance:activated',
        ),
      ).toHaveLength(1);
    },
  );
  it('rechecks revoked permission after hydration before any activation commit', async () => {
    await configure();
    await open();
    const input = await request();
    const execute = hydrate.execute.bind(hydrate);
    vi.spyOn(hydrate, 'execute').mockImplementationOnce(async (args, context) => {
      const result = await execute(args, context);
      await configure(false);
      return result;
    });
    await expect(start(input)).rejects.toThrow('Autonomous activation is disabled');
    expect(await authority(input.sessionID)).toEqual({ kind: 'inactive', record: null });
    expect((await workflow(input.sessionID)).state.phase).toBe('READY');
    await expect(host.before(v2ToolEvent({ sessionID: input.sessionID }))).resolves.toBeUndefined();
    expect(host.activation.values.size).toBe(0);
  });
  it('rejects policy drift introduced during hydration before committing activation', async () => {
    await configure();
    await open();
    const input = await request();
    const execute = hydrate.execute.bind(hydrate);
    vi.spyOn(hydrate, 'execute').mockImplementationOnce(async (args, context) => {
      const result = await execute(args, context);
      const bound = await workflow(input.sessionID);
      const policy = resolvePolicyFromSnapshot(bound.state.policySnapshot);
      const snapshot = createPolicySnapshot(
        { ...policy, minimumActorAssuranceForApproval: 'idp_verified' },
        new Date().toISOString(),
        hashText,
      );
      await writeState(bound.sessDir, { ...bound.state, policySnapshot: snapshot });
      return result;
    });
    await expect(start(input)).rejects.toThrow('policy changed during preparation');
    expect(await authority(input.sessionID)).toEqual({ kind: 'inactive', record: null });
  });
  it('uses the same explicit policy-mode resolution as interactive Start', async () => {
    await configure();
    await open();
    const input = await request();
    const resolution = await resolveHydratePolicy(null, await readConfig(input.worktreeRoot), {
      policyMode: 'solo',
    });
    input.policyDigest = freezePolicySnapshot(
      resolution.policyResolution,
      new Date().toISOString(),
      hashText,
    ).hash;
    await start({ ...input, policyMode: 'solo' });
    expect((await workflow(input.sessionID)).state.policySnapshot.mode).toBe('solo');
  });
  it('preserves an ACTIVE decision actor when interactive Start repairs it', async () => {
    await configure();
    await open();
    const input = await request();
    await start(input);
    vi.spyOn(actors, 'resolveActorForPolicy').mockRejectedValue(
      new Error('must not resolve a new actor'),
    );
    await host.command('start', input.sessionID);
    expect(await authority(input.sessionID)).toMatchObject({
      kind: 'active',
      record: { decisionSource: 'autonomous' },
    });
  });
  it.each(['autonomous', 'interactive'])(
    'rejects a foreign pending actor, then preserves the decision on %s repair',
    async (repair) => {
      await configure();
      await open();
      const input = await request();
      const set = host.activation.store.set.bind(host.activation.store);
      const fault = vi
        .spyOn(host.activation.store, 'set')
        .mockImplementation(async (key, value) => {
          await set(key, value);
          if (key.endsWith('/head') && 'revision' in value && value.revision === 1)
            throw new Error('crash after durable ACTIVATING head');
        });
      await expect(start(input)).rejects.toThrow('crash after durable ACTIVATING');
      fault.mockRestore();
      const pending = await authority(input.sessionID);
      expect(pending).toMatchObject({
        kind: 'blocked',
        reason: expect.stringContaining('activating'),
      });
      const restore = withTestEnv({ FLOWGUARD_ACTOR_ID: 'another-automation-actor' });
      try {
        await expect(start(input)).rejects.toThrow('another actor’s pending decision');
      } finally {
        restore();
      }
      if (repair === 'interactive') {
        vi.spyOn(actors, 'resolveActorForPolicy').mockRejectedValue(
          new Error('must not replace the pending actor'),
        );
        await host.command('start', input.sessionID);
      } else await start(input);
      expect(await authority(input.sessionID)).toMatchObject({
        kind: 'active',
        record: { decisionSource: 'autonomous' },
      });
    },
  );
  it('does not treat repeat permission as implicit EndGovernance', async () => {
    await configure();
    await open();
    const input = await request();
    await start(input);
    await configure(false);
    await expect(start(input)).rejects.toThrow('Autonomous activation is disabled');
    expect(await authority(input.sessionID)).toMatchObject({ kind: 'active' });
    await expect(host.before(v2ToolEvent({ sessionID: input.sessionID }))).resolves.toBeUndefined();
  });
  it.each(['audit', 'confirmation'])(
    'blocks runtime admission after %s failure and repairs without another decision',
    async (failure) => {
      await configure();
      await open();
      const input = await request();
      if (failure === 'audit')
        vi.spyOn(audit, 'appendAuditEventAlreadyLocked').mockRejectedValueOnce(
          new Error('audit failure'),
        );
      else {
        const set = host.activation.store.set.bind(host.activation.store);
        vi.spyOn(host.activation.store, 'set').mockImplementation(async (key, value) => {
          if (key.endsWith('/audit-confirmation')) throw new Error('confirmation failure');
          return set(key, value);
        });
      }
      await expect(start(input)).rejects.toThrow('activation audit is unconfirmed');
      expect(await authority(input.sessionID)).toMatchObject({ kind: 'active' });
      await expect(host.before(v2ToolEvent({ sessionID: input.sessionID }))).rejects.toThrow(
        'activation audit is unconfirmed',
      );
      vi.restoreAllMocks();
      await start(input);
      await expect(
        host.before(v2ToolEvent({ sessionID: input.sessionID })),
      ).resolves.toBeUndefined();
      expect(
        [...host.activation.values.keys()].filter((key) => key.includes('/revisions/')),
      ).toHaveLength(2);
    },
  );
  it('never treats an ordinary INACTIVE prompt as an activation request', async () => {
    await configure();
    await open();
    const input = await request();
    await host.sessionHooks.get('prompt')!({
      sessionID: input.sessionID,
      text: 'activate FlowGuard',
    });
    await host.before(v2ToolEvent({ sessionID: input.sessionID }));
    expect(await authority(input.sessionID)).toEqual({ kind: 'inactive', record: null });
    expect(
      (await resolveSessionAuthority({ root: ws.tmpDir, sessionId: input.sessionID })).status,
    ).toBe('absent');
  });
});
