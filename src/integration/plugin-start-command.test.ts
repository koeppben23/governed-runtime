/** Native `/start` through the real plugin composition. Host callbacks are fixtures:
 * they exercise the command channel, never operator-UI provenance. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FlowGuardAuditPlugin } from './plugin.js';
import { createV2Host, v2ToolEvent } from './opencode-v2-test-helpers.js';
import { createTestWorkspace, type TestWorkspace } from './test-helpers.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import {
  governanceActivationKeys,
  resolveGovernanceActivation,
} from '../adapters/governance-activation.js';
import type { GovernanceActivationRevision } from '../state/governance-activation.js';
import { parseStartArguments } from './plugin-start-command.js';
import * as tools from './tools/index.js';
import * as audit from '../adapters/persistence-audit.js';
import * as auditPipeline from './plugin-audit.js';
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

async function open(target = host): Promise<() => Promise<void>> {
  const cleanup = await FlowGuardAuditPlugin.setup(target.ctx);
  if (!cleanup) throw new Error('Expected plugin cleanup');
  const dispose = async () => {
    await cleanup();
  };
  disposers.push(dispose);
  return dispose;
}

function revisions(): GovernanceActivationRevision[] {
  return [...host.activation.values.entries()]
    .filter(([key]) => key.includes('/revisions/'))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value as GovernanceActivationRevision);
}

async function workflow(sessionId: string) {
  return resolveSessionAuthority({ root: ws.tmpDir, sessionId });
}

function toolContext(sessionId: string) {
  return {
    sessionID: sessionId,
    messageID: '',
    agent: '',
    signal: new AbortController().signal,
  };
}

describe('native /start command', () => {
  it('registers one native start command and leaves sessions untouched until invoked', async () => {
    await open();
    expect(host.context.command.transform).toHaveBeenCalledOnce();
    expect([...host.commands.keys()]).toEqual(['start']);
    const sessionId = randomUUID();
    expect(await resolveGovernanceActivation(host.activation.store, sessionId)).toEqual({
      kind: 'inactive',
      record: null,
    });
    expect((await workflow(sessionId)).status).not.toBe('resolved');
    expect(revisions()).toEqual([]);
  });

  it('hydrates, binds the frozen policy and activates the root via host_command', async () => {
    await open();
    const sessionId = randomUUID();
    await host.command('start', sessionId);
    const authority = await workflow(sessionId);
    if (authority.status !== 'resolved') throw new Error('Expected workflow state');
    const active = await resolveGovernanceActivation(host.activation.store, sessionId);
    expect(active).toMatchObject({
      kind: 'active',
      record: {
        sessionId,
        rootSessionId: sessionId,
        directory: ws.tmpDir,
        worktreeRoot: authority.worktreeRoot,
        policyDigest: authority.state.policySnapshot.hash,
        decisionSource: 'host_command',
        parentDispatch: null,
      },
    });
    expect(revisions().map((item) => item.status)).toEqual(['activating', 'active']);
    expect([...host.definitions.keys()]).toContain('flowguard_status');
    const trail = await audit.readAuditTrail(authority.sessDir);
    expect(trail.map((event) => event.event)).toEqual(
      expect.arrayContaining(['tool_call:flowguard_hydrate', 'lifecycle:session_created']),
    );
    expect(
      trail.find((event) => event.event === 'tool_call:flowguard_hydrate')?.detail,
    ).toMatchObject({
      tool: 'flowguard_hydrate',
      success: true,
    });
    expect(host.synthetic).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: sessionId,
        resume: false,
        text: expect.stringContaining('governance is ACTIVE'),
      }),
    );
    const events = await audit.readAuditTrail(authority.sessDir);
    const activated = events.filter((event) => event.event === 'governance:activated');
    expect(activated).toHaveLength(1);
    if (active.kind !== 'active') throw new Error('Expected activation');
    expect(activated[0]).toMatchObject({
      id: active.record.activationId,
      hostSessionId: sessionId,
      actorInfo: {
        id: active.record.decisionActor.actorId,
        source: active.record.decisionActor.actorSource,
        assurance: active.record.decisionActor.actorAssurance,
      },
      detail: {
        channel: 'host_command',
        generation: 1,
        policyDigest: authority.state.policySnapshot.hash,
        activationId: active.record.activationId,
        decisionId: active.record.decisionId,
        rootSessionId: sessionId,
        worktreeRoot: authority.worktreeRoot,
      },
    });
    expect(verifyChain(events).valid).toBe(true);
    const preparation = trail.filter((event) => event.event !== 'governance:activated').at(-1)!;
    expect(Date.parse(activated[0]!.occurredAt)).toBeGreaterThanOrEqual(
      Date.parse(preparation.occurredAt),
    );
  });

  it('applies an explicit policy mode argument through hydrate', async () => {
    await open();
    const sessionId = randomUUID();
    await host.command('start', sessionId, ' solo ');
    const authority = await workflow(sessionId);
    if (authority.status !== 'resolved') throw new Error('Expected workflow state');
    expect(authority.state.policySnapshot.mode).toBe('solo');
    expect(host.synthetic).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Auto-approve is active') }),
    );
    const hydrate = vi.spyOn(tools.hydrate, 'execute');
    await host.command('start', sessionId);
    expect(hydrate).not.toHaveBeenCalled();
    expect(host.synthetic).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Auto-approve is active') }),
    );
  });

  it('never activates when the auto-approve gate notice cannot be reported', async () => {
    await open();
    const execute = tools.hydrate.execute.bind(tools.hydrate);
    vi.spyOn(tools.hydrate, 'execute').mockImplementation(async (args, context) => {
      const output = await execute(args, context);
      const text = typeof output === 'string' ? output : output.output;
      const [head = '', ...tail] = text.split('\n');
      const {
        gateNotice: _notice,
        presentation: _presentation,
        ...rest
      } = JSON.parse(head) as Record<string, unknown>;
      return [JSON.stringify(rest), ...tail].join('\n');
    });
    const sessionId = randomUUID();
    await expect(host.command('start', sessionId, 'solo')).rejects.toThrow(
      /PLUGIN_ENFORCEMENT_UNAVAILABLE/,
    );
    expect(revisions()).toEqual([]);
    expect(host.synthetic).not.toHaveBeenCalled();
  });

  it('is idempotent for an ACTIVE root and never mints a second decision', async () => {
    await open();
    const sessionId = randomUUID();
    await host.command('start', sessionId);
    const before = await workflow(sessionId);
    const hydrate = vi.spyOn(tools.hydrate, 'execute');
    await host.command('start', sessionId);
    expect(hydrate).not.toHaveBeenCalled();
    expect(await workflow(sessionId)).toEqual(before);
    expect(revisions().map((item) => item.status)).toEqual(['activating', 'active']);
    expect(host.synthetic).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringContaining('was already ACTIVE') }),
    );
  });

  it('rejects delegated child sessions without hydrating or writing authority', async () => {
    await open();
    const childId = randomUUID();
    host.sessionGet.mockImplementation(async ({ sessionID }) => ({
      id: sessionID,
      location: { directory: ws.tmpDir },
      parentID: randomUUID(),
    }));
    await expect(host.command('start', childId)).rejects.toThrow(/GOVERNANCE_AUTHORITY_BLOCKED/);
    expect((await workflow(childId)).status).not.toBe('resolved');
    expect(revisions()).toEqual([]);
    expect(host.synthetic).not.toHaveBeenCalled();
  });

  it('rejects unsupported arguments before any effect', async () => {
    await open();
    const sessionId = randomUUID();
    await expect(host.command('start', sessionId, 'please activate')).rejects.toThrow(
      /START_ARGUMENTS_INVALID/,
    );
    expect((await workflow(sessionId)).status).not.toBe('resolved');
    expect(revisions()).toEqual([]);
  });

  it('completes an interrupted Start of the same decision after a restart', async () => {
    const dispose = await open();
    const sessionId = randomUUID();
    const set = host.activation.store.set.bind(host.activation.store);
    const failActive = vi
      .spyOn(host.activation.store, 'set')
      .mockImplementation(async (key, value) => {
        if ((value as { status?: string }).status === 'active')
          throw new Error('host storage interrupted');
        return set(key, value);
      });
    await expect(host.command('start', sessionId)).rejects.toThrow(/GOVERNANCE_AUTHORITY_BLOCKED/);
    failActive.mockRestore();
    const [pending] = revisions();
    expect(revisions().map((item) => item.status)).toEqual(['activating']);
    expect(await resolveGovernanceActivation(host.activation.store, sessionId)).toMatchObject({
      kind: 'blocked',
    });
    const prepared = await workflow(sessionId);
    if (prepared.status !== 'resolved') throw new Error('Expected prepared workflow');
    expect(
      (await audit.readAuditTrail(prepared.sessDir)).filter(
        (event) => event.event === 'governance:activated',
      ),
    ).toEqual([]);
    disposers.splice(disposers.indexOf(dispose), 1);
    await dispose();
    // A new host process over the same persisted plugin storage.
    const restarted = createV2Host(ws.tmpDir);
    for (const [key, value] of host.activation.values) restarted.activation.values.set(key, value);
    host = restarted;
    await open();
    const hydrate = vi.spyOn(tools.hydrate, 'execute');
    await host.command('start', sessionId);
    expect(hydrate).not.toHaveBeenCalled();
    expect(revisions().map((item) => [item.status, item.decisionId])).toEqual([
      ['activating', pending!.decisionId],
      ['active', pending!.decisionId],
    ]);
    expect(
      (await audit.readAuditTrail(prepared.sessDir)).filter(
        (event) => event.event === 'governance:activated',
      ),
    ).toEqual([
      expect.objectContaining({
        detail: expect.objectContaining({ decisionId: pending!.decisionId, generation: 1 }),
      }),
    ]);
    expect(host.synthetic).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringContaining('interrupted Start was completed') }),
    );
  });

  it('serializes concurrent Starts into exactly one activation', async () => {
    await open();
    const sessionId = randomUUID();
    const hydrate = vi.spyOn(tools.hydrate, 'execute');
    await Promise.all([host.command('start', sessionId), host.command('start', sessionId)]);
    expect(hydrate).toHaveBeenCalledOnce();
    expect(revisions().map((item) => item.status)).toEqual(['activating', 'active']);
    expect(host.activation.values.has(governanceActivationKeys(sessionId).head)).toBe(true);
    const authority = await workflow(sessionId);
    if (authority.status !== 'resolved') throw new Error('Expected workflow');
    expect(
      (await audit.readAuditTrail(authority.sessDir)).filter(
        (event) => event.event === 'governance:activated',
      ),
    ).toHaveLength(1);
  });

  it('never treats hydrated state as activation when the first activation write fails', async () => {
    await open();
    const sessionId = randomUUID();
    vi.spyOn(host.activation.store, 'set').mockRejectedValueOnce(
      new Error('first activation write failed'),
    );
    await expect(host.command('start', sessionId)).rejects.toThrow('GOVERNANCE_AUTHORITY_BLOCKED');
    const authority = await workflow(sessionId);
    if (authority.status !== 'resolved') throw new Error('Expected prepared workflow');
    expect(await resolveGovernanceActivation(host.activation.store, sessionId)).toMatchObject({
      kind: 'inactive',
      record: null,
    });
    expect(
      (await audit.readAuditTrail(authority.sessDir)).filter(
        (event) => event.event === 'governance:activated',
      ),
    ).toEqual([]);
    expect(host.synthetic).not.toHaveBeenCalled();
  });

  it('serializes preparation across independent plugin instances sharing the journal', async () => {
    const second = createV2Host(ws.tmpDir);
    Object.assign(second.context, { storage: host.context.storage });
    await open();
    await open(second);
    const sessionId = randomUUID();
    const hydrate = vi.spyOn(tools.hydrate, 'execute');
    await Promise.all([host.command('start', sessionId), second.command('start', sessionId)]);
    expect(hydrate).toHaveBeenCalledOnce();
    expect(revisions()).toHaveLength(2);
    const authority = await workflow(sessionId);
    if (authority.status !== 'resolved') throw new Error('Expected workflow');
    expect(
      (await audit.readAuditTrail(authority.sessDir)).filter(
        (event) => event.event === 'governance:activated',
      ),
    ).toHaveLength(1);
  });

  it('rejects a policy-mode change for an ACTIVE binding without calling hydrate', async () => {
    await open();
    const sessionId = randomUUID();
    await host.command('start', sessionId, 'solo');
    const before = await workflow(sessionId);
    const hydrate = vi.spyOn(tools.hydrate, 'execute');
    await expect(host.command('start', sessionId, 'team')).rejects.toThrow(
      'GOVERNANCE_AUTHORITY_BLOCKED',
    );
    expect(hydrate).not.toHaveBeenCalled();
    expect(await workflow(sessionId)).toEqual(before);
    expect(revisions()).toHaveLength(2);
  });

  it('does not activate or emit a success audit when hydration fails after preparing state', async () => {
    await open();
    const execute = tools.hydrate.execute.bind(tools.hydrate);
    vi.spyOn(tools.hydrate, 'execute').mockImplementationOnce(async (args, context) => {
      await execute(args, context);
      throw new Error('hydration interrupted after state preparation');
    });
    const sessionId = randomUUID();
    await expect(host.command('start', sessionId)).rejects.toThrow('hydration interrupted');
    const authority = await workflow(sessionId);
    if (authority.status !== 'resolved') throw new Error('Expected prepared workflow');
    expect(await resolveGovernanceActivation(host.activation.store, sessionId)).toMatchObject({
      kind: 'inactive',
      record: null,
    });
    expect(
      (await audit.readAuditTrail(authority.sessDir)).filter(
        (event) => event.event === 'governance:activated',
      ),
    ).toEqual([]);
    expect(host.synthetic).not.toHaveBeenCalled();
  });

  it('does not activate when hydrate reports a blocked result after preparing state', async () => {
    await open();
    const execute = tools.hydrate.execute.bind(tools.hydrate);
    vi.spyOn(tools.hydrate, 'execute').mockImplementationOnce(async (args, context) => {
      await execute(args, context);
      return JSON.stringify({
        error: true,
        code: 'SESSION_LOCK_CONTENDED',
        message: 'hydrate lock was contended',
      });
    });
    const sessionId = randomUUID();
    await expect(host.command('start', sessionId)).rejects.toThrow(/SESSION_LOCK_CONTENDED/);
    const authority = await workflow(sessionId);
    if (authority.status !== 'resolved') throw new Error('Expected prepared workflow');
    expect(await resolveGovernanceActivation(host.activation.store, sessionId)).toMatchObject({
      kind: 'inactive',
      record: null,
    });
    expect(revisions()).toEqual([]);
    expect(
      (await audit.readAuditTrail(authority.sessDir)).filter(
        (event) => event.event === 'governance:activated',
      ),
    ).toEqual([]);
    expect(host.synthetic).not.toHaveBeenCalled();
  });

  it('repairs failed activation audit without rehydrating or minting another decision', async () => {
    await open();
    const sessionId = randomUUID();
    const append = vi
      .spyOn(audit, 'appendAuditEventAlreadyLocked')
      .mockRejectedValueOnce(new Error('activation audit write failed'));
    await expect(host.command('start', sessionId)).rejects.toThrow(
      'durably ACTIVE but activation audit is unconfirmed',
    );
    append.mockRestore();
    const authority = await workflow(sessionId);
    if (authority.status !== 'resolved') throw new Error('Expected prepared workflow');
    expect(await resolveGovernanceActivation(host.activation.store, sessionId)).toMatchObject({
      kind: 'active',
    });
    expect(
      (await audit.readAuditTrail(authority.sessDir)).filter(
        (event) => event.event === 'governance:activated',
      ),
    ).toEqual([]);
    const help = host.definitions.get('flowguard_help')!;
    await expect(help.execute({ view: 'context' }, toolContext(sessionId))).rejects.toThrow(
      'activation audit is unconfirmed',
    );
    const hydrate = vi.spyOn(tools.hydrate, 'execute');
    await host.command('start', sessionId);
    await host.command('start', sessionId);
    expect(hydrate).not.toHaveBeenCalled();
    expect(revisions()).toHaveLength(2);
    expect(
      (await audit.readAuditTrail(authority.sessDir)).filter(
        (event) => event.event === 'governance:activated',
      ),
    ).toHaveLength(1);
    await expect(help.execute({ view: 'context' }, toolContext(sessionId))).resolves.toMatchObject({
      content: expect.any(String),
    });
  });

  it('blocks governed runtime admission until the activation-audit confirmation is repaired', async () => {
    await open();
    const sessionId = randomUUID();
    await host.command('start', sessionId);
    const authority = await workflow(sessionId);
    if (authority.status !== 'resolved') throw new Error('Expected workflow');
    const activationEvents = (await audit.readAuditTrail(authority.sessDir)).filter(
      (event) => event.event === 'governance:activated',
    );
    expect(activationEvents).toHaveLength(1);
    expect(host.activation.values.has(governanceActivationKeys(sessionId).audit)).toBe(true);
    host.activation.values.delete(governanceActivationKeys(sessionId).audit);
    await expect(host.before(v2ToolEvent({ sessionID: sessionId }))).rejects.toThrow(
      'activation audit is unconfirmed',
    );
    const ticket = host.definitions.get('flowguard_ticket')!;
    await expect(
      ticket.execute({ text: 'audit gate probe' }, toolContext(sessionId)),
    ).rejects.toThrow('activation audit is unconfirmed');
    const blocked = await workflow(sessionId);
    if (blocked.status !== 'resolved') throw new Error('Expected workflow');
    expect(blocked.state.phase).toBe('READY');

    await host.command('start', sessionId);
    await expect(host.before(v2ToolEvent({ sessionID: sessionId }))).resolves.toBeUndefined();
    const recovered = (await ticket.execute(
      { text: 'audit gate probe' },
      toolContext(sessionId),
    )) as { content: string };
    expect(JSON.parse(recovered.content)).toMatchObject({ status: 'ok', phase: 'TICKET' });
    const trail = await audit.readAuditTrail(authority.sessDir);
    expect(trail.filter((event) => event.event === 'governance:activated')).toHaveLength(1);
    expect(verifyChain(trail).valid).toBe(true);
  });

  it.each([
    [
      'activation',
      (marker: Record<string, unknown>) => ({ ...marker, activationId: randomUUID() }),
    ],
    ['session', (marker: Record<string, unknown>) => ({ ...marker, sessionId: randomUUID() })],
  ] as const)(
    'blocks governed runtime admission for a stale %s confirmation',
    async (_name, mutate) => {
      await open();
      const sessionId = randomUUID();
      await host.command('start', sessionId);
      const key = governanceActivationKeys(sessionId).audit;
      const marker = host.activation.values.get(key) as Record<string, unknown>;
      host.activation.values.set(key, mutate(marker));
      const ticket = host.definitions.get('flowguard_ticket')!;
      await expect(
        ticket.execute({ text: 'stale confirmation probe' }, toolContext(sessionId)),
      ).rejects.toThrow('activation audit is unconfirmed');
      await host.command('start', sessionId);
      const recovered = (await ticket.execute(
        { text: 'stale confirmation probe' },
        toolContext(sessionId),
      )) as { content: string };
      expect(JSON.parse(recovered.content)).toMatchObject({ status: 'ok', phase: 'TICKET' });
    },
  );

  it('blocks governed runtime admission when the confirmation store is unreadable', async () => {
    await open();
    const sessionId = randomUUID();
    await host.command('start', sessionId);
    const key = governanceActivationKeys(sessionId).audit;
    const get = host.activation.store.get.bind(host.activation.store);
    const failure = vi.spyOn(host.activation.store, 'get').mockImplementation(async (requested) => {
      if (requested === key) throw new Error('confirmation store unreadable');
      return get(requested);
    });
    const ticket = host.definitions.get('flowguard_ticket')!;
    await expect(
      ticket.execute({ text: 'unreadable confirmation probe' }, toolContext(sessionId)),
    ).rejects.toThrow('activation audit is unconfirmed');
    failure.mockRestore();
    await host.command('start', sessionId);
    const recovered = (await ticket.execute(
      { text: 'unreadable confirmation probe' },
      toolContext(sessionId),
    )) as { content: string };
    expect(JSON.parse(recovered.content)).toMatchObject({ status: 'ok', phase: 'TICKET' });
  });

  it('confirms the activation audit even when the hydrate preparation audit fails', async () => {
    await open();
    const sessionId = randomUUID();
    const failure = vi
      .spyOn(auditPipeline, 'runAudit')
      .mockRejectedValueOnce(new Error('hydrate audit failed'));
    await expect(host.command('start', sessionId)).rejects.toThrow(
      'hydrate preparation audit is unconfirmed',
    );
    failure.mockRestore();
    const authority = await workflow(sessionId);
    if (authority.status !== 'resolved') throw new Error('Expected workflow');
    expect(await resolveGovernanceActivation(host.activation.store, sessionId)).toMatchObject({
      kind: 'active',
    });
    const trail = await audit.readAuditTrail(authority.sessDir);
    expect(trail.filter((event) => event.event === 'governance:activated')).toHaveLength(1);
    expect(verifyChain(trail).valid).toBe(true);
    const hydrate = vi.spyOn(tools.hydrate, 'execute');
    await host.command('start', sessionId);
    expect(hydrate).not.toHaveBeenCalled();
    expect(
      (await audit.readAuditTrail(authority.sessDir)).filter(
        (event) => event.event === 'governance:activated',
      ),
    ).toHaveLength(1);
  });

  it('does not duplicate an activation audit after a lost append acknowledgement', async () => {
    await open();
    const sessionId = randomUUID();
    const append = audit.appendAuditEventAlreadyLocked;
    const failure = vi
      .spyOn(audit, 'appendAuditEventAlreadyLocked')
      .mockImplementationOnce(async (dir, event) => {
        await append(dir, event);
        throw new Error('lost audit acknowledgement');
      });
    await expect(host.command('start', sessionId)).rejects.toThrow(
      'durably ACTIVE but activation audit is unconfirmed',
    );
    failure.mockRestore();
    const authority = await workflow(sessionId);
    if (authority.status !== 'resolved') throw new Error('Expected workflow');
    const before = await audit.readAuditTrail(authority.sessDir);
    expect(before.filter((event) => event.event === 'governance:activated')).toHaveLength(1);
    const hydrate = vi.spyOn(tools.hydrate, 'execute');
    await host.command('start', sessionId);
    expect(hydrate).not.toHaveBeenCalled();
    expect(await audit.readAuditTrail(authority.sessDir)).toEqual(before);
    expect(verifyChain(before).valid).toBe(true);
  });

  it.each(['publish', 'synthetic'] as const)(
    'reports the committed activation truthfully when %s presentation fails',
    async (phase) => {
      await open();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const sessionId = randomUUID();
      if (phase === 'publish')
        host.context.tool.transform.mockRejectedValueOnce(new Error('publication failed'));
      else host.synthetic.mockRejectedValueOnce(new Error('synthetic failed'));
      await expect(host.command('start', sessionId)).resolves.toBeUndefined();
      expect(await resolveGovernanceActivation(host.activation.store, sessionId)).toMatchObject({
        kind: 'active',
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('durably ACTIVE'),
        expect.any(Error),
      );
      const hydrate = vi.spyOn(tools.hydrate, 'execute');
      await host.command('start', sessionId);
      expect(hydrate).not.toHaveBeenCalled();
      expect(host.definitions.has('flowguard_status')).toBe(true);
      expect(host.synthetic).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: expect.stringContaining('was already ACTIVE') }),
      );
      const authority = await workflow(sessionId);
      if (authority.status !== 'resolved') throw new Error('Expected workflow');
      expect(
        (await audit.readAuditTrail(authority.sessDir)).filter(
          (event) => event.event === 'governance:activated',
        ),
      ).toHaveLength(1);
    },
  );

  it('rejects Start after the plugin stopped', async () => {
    const dispose = await open();
    disposers.splice(disposers.indexOf(dispose), 1);
    await dispose();
    await expect(host.command('start', randomUUID())).rejects.toThrow(
      /PLUGIN_ENFORCEMENT_UNAVAILABLE/,
    );
    expect(revisions()).toEqual([]);
  });
});

describe('/start arguments', () => {
  it.each(['', '  ', '\n'])('treats %j as the configured policy mode', (text) => {
    expect(parseStartArguments(text)).toBeUndefined();
  });
  it.each(['solo', 'team', 'team-ci', 'regulated'] as const)('accepts %s', (mode) => {
    expect(parseStartArguments(mode)).toBe(mode);
  });
  it.each(['SOLO', 'solo team', 'activate', '--force'])('rejects %j', (text) => {
    expect(() => parseStartArguments(text)).toThrow(/START_ARGUMENTS_INVALID/);
  });
  it('bounds the rejected argument echo', () => {
    const text = 'x'.repeat(200);
    expect(() => parseStartArguments(text)).toThrow(/START_ARGUMENTS_INVALID/);
    expect(() => parseStartArguments(text)).not.toThrow(/x{81}/);
  });
});
