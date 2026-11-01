/** Native V2 completion registration through real persistence/audit. Seeded state
 * tests audit projection only, not operator attribution or installed-host proof. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  canonicalBinding,
  createTestWorkspace,
  GIT_MOCK_DEFAULTS,
  type TestWorkspace,
} from './test-helpers.js';
import { createV2Host, v2ToolEvent } from './opencode-v2-test-helpers.js';
import { PERF_ENABLED } from '../test-policy.js';
import { FlowGuardAuditPlugin } from './plugin.js';
import { readState, writeState } from '../adapters/persistence.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import { writeStateWithArtifactsAndAuditOperations } from './tools/helpers.js';
import {
  initWorkspace,
  computeFingerprint,
  sessionDir as resolveSessionDir,
  workspacesHome,
} from '../adapters/workspace/index.js';
import { verifyChain } from '../audit/integrity.js';
import { makeState, makeProgressedState, POLICY_SNAPSHOT } from '../fixtures.js';
import { Transition, type Phase, type SessionState } from '../state/schema.js';

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
  };
});

let ws: TestWorkspace;
let sessionId: string;
let sessDir: string;
let fingerprint: string;
let host: ReturnType<typeof createV2Host>;
const cleanups: Array<() => void | Promise<void>> = [];

async function openHost(
  directory: string,
  activeSession = sessionId,
  digest = POLICY_SNAPSHOT.hash,
) {
  const native = createV2Host(directory);
  await native.seedActive(activeSession, digest);
  const dispose = await FlowGuardAuditPlugin.setup(native.ctx);
  if (dispose) cleanups.push(dispose);
  return native;
}

beforeEach(async () => {
  ws = await createTestWorkspace();
  sessionId = `ses_${crypto.randomUUID().replace(/-/g, '')}`;
  fingerprint = (await computeFingerprint(ws.tmpDir)).fingerprint;
  await initWorkspace(ws.tmpDir, sessionId);
  sessDir = resolveSessionDir(fingerprint, sessionId);
  await writeState(
    sessDir,
    makeState('TICKET', {
      binding: await canonicalBinding(ws.tmpDir, sessionId),
      policySnapshot: {
        ...POLICY_SNAPSHOT,
        mode: 'team',
        requestedMode: 'team',
        effectiveGateBehavior: 'human_gated',
        requireHumanGates: true,
        reviewBudget: { plan: 3, architecture: 3, implementation: 3 },
        allowSelfApproval: true,
        actorClassification: { flowguard_decision: 'human' },
      },
    }),
  );
  host = await openHost(ws.tmpDir);
});

afterEach(async () => {
  try {
    for (const dispose of cleanups.splice(0)) await dispose();
  } finally {
    vi.clearAllMocks();
    await ws.cleanup();
  }
});

function eventKind(event: { detail: Record<string, unknown>; event: string }): string {
  return (event.detail.kind as string) ?? event.event.split(':')[0];
}

function output(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ phase: 'TICKET', status: 'ok', ...fields });
}

/** Build one native completion event, not a V1 hook-input/output adapter. */
function completion(tool: string, content: string, sid = sessionId) {
  return {
    ...v2ToolEvent({ tool, sessionID: sid, id: crypto.randomUUID(), input: {} }),
    status: 'completed',
    result: { content, metadata: {} },
  };
}

async function persistTransition(
  transition: { from: string; to: string; event: string; at: string },
  state?: SessionState,
) {
  const current = (await readState(sessDir))!;
  const persisted = Transition.parse(transition);
  const base = state ?? makeState(transition.to as Phase, { id: current.id });
  await writeStateWithArtifactsAndAuditOperations(
    sessDir,
    {
      ...base,
      id: current.id,
      flowguardSessionId: current.id,
      binding: current.binding,
      policySnapshot: current.policySnapshot,
      transition: persisted,
    },
    [transition],
  );
}

describe('native V2 plugin audit integration', () => {
  describe('HAPPY', () => {
    it('persists exactly one tool_call for a FlowGuard completion', async () => {
      await host.after(completion('flowguard_status', output()));
      const events = await readAuditTrail(sessDir);
      const calls = events.filter((e) => eventKind(e) === 'tool_call');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.event).toBe('tool_call:flowguard_status');
    });

    it('does not materialize workflow state for an unhydrated child completion', async () => {
      const child = `ses_${crypto.randomUUID()}`;
      await host.after(completion('flowguard_abort_session', output({ phase: 'unknown' }), child));
      await expect(fs.stat(resolveSessionDir(fingerprint, child))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('persists canonical transitions rather than trusting the tool output', async () => {
      await persistTransition({
        from: 'TICKET',
        to: 'PLAN',
        event: 'PLAN_READY',
        at: new Date().toISOString(),
      });
      await host.after(completion('flowguard_plan', output({ phase: 'PLAN' })));
      const transitions = (await readAuditTrail(sessDir)).filter(
        (e) => eventKind(e) === 'transition',
      );
      expect(transitions).toHaveLength(1);
      expect(transitions[0]!.event).toBe('transition:PLAN_READY');
    });

    it('emits session_created for hydrate of an existing bound session', async () => {
      await host.after(
        completion(
          'flowguard_hydrate',
          output({
            _audit: {
              transitions: [
                {
                  from: 'INIT',
                  to: 'TICKET',
                  event: 'SESSION_BOUND',
                  at: new Date().toISOString(),
                },
              ],
            },
          }),
        ),
      );
      expect((await readAuditTrail(sessDir)).some((e) => e.event.includes('session_created'))).toBe(
        true,
      );
    });

    it('emits session_completed on a persisted COMPLETE transition without team archival', async () => {
      const state = (await readState(sessDir))!;
      await writeState(sessDir, {
        ...makeProgressedState('EVIDENCE_REVIEW'),
        binding: state.binding,
        policySnapshot: state.policySnapshot,
      });
      await persistTransition(
        { from: 'EVIDENCE_REVIEW', to: 'COMPLETE', event: 'APPROVE', at: new Date().toISOString() },
        makeProgressedState('COMPLETE'),
      );
      await host.after(completion('flowguard_decision', output({ phase: 'COMPLETE' })));
      expect(
        (await readAuditTrail(sessDir)).some((e) => e.event.includes('session_completed')),
      ).toBe(true);
      await expect(
        fs.stat(
          path.join(workspacesHome(), fingerprint, 'sessions', 'archive', `${sessionId}.tar.gz`),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('projects actor classification from the frozen policy, not a native event claim', async () => {
      await host.after(completion('flowguard_decision', output({ phase: 'VALIDATION' })));
      expect((await readAuditTrail(sessDir)).find((e) => eventKind(e) === 'tool_call')!.actor).toBe(
        'human',
      );
    });

    it('keeps deciding actor identity separate from the transition principal', async () => {
      const initiator = {
        id: 'alice-initiator',
        email: 'alice@example.com',
        source: 'env' as const,
        assurance: 'best_effort' as const,
      };
      const reviewer = {
        actorId: 'bob-reviewer',
        actorEmail: 'bob@example.com',
        actorSource: 'oidc' as const,
        actorAssurance: 'idp_verified' as const,
      };
      const current = (await readState(sessDir))!;
      await persistTransition(
        { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', at: new Date().toISOString() },
        {
          ...current,
          actorInfo: initiator,
          reviewDecision: {
            verdict: 'approve',
            rationale: 'four eyes satisfied',
            decidedAt: new Date().toISOString(),
            decisionIdentity: reviewer,
          },
        },
      );
      await host.after(completion('flowguard_decision', output({ phase: 'PLAN' })));
      const events = await readAuditTrail(sessDir);
      const call = events.find(
        (e) => eventKind(e) === 'tool_call' && e.detail.tool === 'flowguard_decision',
      )!;
      expect(call.actor).toBe('human');
      expect(call.actorInfo).toEqual({
        id: 'bob-reviewer',
        email: 'bob@example.com',
        source: 'oidc',
        assurance: 'idp_verified',
      });
      const transition = events.find((e) => eventKind(e) === 'transition')!;
      expect(transition.actor).toBe('machine');
      expect(transition.actorInfo).toEqual(initiator);
      expect(call.actorInfo?.id).not.toBe(transition.actorInfo?.id);
    });

    it('does not attribute a blocked decision to a previous reviewer or the initiator', async () => {
      await writeState(sessDir, {
        ...(await readState(sessDir))!,
        actorInfo: {
          id: 'alice',
          email: 'alice@example.com',
          source: 'env',
          assurance: 'best_effort',
        },
        reviewDecision: {
          verdict: 'approve',
          rationale: 'previous decision',
          decidedAt: new Date().toISOString(),
          decisionIdentity: {
            actorId: 'bob',
            actorEmail: 'bob@example.com',
            actorSource: 'oidc',
            actorAssurance: 'idp_verified',
          },
        },
      });
      await host.after(
        completion('flowguard_decision', output({ error: true, errorMessage: 'blocked' })),
      );
      const call = (await readAuditTrail(sessDir)).find(
        (e) => eventKind(e) === 'tool_call' && e.detail.tool === 'flowguard_decision',
      )!;
      expect(call).toBeDefined();
      expect(call.actorInfo).toBeUndefined();
    });

    it('keeps policy-resolution detail on the session_created diagnostic', async () => {
      await host.after(
        completion(
          'flowguard_hydrate',
          output({
            phase: 'READY',
            policyResolution: {
              requestedMode: 'team-ci',
              effectiveMode: 'team',
              source: 'repo',
              effectiveGateBehavior: 'human_gated',
              reason: 'ci_context_missing',
            },
          }),
        ),
      );
      const event = (await readAuditTrail(sessDir)).find(
        (e) => e.event === 'lifecycle:session_created',
      )!;
      expect(event).toBeDefined();
      for (const detail of [
        'requested_mode:team-ci',
        'effective_mode:team',
        'source:repo',
        'reason:ci_context_missing',
      ])
        expect(String(event.detail.reason)).toContain(detail);
    });
  });

  describe('BAD', () => {
    it('does not invent FlowGuard audit events for native shell completions', async () => {
      await host.after(completion('shell', 'some output'));
      expect(await readAuditTrail(sessDir)).toHaveLength(0);
    });

    it('records a tool_call even when the result is not valid JSON', async () => {
      await host.after(completion('flowguard_status', 'not valid json {{'));
      expect((await readAuditTrail(sessDir)).length).toBeGreaterThanOrEqual(1);
    });

    it('fails explicitly when the host session location cannot resolve a worktree', async () => {
      const badHost = await openHost('/nonexistent/path', 'fake');
      await expect(
        badHost.after(completion('flowguard_status', '{}', 'fake')),
      ).rejects.toHaveProperty('code');
      expect(await readAuditTrail(sessDir)).toHaveLength(0);
    });
  });

  describe('CORNER', () => {
    it('retains valid chain linkage across five native completions', async () => {
      for (let i = 0; i < 5; i++) await host.after(completion('flowguard_status', output()));
      const events = await readAuditTrail(sessDir);
      expect(events).toHaveLength(5);
      expect(verifyChain(events)).toMatchObject({ valid: true, verifiedCount: 5 });
    });

    it('uses solo snapshot chain policy while still writing events', async () => {
      const current = (await readState(sessDir))!;
      await writeState(
        sessDir,
        makeState('TICKET', {
          ...current,
          policySnapshot: {
            ...current.policySnapshot,
            mode: 'solo',
            requestedMode: 'solo',
            effectiveGateBehavior: 'auto_approve',
            requireHumanGates: false,
            reviewBudget: { plan: 1, architecture: 1, implementation: 1 },
            audit: { ...POLICY_SNAPSHOT.audit, enableChainHash: false },
            actorClassification: { flowguard_decision: 'system' },
          },
        }),
      );
      const solo = await openHost(
        ws.tmpDir,
        sessionId,
        (await readState(sessDir))!.policySnapshot.hash,
      );
      await solo.after(completion('flowguard_status', output()));
      await solo.after(completion('flowguard_ticket', output()));
      const events = await readAuditTrail(sessDir);
      expect(events).toHaveLength(2);
      expect(events[0]!.chainHash).toBeTruthy();
      expect(events[1]!.chainHash).toBeTruthy();
    });

    it('honors frozen emitToolCalls=false while still reconciling a transition', async () => {
      const current = (await readState(sessDir))!;
      await writeState(
        sessDir,
        makeState('TICKET', {
          ...current,
          policySnapshot: {
            ...current.policySnapshot,
            audit: { ...POLICY_SNAPSHOT.audit, emitToolCalls: false },
          },
        }),
      );
      await persistTransition({
        from: 'TICKET',
        to: 'PLAN',
        event: 'PLAN_READY',
        at: new Date().toISOString(),
      });
      const custom = await openHost(
        ws.tmpDir,
        sessionId,
        (await readState(sessDir))!.policySnapshot.hash,
      );
      await custom.after(completion('flowguard_plan', output({ phase: 'PLAN' })));
      const events = await readAuditTrail(sessDir);
      expect(events.filter((e) => eventKind(e) === 'tool_call')).toHaveLength(0);
      expect(events.filter((e) => eventKind(e) === 'transition')).toHaveLength(1);
    });
  });

  describe('EDGE', () => {
    it('emits the canonical tool failure error event', async () => {
      await host.after(
        completion(
          'flowguard_plan',
          output({ error: true, errorMessage: 'Plan submission failed: empty plan' }),
        ),
      );
      const errors = (await readAuditTrail(sessDir)).filter((e) => eventKind(e) === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]!.event).toContain('TOOL_ERROR');
    });

    it('keeps independent native plugin/session chain states separate', async () => {
      const sid = crypto.randomUUID();
      await initWorkspace(ws.tmpDir, sid);
      const secondDir = resolveSessionDir(fingerprint, sid);
      await writeState(
        secondDir,
        makeState('TICKET', {
          binding: await canonicalBinding(ws.tmpDir, sid),
          policySnapshot: (await readState(sessDir))!.policySnapshot,
        }),
      );
      const second = await openHost(ws.tmpDir, sid);
      await host.after(completion('flowguard_status', output()));
      await second.after(completion('flowguard_status', output(), sid));
      const firstTrail = await readAuditTrail(sessDir);
      const secondTrail = await readAuditTrail(secondDir);
      expect(firstTrail).toHaveLength(1);
      expect(secondTrail).toHaveLength(1);
      expect(firstTrail[0]!.chainHash).not.toBe(secondTrail[0]!.chainHash);
    });

    it('hydrate emits session_created, never session_completed', async () => {
      await host.after(
        completion(
          'flowguard_hydrate',
          output({
            _audit: {
              transitions: [
                {
                  from: 'INIT',
                  to: 'TICKET',
                  event: 'SESSION_BOUND',
                  at: new Date().toISOString(),
                },
              ],
            },
          }),
        ),
      );
      const events = await readAuditTrail(sessDir);
      expect(events.some((e) => e.event.includes('session_created'))).toBe(true);
      expect(events.some((e) => e.event.includes('session_completed'))).toBe(false);
    });

    it('abort emits session_aborted, never session_completed', async () => {
      await host.after(
        completion(
          'flowguard_abort_session',
          output({
            phase: 'COMPLETE',
            _audit: {
              transitions: [
                {
                  from: 'TICKET',
                  to: 'COMPLETE',
                  event: 'SESSION_ABORTED',
                  at: new Date().toISOString(),
                },
              ],
            },
          }),
        ),
      );
      const events = await readAuditTrail(sessDir);
      expect(events.some((e) => e.event.includes('session_aborted'))).toBe(true);
      expect(events.some((e) => e.event.includes('session_completed'))).toBe(false);
    });
  });

  describe.skipIf(!PERF_ENABLED)('PERF', () => {
    it('1000 non-mutating non-FlowGuard tool calls stay on the near-instant path', async () => {
      const callOnce = async () => {
        const start = performance.now();
        for (let i = 0; i < 1000; i++) await host.after(completion('read', ''));
        return performance.now() - start;
      };
      await callOnce();
      expect(Math.min(await callOnce(), await callOnce(), await callOnce())).toBeLessThan(150);
    });

    it('10 FlowGuard tool calls with persistence complete reasonably', async () => {
      const start = performance.now();
      for (let i = 0; i < 10; i++) await host.after(completion('flowguard_status', output()));
      expect(performance.now() - start).toBeLessThan(5000);
    });
  });
});
