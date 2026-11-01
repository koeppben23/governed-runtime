/** Native V2 lazy bootstrap, canonical authority and pre-effect fail-closed gates.
 * Host callbacks are fixtures; these tests do not establish installed UI origin. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FlowGuardAuditPlugin } from './plugin.js';
import { makeState, FROZEN_IMPLEMENTATION_BASE } from '../fixtures.js';
import { hashText } from '../shared/hashing.js';
import { createTestWorkspace, canonicalBinding, withTestEnv } from './test-helpers.js';
import { createV2Host, v2ToolEvent } from './opencode-v2-test-helpers.js';
import { readState, writeState } from '../adapters/persistence.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import { writeStateWithArtifactsAndAuditOperations } from './tools/helpers.js';
import { writeStateWithAuditOperations } from './audit-outbox.js';
import { computeFingerprint, ensureWorkspace, sessionDir } from '../adapters/workspace/index.js';
import {
  governanceActivationKeys,
  governanceDelegationKey,
  resolveGovernanceActivation,
} from '../adapters/governance-activation.js';

vi.mock('../adapters/git.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return {
    ...original,
    isGitRepoStrict: vi.fn().mockResolvedValue(true),
    changedFiles: vi.fn(original.changedFiles),
  };
});

const execFileAsync = promisify(execFile);
let configDir: string;
let restoreEnv: () => void;
const cleanup: Array<() => void | Promise<void>> = [];

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-v2-bootstrap-'));
  restoreEnv = withTestEnv({
    OPENCODE_CONFIG_DIR: configDir,
    FLOWGUARD_REQUIRE_TEST_CONFIG_DIR: '1',
  });
});
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  } finally {
    restoreEnv();
    await fs.rm(configDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});

async function openHost(directory: string, active?: { sessionId: string; policyDigest: string }) {
  const host = createV2Host(directory);
  if (active) await host.seedActive(active.sessionId, active.policyDigest);
  const dispose = await FlowGuardAuditPlugin.setup(host.ctx);
  if (dispose) cleanup.push(dispose);
  return host;
}

async function fixture(
  phase?: Parameters<typeof makeState>[0],
  overrides: Parameters<typeof makeState>[1] = {},
  realGit = false,
) {
  const ws = await createTestWorkspace();
  cleanup.push(ws.cleanup);
  if (realGit) await execFileAsync('git', ['init'], { cwd: ws.tmpDir });
  const sessionID = crypto.randomUUID();
  const fingerprint = (await computeFingerprint(ws.tmpDir)).fingerprint;
  const sessDir = sessionDir(fingerprint, sessionID);
  const state = makeState(phase ?? 'TICKET', {
    ...overrides,
    binding: await canonicalBinding(ws.tmpDir, sessionID),
  });
  if (phase) {
    await fs.mkdir(sessDir, { recursive: true });
    await writeState(sessDir, state);
  }
  const host = await openHost(
    ws.tmpDir,
    phase ? { sessionId: sessionID, policyDigest: state.policySnapshot.hash } : undefined,
  );
  return { ws, sessionID, sessDir, state, host };
}

function beforeEvent(
  sessionID: string,
  tool = 'shell',
  input: Record<string, unknown> = { command: 'npm install' },
  id = 'c1',
) {
  return v2ToolEvent({ tool, sessionID, input, id });
}

async function pendingTransition() {
  const h = await fixture('VALIDATION');
  const transition = {
    from: 'VALIDATION',
    to: 'IMPLEMENTATION',
    event: 'ALL_PASSED',
    at: '2026-05-15T12:00:00.000Z',
  } as const;
  await writeStateWithArtifactsAndAuditOperations(
    h.sessDir,
    makeState('IMPLEMENTATION', {
      binding: h.state.binding,
      implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
      transition,
    }),
    [transition],
  );
  return h;
}

function riskPolicy() {
  return {
    ...makeState('IMPLEMENTATION').policySnapshot,
    mode: 'regulated' as const,
    requestedMode: 'regulated' as const,
    enforceRiskClassification: true,
  };
}

describe('native V2 lazy bootstrap', () => {
  it.each(['/', '', '/nonexistent/path'])(
    'does not create a fingerprint workspace merely by loading at %j',
    async (directory) => {
      const host = await openHost(directory);
      expect(await fs.readdir(path.join(configDir, 'workspaces')).catch(() => [])).toEqual([]);
      expect(host.sessionGet).not.toHaveBeenCalled();
    },
  );

  it('does not materialize a workspace for a real non-repository directory at setup', async () => {
    const directory = path.join(configDir, 'no-repo');
    await fs.mkdir(directory);
    await openHost(directory);
    expect(await fs.readdir(path.join(configDir, 'workspaces')).catch(() => [])).toEqual([]);
  });

  it('does not materialize a governed workspace on plugin load even with a .git marker', async () => {
    const directory = path.join(configDir, 'repo');
    await fs.mkdir(path.join(directory, '.git'), { recursive: true });
    await openHost(directory);
    expect(await fs.readdir(path.join(configDir, 'workspaces')).catch(() => [])).toEqual([]);
  });

  it('starts file logging lazily on an actual session operation in an initialized workspace', async () => {
    const h = await fixture('TICKET');
    const ensured = await ensureWorkspace(h.ws.tmpDir);
    await expect(fs.stat(path.join(ensured.workspaceDir, 'workspace.json'))).resolves.toBeTruthy();
    await h.host.before(beforeEvent(h.sessionID, 'read', { filePath: 'README.md' }));
    await vi.waitFor(async () =>
      expect(
        (await fs.readdir(path.join(ensured.workspaceDir, '.opencode/logs'))).length,
      ).toBeGreaterThanOrEqual(1),
    );
    for (const dispose of cleanup.splice(1).reverse()) await dispose();
    expect(
      (await fs.readdir(path.join(ensured.workspaceDir, '.opencode/logs'))).length,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('native V2 phase and integrity gates', () => {
  it.each([
    { phase: 'PLAN', tool: 'shell', input: { command: 'npm install' } },
    { phase: 'TICKET', tool: 'edit', input: { filePath: 'file.ts', content: 'code' } },
    {
      phase: 'ARCHITECTURE',
      tool: 'edit',
      input: { filePath: 'file.ts', oldString: 'a', newString: 'b' },
    },
  ] as const)('blocks $tool before effect in $phase', async ({ phase, tool, input }) => {
    const h = await fixture(phase);
    await expect(h.host.before(beforeEvent(h.sessionID, tool, input))).rejects.toThrow(
      'HOST_TOOL_PHASE_DENIED',
    );
    expect((await readState(h.sessDir))!.mutationEpisodes).toEqual([]);
  });

  it('allows a native shell dispatch in IMPLEMENTATION with the frozen implementation base', async () => {
    const h = await fixture('IMPLEMENTATION', {
      implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
    });
    await expect(h.host.before(beforeEvent(h.sessionID))).resolves.toBeUndefined();
    expect((await readState(h.sessDir))!.mutationEpisodes).toHaveLength(1);
  });

  it('blocks every admitted native mutator while durable audit reconciliation fails', async () => {
    const h = await pendingTransition();
    await fs.writeFile(path.join(h.sessDir, 'audit.jsonl'), '{ malformed json\n', 'utf8');
    for (const tool of ['edit', 'shell'])
      await expect(
        h.host.before(beforeEvent(h.sessionID, tool, { command: 'blocked' }, crypto.randomUUID())),
      ).rejects.toThrow('AUDIT_PERSISTENCE_FAILED');
    expect((await readState(h.sessDir))!.mutationEpisodes).toEqual([]);
  });

  it('rejects tampered committed semantic operations without appending forged decisions or changing state', async () => {
    const h = await fixture('IMPLEMENTATION', {
      implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
    });
    await writeStateWithAuditOperations(h.sessDir, h.state, [
      {
        phase: 'IMPLEMENTATION',
        event: 'decision:TEST-001',
        occurredAt: '2026-05-15T12:00:00.000Z',
        actor: 'human',
        actorInfo: { id: 'tamper-probe', email: null, source: 'env', assurance: 'best_effort' },
        detail: { kind: 'decision', decisionId: 'TEST-001' },
      },
    ]);
    const persisted = (await readState(h.sessDir))!;
    await fs.writeFile(
      path.join(h.sessDir, 'session-state.json'),
      JSON.stringify({
        ...persisted,
        pendingAuditOperations: persisted.pendingAuditOperations.map((operation) =>
          operation.kind === 'semantic'
            ? {
                ...operation,
                semantic: {
                  ...operation.semantic,
                  detail: { kind: 'decision', decisionId: 'FORGED' },
                },
              }
            : operation,
        ),
      }),
    );
    const before = await readState(h.sessDir);
    const trail = await readAuditTrail(h.sessDir);
    await expect(h.host.before(beforeEvent(h.sessionID))).rejects.toThrow(
      'AUDIT_PERSISTENCE_FAILED',
    );
    const after = await readAuditTrail(h.sessDir);
    expect(after.filter((event) => event.event.includes('decision:'))).toEqual([]);
    expect(after).toHaveLength(trail.length + 1);
    expect(after.at(-1)?.event).toBe('enforcement:denied');
    expect(await readState(h.sessDir)).toEqual(before);
  });

  it('reconciles successfully, admits distinct calls and rejects replay of the same native id', async () => {
    const h = await pendingTransition();
    const event = beforeEvent(h.sessionID);
    await expect(h.host.before(event)).resolves.toBeUndefined();
    expect((await readState(h.sessDir))!.pendingAuditOperations[0]!.status).toBe('reconciled');
    await expect(h.host.before({ ...event, id: 'c2' })).resolves.toBeUndefined();
    await expect(h.host.before(event)).rejects.toThrow('MUTATION_EPISODE_REPLAY_BLOCKED');
    expect((await readState(h.sessDir))!.mutationEpisodes).toHaveLength(2);
  });

  it('runs audit reconciliation before the risk gate can write state', async () => {
    const h = await pendingTransition();
    await fs.writeFile(path.join(h.sessDir, 'audit.jsonl'), '{ malformed json\n', 'utf8');
    await expect(
      h.host.before(beforeEvent(h.sessionID, 'edit', { filePath: 'x.ts', old: 'a', new: 'b' })),
    ).rejects.toThrow('AUDIT_PERSISTENCE_FAILED');
    const state = (await readState(h.sessDir))!;
    expect(state.riskGate).toBeUndefined();
    expect(state.pendingAuditOperations[0]!.status).toBe('state_committed');
  });

  it('does not install a V1 command-origin shim or infer operator intent from tool arguments', async () => {
    const h = await fixture('PLAN');
    expect(h.host.context.command.transform).not.toHaveBeenCalled();
    await expect(
      h.host.before(
        beforeEvent(h.sessionID, 'shell', {
          command: 'npm test',
          scope: '/implement',
          origin: 'human',
        }),
      ),
    ).rejects.toThrow('HOST_TOOL_PHASE_DENIED');
    expect((await readState(h.sessDir))!.mutationEpisodes).toEqual([]);
  });

  it('allows native read-only inspection in PLAN', async () => {
    const h = await fixture('PLAN');
    await expect(
      h.host.before(beforeEvent(h.sessionID, 'read', { filePath: 'README.md' })),
    ).resolves.toBeUndefined();
  });

  it('leaves an ordinary shell call untouched before any FlowGuard start', async () => {
    const h = await fixture();
    const event = beforeEvent(h.sessionID);
    const input = event.input;
    await expect(h.host.before(event)).resolves.toBeUndefined();
    expect(event.input).toBe(input);
  });

  it('fails closed when the workflow directory disappears after native setup', async () => {
    const h = await fixture('IMPLEMENTATION', {
      implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
    });
    await h.host.before(beforeEvent(h.sessionID, 'read', { path: 'README.md' }));
    await fs.rm(h.sessDir, { recursive: true, force: true });
    await expect(h.host.before(beforeEvent(h.sessionID))).rejects.toThrow('SESSION_DIR_NOT_FOUND');
  });

  it('does not require Git for ordinary unstarted host usage', async () => {
    const directory = path.join(configDir, 'no-git');
    await fs.mkdir(directory);
    const host = await openHost(directory);
    await expect(host.before(beforeEvent(crypto.randomUUID()))).resolves.toBeUndefined();
  });

  it('fails closed when previously observed workflow state goes missing', async () => {
    const h = await fixture('IMPLEMENTATION', {
      implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
    });
    await h.host.before(beforeEvent(h.sessionID, 'read', { path: 'README.md' }));
    await fs.unlink(path.join(h.sessDir, 'session-state.json'));
    await expect(h.host.before(beforeEvent(h.sessionID))).rejects.toThrow('SESSION_DIR_NOT_FOUND');
  });

  it('fails explicitly on corrupt state, without normalizing it to absent authority', async () => {
    const h = await fixture('TICKET');
    await fs.mkdir(h.sessDir, { recursive: true });
    await fs.writeFile(path.join(h.sessDir, 'session-state.json'), '{ corrupt JSON');
    await expect(h.host.before(beforeEvent(h.sessionID))).rejects.toThrow('PARSE_FAILED');
  });

  it('retains the structured missing-state denial diagnostics', async () => {
    const h = await fixture('IMPLEMENTATION', {
      implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
    });
    await h.host.before(beforeEvent(h.sessionID, 'read', { path: 'README.md' }));
    await fs.unlink(path.join(h.sessDir, 'session-state.json'));
    const error: unknown = await h.host
      .before(beforeEvent(h.sessionID, 'edit', { filePath: 'file.ts', content: 'x' }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('FlowGuardEnforcementError');
    const message = (error as Error).message;
    const json = JSON.parse(message.slice(message.indexOf('{'))) as Record<string, unknown>;
    expect(json.code).toBe('SESSION_DIR_NOT_FOUND');
    expect(json.message).toContain('Cannot verify host tool phase gate');
    expect(json.diagnostics).toMatchObject({
      diagnosticCode: 'SESSION_DIRECTORY_MISSING',
      missingEvidence: expect.arrayContaining(['readable_session_state']),
    });
    expect(json.diagnosticCard).toBeUndefined();
  });

  it('retains typed phase-denial diagnostics and the canonical shell classification', async () => {
    const h = await fixture('PLAN');
    await expect(h.host.before(beforeEvent(h.sessionID))).rejects.toMatchObject({
      name: 'FlowGuardEnforcementError',
      message: expect.stringMatching(/HOST_TOOL_PHASE_DENIED.*bash/),
    });
  });

  it('blocks verdict tools at corrupt canonical authority before attempting any review enforcement', async () => {
    const h = await fixture('TICKET');
    await fs.mkdir(h.sessDir, { recursive: true });
    await fs.writeFile(path.join(h.sessDir, 'session-state.json'), '{ corrupt JSON');
    await expect(
      h.host.before(beforeEvent(h.sessionID, 'flowguard_plan', { reviewVerdict: 'accept' })),
    ).rejects.toThrow('PARSE_FAILED');
  });

  it('allows a native read with absent workflow state without creating a session', async () => {
    const h = await fixture();
    await expect(
      h.host.before(beforeEvent(h.sessionID, 'read', { filePath: 'README.md' })),
    ).resolves.toBeUndefined();
    await expect(fs.stat(h.sessDir)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('blocks an invalid ticket declaration without latching an unrelated risk gate', async () => {
    const text = 'Risk: HIGH';
    const h = await fixture(
      'IMPLEMENTATION',
      {
        implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        ticket: {
          text,
          digest: hashText(text),
          source: 'user',
          createdAt: '2026-01-01T00:00:00.000Z',
          riskDeclaration: { kind: 'invalid', raw: 'HIGH' },
        },
        policySnapshot: riskPolicy(),
      },
      true,
    );
    await expect(
      h.host.before(
        beforeEvent(h.sessionID, 'edit', {
          filePath: path.join(h.ws.tmpDir, 'src/state/schema.ts'),
          content: 'x',
        }),
      ),
    ).rejects.toThrow('TICKET_RISK_DECLARATION_INVALID');
    expect((await readState(h.sessDir))?.riskGate?.status).not.toBe('blocked');
  });

  it('resolves missing risk classification automatically under enforced policy', async () => {
    const h = await fixture(
      'IMPLEMENTATION',
      { implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE, policySnapshot: riskPolicy() },
      true,
    );
    await expect(
      h.host.before(
        beforeEvent(h.sessionID, 'edit', {
          filePath: path.join(h.ws.tmpDir, 'README.md'),
          content: 'x',
        }),
      ),
    ).resolves.toBeUndefined();
    expect((await readState(h.sessDir))?.riskGate?.status).not.toBe('blocked');
  });

  it('blocks unavailable changed-files evidence and durably queues the risk event', async () => {
    const h = await fixture(
      'IMPLEMENTATION',
      {
        implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        claimedTaskClass: 'HIGH-RISK',
        policySnapshot: riskPolicy(),
      },
      true,
    );
    const git = await import('../adapters/git.js');
    vi.mocked(git.changedFiles).mockRejectedValueOnce(
      new Error('changed files evidence unavailable'),
    );
    await expect(
      h.host.before(
        beforeEvent(h.sessionID, 'edit', {
          filePath: path.join(h.ws.tmpDir, 'README.md'),
          content: 'x',
        }),
      ),
    ).rejects.toThrow('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE');
    const state = (await readState(h.sessDir))!;
    expect(state.riskGate).toMatchObject({
      status: 'blocked',
      code: 'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
    });
    expect(
      state.pendingAuditOperations.some(
        (operation) =>
          operation.kind === 'semantic' &&
          operation.semantic.event === 'risk:classification_checked',
      ),
    ).toBe(true);
  });

  it('replaces a native shell result with strict blocked output when risk evidence is unavailable', async () => {
    const h = await fixture(
      'IMPLEMENTATION',
      {
        implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        claimedTaskClass: 'HIGH-RISK',
        policySnapshot: riskPolicy(),
      },
      true,
    );
    const git = await import('../adapters/git.js');
    vi.mocked(git.changedFiles).mockRejectedValueOnce(
      new Error('changed files evidence unavailable'),
    );
    const event = {
      ...beforeEvent(h.sessionID),
      status: 'completed',
      result: { content: 'shell ok', metadata: {} },
    };
    await h.host.after(event);
    expect(event.result.content).toContain('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE');
    expect(event.result.content).toContain('BLOCKED');
    expect((await readState(h.sessDir))!.riskGate).toMatchObject({
      status: 'blocked',
      code: 'RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
    });
  });

  it('blocks the next mutation after persisted strict timestamp failure', async () => {
    const h = await fixture(
      'IMPLEMENTATION',
      {
        implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
        error: {
          code: 'TSA_TIMESTAMP_ASSURANCE_FAILED',
          message: 'Strict timestamp assurance failed for lifecycle: TSA request failed',
          recoveryHint: 'Fix TSA connectivity or trust anchors.',
          occurredAt: new Date().toISOString(),
        },
      },
      true,
    );
    await expect(
      h.host.before(
        beforeEvent(h.sessionID, 'edit', {
          filePath: path.join(h.ws.tmpDir, 'README.md'),
          content: 'x',
        }),
      ),
    ).rejects.toThrow('TSA_TIMESTAMP_ASSURANCE_FAILED');
  });
});

describe('native activation isolation and delegation with real enforcement gates', () => {
  it('rejects a different valid policy snapshot before the phase gate, rather than rebinding activation', async () => {
    const h = await fixture('PLAN');
    const replacement = makeState('PLAN', {
      binding: h.state.binding,
      policySnapshot: {
        ...h.state.policySnapshot,
        audit: { ...h.state.policySnapshot.audit, emitToolCalls: false },
      },
    });
    expect(replacement.policySnapshot.hash).not.toBe(h.state.policySnapshot.hash);
    await writeState(h.sessDir, replacement);
    await expect(h.host.before(beforeEvent(h.sessionID))).rejects.toThrow(
      'GOVERNANCE_AUTHORITY_BLOCKED',
    );
    expect((await readState(h.sessDir))!.mutationEpisodes).toEqual([]);
  });
  it('does not infer activation from existing workflow bytes, even when those bytes are corrupt', async () => {
    const h = await fixture();
    await fs.mkdir(h.sessDir, { recursive: true });
    await fs.writeFile(path.join(h.sessDir, 'session-state.json'), '{ not authority');
    const event = beforeEvent(h.sessionID);
    const original = structuredClone(event);
    await h.host.before(event);
    expect(event).toEqual(original);
    expect(await fs.readFile(path.join(h.sessDir, 'session-state.json'), 'utf8')).toBe(
      '{ not authority',
    );
  });

  it('keeps INACTIVE hooks inert in a host that also has an ACTIVE root, including compaction and subagents', async () => {
    const h = await fixture('PLAN');
    const inactiveId = crypto.randomUUID();
    for (const tool of ['shell', 'edit', 'subagent']) {
      const event = beforeEvent(inactiveId, tool, { agent: 'general', command: 'ordinary' });
      const original = structuredClone(event);
      await h.host.before(event);
      await h.host.after({ ...event, status: 'completed', result: { content: [] } });
      expect(event).toEqual(original);
    }
    for (const hook of ['context', 'compaction', 'generate']) {
      const view = {
        sessionID: inactiveId,
        agent: 'build',
        system: [{ type: 'text', text: 'native' }],
        messages: [],
        tools: { shell: {}, flowguard_plan: {}, flowguard_help: {} },
        model: { providerID: 'custom', id: 'custom', variant: 'native' },
        options: { custom: true },
      };
      await h.host.sessionHooks.get(hook)!(view);
      expect(view.tools).toEqual({ shell: {}, flowguard_help: {} });
      expect(view.system).toEqual([{ type: 'text', text: 'native' }]);
      expect(view.options).toEqual({ custom: true });
      expect(view.model).toEqual({ providerID: 'custom', id: 'custom', variant: 'native' });
    }
    expect((await readState(h.sessDir))!.mutationEpisodes).toEqual([]);
    await expect(h.host.before(beforeEvent(h.sessionID))).rejects.toThrow('HOST_TOOL_PHASE_DENIED');
  });

  it.each(['head', 'revision'])(
    'blocks ACTIVE authority loss (%s) without poisoning unrelated INACTIVE sessions',
    async (part) => {
      const h = await fixture('PLAN');
      const keys = governanceActivationKeys(h.sessionID);
      const key =
        part === 'head'
          ? keys.head
          : [...h.host.activation.values.keys()].find((key) => key.startsWith(keys.revisions))!;
      h.host.activation.values.delete(key);
      await expect(h.host.before(beforeEvent(h.sessionID))).rejects.toThrow(
        'GOVERNANCE_AUTHORITY_BLOCKED',
      );
      await expect(h.host.before(beforeEvent('unrelated'))).resolves.toBeUndefined();
    },
  );

  it('does not let a lost event stream disable ordinary INACTIVE work', async () => {
    const h = await fixture('PLAN');
    h.host.failEvents(new Error('stream failed'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(h.host.before(beforeEvent(h.sessionID))).rejects.toThrow(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
    );
    await expect(h.host.before(beforeEvent('ordinary'))).resolves.toBeUndefined();
  });

  it('fences only the ACTIVE scope whose session-error audit append failed', async () => {
    const h = await fixture('PLAN');
    // Warm the runtime and confirm the unfenced baseline is the phase gate.
    await expect(h.host.before(beforeEvent(h.sessionID))).rejects.toThrow('HOST_TOOL_PHASE_DENIED');
    const audit = path.join(h.sessDir, 'audit.jsonl');
    await fs.rm(audit, { force: true });
    await fs.mkdir(audit); // The canonical audit append now fails with real I/O.
    h.host.emit({
      type: 'session.execution.failed',
      id: 'failure-event',
      data: { sessionID: h.sessionID, error: { type: 'provider', message: 'failed' } },
    });
    await vi.waitFor(async () =>
      expect(h.host.before(beforeEvent(h.sessionID))).rejects.toThrow(
        'lost required event observation',
      ),
    );
    // Restoring the file system does not silently unfence the scope.
    await fs.rm(audit, { recursive: true });
    await expect(h.host.before(beforeEvent(h.sessionID))).rejects.toThrow(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
    );
    expect((await readState(h.sessDir))!.mutationEpisodes).toEqual([]);
    await expect(h.host.before(beforeEvent('unrelated-inactive'))).resolves.toBeUndefined();
  });

  async function enrolledChild(h: Awaited<ReturnType<typeof fixture>>, agent = 'general') {
    const childId = crypto.randomUUID();
    h.host.sessionGet.mockImplementation(async ({ sessionID }) => ({
      id: sessionID,
      location: { directory: h.ws.tmpDir },
      ...(sessionID === childId ? { parentID: h.sessionID, agent } : {}),
    }));
    const dispatch = beforeEvent(h.sessionID, 'subagent', { agent: 'general', prompt: 'inspect' });
    await h.host.before(dispatch);
    const pending = h.host.before(beforeEvent(childId, 'read', { filePath: 'README.md' }, 'r'));
    h.host.emit({
      type: 'session.tool.progress',
      id: 'receipt',
      data: {
        sessionID: h.sessionID,
        assistantMessageID: dispatch.messageID,
        id: dispatch.id,
        metadata: { sessionID: childId, status: 'running' },
      },
    });
    return { childId, pending };
  }

  it('fences the verified root scope when a delegated child error cannot be audited', async () => {
    const h = await fixture('PLAN');
    const { childId, pending } = await enrolledChild(h);
    await pending;
    const audit = path.join(h.sessDir, 'audit.jsonl');
    await fs.rm(audit, { force: true });
    await fs.mkdir(audit);
    h.host.emit({
      type: 'session.execution.failed',
      id: 'child-failure',
      data: { sessionID: childId, error: { type: 'provider', message: 'child failed' } },
    });
    await vi.waitFor(async () =>
      expect(h.host.before(beforeEvent(h.sessionID))).rejects.toThrow(
        'lost required event observation',
      ),
    );
    await expect(h.host.before(beforeEvent(childId))).rejects.toThrow(
      'lost required event observation',
    );
    await expect(h.host.before(beforeEvent('unrelated-inactive'))).resolves.toBeUndefined();
  });

  it('fences the parent root, not unrelated sessions, when native enrollment itself fails', async () => {
    const h = await fixture('PLAN');
    // The host child reports a different agent than the authorized dispatch.
    const { childId, pending } = await enrolledChild(h, 'explore');
    await expect(pending).rejects.toThrow('GOVERNANCE_AUTHORITY_BLOCKED');
    expect(await resolveGovernanceActivation(h.host.activation.store, childId)).toMatchObject({
      kind: 'inactive',
    });
    await vi.waitFor(async () =>
      expect(h.host.before(beforeEvent(h.sessionID))).rejects.toThrow(
        'lost required event observation',
      ),
    );
    await expect(h.host.before(beforeEvent('unrelated-inactive'))).resolves.toBeUndefined();
  });

  it('admits an ordinary native subagent in PLAN without authorizing a host mutation or skipping the review boundary', async () => {
    const h = await fixture('PLAN');
    await h.host.before(
      beforeEvent(h.sessionID, 'subagent', { agent: 'general', prompt: 'inspect' }),
    );
    expect(
      h.host.activation.values.has(governanceDelegationKey(h.sessionID, 'message', 'c1')),
    ).toBe(true);
    expect((await readState(h.sessDir))!.mutationEpisodes).toEqual([]);
    await expect(
      h.host.before(
        beforeEvent(h.sessionID, 'subagent', { agent: 'flowguard-reviewer' }, 'review'),
      ),
    ).rejects.toThrow('REVIEWER_EXECUTION_OUTCOME_UNKNOWN');
    expect(h.host.prompt).not.toHaveBeenCalled();
    await expect(
      h.host.before(beforeEvent(h.sessionID, 'task', { agent: 'general' }, 'obsolete')),
    ).rejects.toThrow('HOST_TOOL_UNKNOWN_DENIED');
  });

  it('does not publish dispatch authorization when audit reconciliation blocks a subagent', async () => {
    const h = await pendingTransition();
    await fs.writeFile(path.join(h.sessDir, 'audit.jsonl'), '{ malformed json\n');
    await expect(
      h.host.before(beforeEvent(h.sessionID, 'subagent', { agent: 'general' })),
    ).rejects.toThrow('AUDIT_PERSISTENCE_FAILED');
    expect(
      h.host.activation.values.has(governanceDelegationKey(h.sessionID, 'message', 'c1')),
    ).toBe(false);
  });

  it('enrolls only the exact native parent-call receipt and applies the root phase gate to child effects', async () => {
    const h = await fixture('PLAN');
    const childId = crypto.randomUUID();
    h.host.sessionGet.mockImplementation(async ({ sessionID }) => ({
      id: sessionID,
      location: { directory: h.ws.tmpDir },
      ...(sessionID === childId ? { parentID: h.sessionID, agent: 'general' } : {}),
    }));
    const dispatch = beforeEvent(h.sessionID, 'subagent', { agent: 'general', prompt: 'inspect' });
    await h.host.before(dispatch);
    const pending = h.host.before(
      beforeEvent(childId, 'read', { filePath: 'README.md' }, 'child-read'),
    );
    h.host.emit({
      type: 'session.tool.progress',
      id: 'receipt',
      data: {
        sessionID: h.sessionID,
        assistantMessageID: dispatch.messageID,
        id: dispatch.id,
        metadata: { sessionID: childId, status: 'running' },
      },
    });
    await pending;
    expect(await resolveGovernanceActivation(h.host.activation.store, childId)).toMatchObject({
      kind: 'active',
      record: { rootSessionId: h.sessionID },
    });
    await expect(
      h.host.definitions.get('flowguard_help')!.execute(
        { view: 'context' },
        {
          sessionID: childId,
          messageID: 'child-help',
          agent: 'general',
          id: 'help',
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({ content: expect.any(String), metadata: {} });
    await expect(h.host.before(beforeEvent(childId))).rejects.toThrow('HOST_TOOL_PHASE_DENIED');
    await expect(
      h.host.before(beforeEvent(childId, 'flowguard_plan', { reviewVerdict: 'accept' })),
    ).rejects.toThrow('GOVERNANCE_AUTHORITY_BLOCKED');
    await expect(
      h.host.definitions.get('flowguard_status')!.execute(
        {},
        {
          sessionID: childId,
          messageID: 'child-direct',
          agent: 'general',
          id: 'direct',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow('Delegated host execution does not authorize parent workflow decisions');
    for (const hook of ['context', 'compaction', 'generate']) {
      const view = {
        sessionID: childId,
        agent: 'general',
        tools: { flowguard_plan: {}, flowguard_help: {}, read: {} },
        messages: [],
        system: [],
      };
      await h.host.sessionHooks.get(hook)!(view);
      expect(view.tools).toEqual({ flowguard_help: {}, read: {} });
    }
    expect((await readState(h.sessDir))!.mutationEpisodes).toEqual([]);
  });
});
