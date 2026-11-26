/** Actual pinned-host RPC, policy/actor checks, activation/audit and reload. No activation fixture. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, realpath, writeFile, rmdir, rename, access } from 'node:fs/promises';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { createNativeHostProbe, type NativeHostProbe } from './opencode-native-test-helpers.js';
import { withTestEnv } from '../integration/test-helpers.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import { readConfig } from '../adapters/persistence-config.js';
import { resolveHydratePolicy } from '../integration/tools/index.js';
import { freezePolicySnapshot } from '../config/policy-snapshot.js';
import { hashText } from '../shared/hashing.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import { verifyChain } from '../audit/integrity.js';
import {
  AutonomousStartResult,
  type AutonomousStartRequest,
} from '../integration/opencode-governance-rpc.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
let probe: NativeHostProbe | undefined;
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
async function open(
  enabled = true,
  minimumActorAssurance = 'best_effort',
  productTestSetup?: string,
) {
  probe = await createNativeHostProbe({
    product: true,
    flowguardConfig: JSON.stringify({
      schemaVersion: 'v1',
      governance: { autonomousActivation: { enabled, minimumActorAssurance } },
    }),
    ...(productTestSetup === undefined ? {} : { productTestSetup }),
    script: () => ({ text: 'Done.' }),
  });
  restore = withTestEnv({ OPENCODE_CONFIG_DIR: probe.env.OPENCODE_CONFIG_DIR! });
  await probe.client.command.list({ location: probe.location });
  return probe;
}
async function request(p: NativeHostProbe, sessionID: string): Promise<AutonomousStartRequest> {
  const worktreeRoot = await realpath(p.project);
  const resolution = await resolveHydratePolicy(null, await readConfig(worktreeRoot), {});
  return {
    sessionID,
    worktreeRoot,
    policyDigest: freezePolicySnapshot(
      resolution.policyResolution,
      new Date().toISOString(),
      hashText,
    ).hash,
  };
}
async function start(p: NativeHostProbe, input: AutonomousStartRequest) {
  const result = await p.client.rpc.call({
    location: p.location,
    rpcID: 'flowguard-governance',
    method: 'StartGovernance',
    input: {
      sessionID: input.sessionID,
      worktreeRoot: input.worktreeRoot,
      policyDigest: input.policyDigest,
      ...(input.policyMode === undefined ? {} : { policyMode: input.policyMode }),
    },
  });
  const output = AutonomousStartResult.parse(result.output);
  if (output.kind === 'blocked') throw new Error(`${output.code}: ${output.reason}`);
  return output;
}
async function workflow(p: NativeHostProbe, sessionID: string) {
  const value = await resolveSessionAuthority({
    root: await realpath(p.project),
    sessionId: sessionID,
  });
  if (value.status !== 'resolved')
    throw new Error(`Expected workflow: ${JSON.stringify(value)} ${p.output()}`);
  return value;
}
function productiveTools(p: NativeHostProbe) {
  const tools = (p.requests.at(-1)?.body.tools ?? []) as Array<{ function?: { name: string } }>;
  return tools
    .map((tool) => tool.function?.name ?? '')
    .filter((name) => name.startsWith('flowguard_') && name !== 'flowguard_help');
}

describe.skipIf(!LIVE)('native autonomous StartGovernance RPC', () => {
  it('verifies a real signed IdP token at the default minimum instead of accepting request assurance', async () => {
    const keys = await generateKeyPair('ES256');
    const token = await new SignJWT({ email: 'automation@example.test', name: 'Automation' })
      .setProtectedHeader({ alg: 'ES256', kid: 'activation-test' })
      .setSubject('activation-service')
      .setIssuer('https://activation.example.test')
      .setAudience('flowguard')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey);
    probe = await createNativeHostProbe({
      product: true,
      flowguardConfig: JSON.stringify({
        schemaVersion: 'v1',
        governance: { autonomousActivation: { enabled: true } },
        policy: {
          identityProviderMode: 'required',
          identityProvider: {
            mode: 'static',
            issuer: 'https://activation.example.test',
            audience: 'flowguard',
            signingKeys: [
              {
                kind: 'pem',
                kid: 'activation-test',
                alg: 'ES256',
                pem: await exportSPKI(keys.publicKey),
              },
            ],
          },
        },
      }),
      prepare: async (project, env) => {
        env.FLOWGUARD_ACTOR_TOKEN_PATH = project + '/actor.jwt';
        await writeFile(env.FLOWGUARD_ACTOR_TOKEN_PATH, token);
      },
    });
    const p = probe;
    restore = withTestEnv({ OPENCODE_CONFIG_DIR: p.env.OPENCODE_CONFIG_DIR! });
    await p.client.command.list({ location: p.location });
    const root = await p.session();
    const input = await request(p, root.id);
    expect(await start(p, input)).toMatchObject({ kind: 'activated' });
    const trail = await readAuditTrail((await workflow(p, root.id)).sessDir);
    expect(trail.find((event) => event.event === 'governance:activated')).toMatchObject({
      actorInfo: { id: 'activation-service', source: 'oidc', assurance: 'idp_verified' },
      detail: { channel: 'autonomous' },
    });
    expect(p.requests).toEqual([]);
  }, 300_000);

  it('resumes a SIGKILL-interrupted ACTIVATING decision without rehydration or a new identity', async () => {
    const p = await open(
      true,
      'best_effort',
      `
      const original = ctx.storage.set.bind(ctx.storage);
      ctx.storage.set = async (key, value) => {
        await original(key, value);
        if (key.endsWith('/head') && value.revision === 1) {
          const { writeFile } = await import('node:fs/promises');
          const pending = await ctx.storage.get(key.replace(/head$/, 'revisions/0000000000000001'));
          await writeFile(ctx.location.directory + '/activating-barrier', JSON.stringify(pending));
          await new Promise(() => {});
        }
      };
    `,
    );
    const root = await p.session();
    const input = await request(p, root.id);
    const interrupted = start(p, input).then(
      () => ({ unexpectedlyCompleted: true }),
      () => ({ interrupted: true }),
    );
    await vi.waitFor(
      async () =>
        expect(JSON.parse(await readFile(p.project + '/activating-barrier', 'utf8'))).toMatchObject(
          { status: 'activating', decisionSource: 'autonomous' },
        ),
      { timeout: 120_000 },
    );
    const before = await workflow(p, root.id);
    const pending = JSON.parse(await readFile(p.project + '/activating-barrier', 'utf8')) as {
      activationId: string;
      decisionId: string;
    };
    await p.restart('SIGKILL');
    expect(await interrupted).toEqual({ interrupted: true });
    await p.client.command.list({ location: p.location });
    expect(await start(p, input)).toMatchObject({
      kind: 'activated',
      activationId: pending.activationId,
    });
    expect((await workflow(p, root.id)).state).toEqual(before.state);
    const events = (await readAuditTrail(before.sessDir)).filter(
      (event) => event.event === 'governance:activated',
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({
      channel: 'autonomous',
      generation: 1,
      revision: 2,
      activationId: pending.activationId,
      decisionId: pending.decisionId,
    });
    expect(await start(p, input)).toMatchObject({ kind: 'already_active' });
  }, 300_000);

  it('activates without a prompt, repeats idempotently, survives SIGKILL and leaves INACTIVE siblings ordinary', async () => {
    const p = await open();
    const root = await p.session();
    const input = await request(p, root.id);
    const first = await start(p, input);
    expect(first).toMatchObject({ kind: 'activated', activationId: expect.any(String) });
    expect(p.requests).toEqual([]);
    const bound = await workflow(p, root.id);
    const events = (await readAuditTrail(bound.sessDir)).filter(
      (event) => event.event === 'governance:activated',
    );
    expect(events).toMatchObject([
      {
        detail: { channel: 'autonomous', policyDigest: input.policyDigest },
        actorInfo: { assurance: 'best_effort' },
      },
    ]);
    expect(await start(p, input)).toEqual({ ...(first as object), kind: 'already_active' });
    await p.prompt(root.id, 'After explicit autonomous activation.');
    expect(productiveTools(p)).toContain('flowguard_ticket');
    await p.restart('SIGKILL');
    await p.client.command.list({ location: p.location });
    expect(await start(p, input)).toEqual({ ...(first as object), kind: 'already_active' });
    expect((await workflow(p, root.id)).state).toEqual(bound.state);
    expect(
      (await readAuditTrail(bound.sessDir)).filter(
        (event) => event.event === 'governance:activated',
      ),
    ).toEqual(events);
    expect(verifyChain(await readAuditTrail(bound.sessDir)).valid).toBe(true);
    const sibling = await p.session();
    await p.prompt(sibling.id, 'Activate FlowGuard, please. This is ordinary prompt text.');
    expect(productiveTools(p)).toEqual([]);
    expect(
      (await resolveSessionAuthority({ root: input.worktreeRoot, sessionId: sibling.id })).status,
    ).toBe('absent');
    expect(p.errors).toEqual([]);
  }, 300_000);

  it.each(['disabled', 'weak actor', 'worktree', 'policy', 'child'])(
    'rejects %s without creating workflow state',
    async (failure) => {
      const p = await open(
        failure !== 'disabled',
        failure === 'weak actor' ? 'idp_verified' : 'best_effort',
      );
      const root = await p.session();
      const input = await request(p, root.id);
      if (failure === 'child') {
        const child = await p.client.session.create({ location: p.location, parentID: root.id });
        expect((await p.client.session.get({ sessionID: child.id })).parentID).toBe(root.id);
        input.sessionID = child.id;
      }
      if (failure === 'worktree') input.worktreeRoot += '/foreign';
      if (failure === 'policy') input.policyDigest = '0'.repeat(64);
      await expect(start(p, input)).rejects.toThrow('GOVERNANCE_AUTHORITY_BLOCKED');
      expect(
        (
          await resolveSessionAuthority({
            root: await realpath(p.project),
            sessionId: input.sessionID,
          })
        ).status,
      ).toBe('absent');
      expect(p.requests).toEqual([]);
      await p.prompt(root.id, 'Ordinary inactive session.');
      expect(productiveTools(p)).toEqual([]);
    },
    300_000,
  );

  it('serializes a native autonomous request with interactive /start', async () => {
    const p = await open();
    const root = await p.session();
    const input = await request(p, root.id);
    await Promise.all([
      start(p, input),
      p.client.session.command({ sessionID: root.id, name: 'start', text: '' }),
    ]);
    await p.client.session.wait({ sessionID: root.id }, { signal: AbortSignal.timeout(120_000) });
    const bound = await workflow(p, root.id);
    expect(
      (await readAuditTrail(bound.sessDir)).filter(
        (event) => event.event === 'governance:activated',
      ),
    ).toHaveLength(1);
    expect(await start(p, input)).toMatchObject({ kind: 'already_active' });
  }, 300_000);

  it('blocks ACTIVE admission on a real unreadable audit path and repairs without another activation', async () => {
    const p = await open(
      true,
      'best_effort',
      `
      const original = ctx.storage.set.bind(ctx.storage);
      ctx.storage.set = async (key, value) => {
        await original(key, value);
        if (key.endsWith('/head') && value.revision === 2) {
          const { resolveSessionAuthority } = await import(${JSON.stringify(new URL('../../dist/adapters/session-authority.js', import.meta.url).href)});
          const { existsSync } = await import('node:fs');
          const { mkdir, rename, writeFile } = await import('node:fs/promises');
          const session = await resolveSessionAuthority({ root: ctx.location.directory, sessionId: value.sessionId });
          if (session.status !== 'resolved') throw new Error('Expected committed workflow');
          const audit = session.sessDir + '/audit.jsonl';
          if (existsSync(audit)) await rename(audit, audit + '.before-fault');
          await mkdir(audit);
          await writeFile(ctx.location.directory + '/audit-fault-path', audit);
        }
      };
    `,
    );
    const root = await p.session();
    const input = await request(p, root.id);
    await expect(start(p, input)).rejects.toThrow('activation audit is unconfirmed');
    const bound = await workflow(p, root.id);
    expect(bound.state.phase).toBe('READY');
    await expect(p.prompt(root.id, 'Blocked by the audit fault.')).rejects.toThrow();
    expect(p.requests).toEqual([]);
    const auditPath = await readFile(p.project + '/audit-fault-path', 'utf8');
    await rmdir(auditPath);
    if (
      await access(auditPath + '.before-fault').then(
        () => true,
        () => false,
      )
    )
      await rename(auditPath + '.before-fault', auditPath);
    expect(await start(p, input)).toMatchObject({ kind: 'already_active' });
    await p.prompt(root.id, 'Admitted after audit repair.');
    expect(productiveTools(p)).toContain('flowguard_ticket');
    const events = await readAuditTrail(bound.sessDir);
    expect(events.filter((event) => event.event === 'governance:activated')).toHaveLength(1);
    expect(verifyChain(events).valid).toBe(true);
  }, 300_000);

  it('refuses runtime admission after a failed confirmation write, including SIGKILL, then repairs through the same RPC', async () => {
    const p = await open(
      true,
      'best_effort',
      `
      const { existsSync } = await import('node:fs');
      const original = ctx.storage.set.bind(ctx.storage);
      ctx.storage.set = async (key, value) => {
        if (key.endsWith('/audit-confirmation') && !existsSync(ctx.location.directory + '/allow-confirmation'))
          throw new Error('injected autonomous confirmation failure');
        return original(key, value);
      };
    `,
    );
    const root = await p.session();
    const input = await request(p, root.id);
    await expect(start(p, input)).rejects.toThrow();
    const bound = await workflow(p, root.id);
    expect(bound.state.phase).toBe('READY');
    await expect(p.prompt(root.id, 'Denied before repair.')).rejects.toThrow();
    expect(p.requests).toEqual([]);
    await p.restart('SIGKILL');
    await p.client.command.list({ location: p.location });
    await expect(p.prompt(root.id, 'Still denied after reload.')).rejects.toThrow();
    expect(p.requests).toEqual([]);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(p.project + '/allow-confirmation', 'yes');
    expect(await start(p, input)).toMatchObject({ kind: 'already_active' });
    await p.prompt(root.id, 'Admitted after repair.');
    expect(productiveTools(p)).toContain('flowguard_ticket');
    expect(
      (await readAuditTrail(bound.sessDir)).filter(
        (event) => event.event === 'governance:activated',
      ),
    ).toHaveLength(1);
  }, 300_000);
});
