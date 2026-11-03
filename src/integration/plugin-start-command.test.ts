/** Native `/start` through the real plugin composition. Host callbacks are fixtures:
 * they exercise the command channel, never operator-UI provenance. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FlowGuardAuditPlugin } from './plugin.js';
import { createV2Host } from './opencode-v2-test-helpers.js';
import { createTestWorkspace, type TestWorkspace } from './test-helpers.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import {
  governanceActivationKeys,
  resolveGovernanceActivation,
} from '../adapters/governance-activation.js';
import type { GovernanceActivationRevision } from '../state/governance-activation.js';
import { parseStartArguments } from './plugin-start-command.js';
import * as tools from './tools/index.js';

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
    const trail = await readAuditTrail(authority.sessDir);
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
    await host.command('start', sessionId);
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
    disposers.splice(disposers.indexOf(dispose), 1);
    await dispose();
    // A new host process over the same persisted plugin storage.
    const restarted = createV2Host(ws.tmpDir);
    for (const [key, value] of host.activation.values) restarted.activation.values.set(key, value);
    host = restarted;
    await open();
    await host.command('start', sessionId);
    expect(revisions().map((item) => [item.status, item.decisionId])).toEqual([
      ['activating', pending!.decisionId],
      ['active', pending!.decisionId],
    ]);
    expect(host.synthetic).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringContaining('interrupted Start was completed') }),
    );
  });

  it('serializes concurrent Starts into exactly one activation', async () => {
    await open();
    const sessionId = randomUUID();
    await Promise.all([host.command('start', sessionId), host.command('start', sessionId)]);
    expect(revisions().map((item) => item.status)).toEqual(['activating', 'active']);
    expect(host.activation.values.has(governanceActivationKeys(sessionId).head)).toBe(true);
  });

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
});
