/** Native EndGovernance and RecoverCapacity composition over real host state. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FlowGuardAuditPlugin } from './plugin.js';
import { createV2Host } from './opencode-v2-test-helpers.js';
import { createTestWorkspace, type TestWorkspace } from './test-helpers.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import { resolveGovernanceActivation } from '../adapters/governance-activation.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import * as audit from '../adapters/persistence-audit.js';
import { verifyChain } from '../audit/integrity.js';
import { makeState } from '../fixtures.js';
import { writeStateWithArtifacts } from './tools/helpers.js';
import { ensureReviewAssurance } from '../state/review-dispatch.js';
import {
  appendObligationWithAttempt,
  artifactReviewSubjectScope,
  createReviewObligation,
  freezeReviewMaterial,
} from './review/obligations/assurance.js';
import { updateAttemptStatus } from './review/obligations/attempt-lifecycle.js';
import {
  abandonAndBlockByHostCall,
  persistAuthorizedReviewDispatch,
  type DispatchLedgerWriteDeps,
} from './review/dispatch/durable-dispatch.js';
import { governanceEndBlocker } from './governance-end-preconditions.js';
import { addCheckCommand, executeCheckCommand } from './plugin-check-command.js';
import { getInstalledCommand } from './installed-commands.js';

const NOW = '2026-11-03T12:00:00.000Z';

function checkHarness(rootSessionId = 'check-session') {
  const scopes = new Map<string, 'check'>();
  const runtime = { activeCommandScopes: scopes, checkReworkContinuations: new Map() };
  const ctx = {
    session: {
      get: vi.fn(async () => ({ agent: 'plan' })),
      switchAgent: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({ id: 'prompt', type: 'prompt' })),
      wait: vi.fn(async () => {}),
    },
  };
  const deps = {
    guard: <T>(run: () => Promise<T>) => run(),
    invoke: vi.fn(
      async (_id: string, action: (entry: unknown) => Promise<unknown>, _required: boolean) =>
        action({
          runtime,
          scope: { sessionId: 'check-session', root: { sessionId: rootSessionId } },
        }),
    ),
  };
  return { scopes, ctx, deps };
}
let ws: TestWorkspace;
let host: ReturnType<typeof createV2Host>;
let cleanup: (() => void | Promise<void>) | undefined;
let sessionID: string;

beforeEach(async () => {
  ws = await createTestWorkspace();
  host = createV2Host(ws.tmpDir);
  sessionID = randomUUID();
  cleanup = (await FlowGuardAuditPlugin.setup(host.ctx)) || undefined;
  await host.command('start', sessionID);
});
afterEach(async () => {
  try {
    await cleanup?.();
  } finally {
    vi.restoreAllMocks();
    await ws.cleanup();
  }
});

async function workflow() {
  const bound = await resolveSessionAuthority({ root: ws.tmpDir, sessionId: sessionID });
  if (bound.status !== 'resolved') throw new Error('Expected workflow');
  return bound;
}

async function seedState(state: ReturnType<typeof makeState>) {
  const bound = await workflow();
  await writeStateWithArtifacts(bound.sessDir, {
    ...state,
    id: bound.state.id,
    flowguardSessionId: bound.state.flowguardSessionId,
    binding: bound.state.binding,
    policySnapshot: bound.state.policySnapshot,
  });
}

async function capacityLockedState(code = 'REVIEWER_STEP_BUDGET_EXHAUSTED') {
  const obligation = createReviewObligation({
    obligationType: 'plan',
    reviewCycle: 1,
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'subject-digest-1',
    reviewMaterial: freezeReviewMaterial('frozen review material', 'subject-digest-1'),
    reviewSubjectScope: artifactReviewSubjectScope('plan', '# Plan\nBody', 'subject-digest-1'),
    repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
  });
  const minted = appendObligationWithAttempt(ensureReviewAssurance(undefined), obligation, NOW);
  const stateRef = { current: makeState('PLAN', { reviewAssurance: minted.assurance }) };
  const childSessionId = `child-${randomUUID()}`;
  const deps: DispatchLedgerWriteDeps = {
    updateReviewAssurance: vi.fn(async (_dir, update) => {
      stateRef.current = update(stateRef.current, NOW);
    }),
  };
  const hostCallId = `call-${randomUUID()}`;
  await persistAuthorizedReviewDispatch(deps, '/tmp/capacity', {
    attemptId: minted.attemptId,
    obligationId: obligation.obligationId,
    hostCallId,
    canonicalPromptDigest: 'b'.repeat(64),
    authorizedAt: NOW,
  });
  stateRef.current = {
    ...stateRef.current,
    reviewAssurance: updateAttemptStatus(
      ensureReviewAssurance(stateRef.current.reviewAssurance),
      minted.attemptId,
      'created',
      NOW,
      { childSessionId },
    ),
  };
  await abandonAndBlockByHostCall(deps, '/tmp/capacity', hostCallId, code, {
    childSessionId,
    obligationId: obligation.obligationId,
    attemptId: minted.attemptId,
  });
  return stateRef.current;
}

function lifecycleEvents(events: Awaited<ReturnType<typeof readAuditTrail>>) {
  return events.filter(
    (event) => event.event === 'governance:ended' || event.event === 'review:capacity_recovered',
  );
}

describe('native governance lifecycle commands', () => {
  it('ends ACTIVE governance only after terminal workflow closure and audits the exact decision once', async () => {
    await seedState(makeState('ABORTED'));
    const before = await workflow();
    await host.command('end-governance', sessionID);
    const notice = (await host.presentation(sessionID)).events.at(-1);
    expect(notice).toMatchObject({ kind: 'notice' });
    expect(notice?.message).toContain('governance is INACTIVE');
    expect(host.ctx.session.prompt).not.toHaveBeenCalled();
    expect(await resolveGovernanceActivation(host.activation.store, sessionID)).toMatchObject({
      kind: 'inactive',
      record: { status: 'inactive', decisionSource: 'host_command' },
    });
    const events = await readAuditTrail(before.sessDir);
    expect(lifecycleEvents(events)).toMatchObject([
      {
        event: 'governance:ended',
        detail: { channel: 'host_command', generation: 1, rootSessionId: sessionID },
      },
    ]);
    expect(verifyChain(events).valid).toBe(true);
    await host.command('end-governance', sessionID);
    expect(lifecycleEvents(await readAuditTrail(before.sessDir))).toHaveLength(1);
  });

  it('reconciles a pending End audit before reactivation and preserves audit order', async () => {
    await seedState(makeState('READY'));
    const before = await workflow();
    const append = audit.appendAuditEventAlreadyLocked;
    const fault = vi
      .spyOn(audit, 'appendAuditEventAlreadyLocked')
      .mockImplementation(async (directory, event) => {
        if (event.event === 'governance:ended') throw new Error('end audit append failure');
        return append(directory, event);
      });
    await expect(host.command('end-governance', sessionID)).rejects.toThrow(
      'GOVERNANCE_AUTHORITY_BLOCKED',
    );
    fault.mockRestore();
    await host.command('start', sessionID);
    expect(await resolveGovernanceActivation(host.activation.store, sessionID)).toMatchObject({
      kind: 'active',
      record: { generation: 2 },
    });
    const events = await readAuditTrail(before.sessDir);
    const ended = events.findIndex((event) => event.event === 'governance:ended');
    const reactivated = events.findIndex(
      (event, index) => index > ended && event.event === 'governance:activated',
    );
    expect(ended).toBeGreaterThanOrEqual(0);
    expect(reactivated).toBeGreaterThan(ended);
  });

  it('refuses to end non-terminal or otherwise unsafe workflow state', async () => {
    await seedState(makeState('TICKET'));
    await expect(host.command('end-governance', sessionID)).rejects.toThrow(
      'GOVERNANCE_END_UNSAFE',
    );
    expect(await resolveGovernanceActivation(host.activation.store, sessionID)).toMatchObject({
      kind: 'active',
    });
  });

  it('keeps INACTIVE durable when the End audit append fails and reconciles it on retry', async () => {
    await seedState(makeState('ABORTED'));
    const append = audit.appendAuditEventAlreadyLocked;
    const fault = vi
      .spyOn(audit, 'appendAuditEventAlreadyLocked')
      .mockImplementation(async (directory, event) => {
        if (event.event === 'governance:ended') throw new Error('end audit append failure');
        return append(directory, event);
      });
    await expect(host.command('end-governance', sessionID)).rejects.toThrow(
      'GOVERNANCE_AUTHORITY_BLOCKED',
    );
    expect(await resolveGovernanceActivation(host.activation.store, sessionID)).toMatchObject({
      kind: 'inactive',
    });
    fault.mockRestore();
    await host.command('end-governance', sessionID);
    expect(lifecycleEvents(await readAuditTrail((await workflow()).sessDir))).toMatchObject([
      { event: 'governance:ended' },
    ]);
  });

  it('reports a capacity lock as an End blocker even after terminal workflow closure', async () => {
    const capacity = await capacityLockedState();
    expect(
      governanceEndBlocker(makeState('ABORTED', { reviewAssurance: capacity.reviewAssurance })),
    ).toMatchObject({ code: 'REVIEW_CAPACITY_REQUIRES_NEW_USER_COMMAND' });
    expect(governanceEndBlocker(makeState('READY'))).toBeNull();
  });

  it('releases a proven terminal closure lock and refuses an unknown outcome', async () => {
    const capacity = await capacityLockedState();
    await seedState(capacity);
    const before = await workflow();
    await host.command('recover-capacity', sessionID);
    const released = await workflow();
    expect(released.state.reviewAssurance?.capacityLock).toBeNull();
    expect(released.state.reviewAssurance?.obligations[0]).toMatchObject({
      status: 'blocked',
      blockedCode: 'REVIEWER_STEP_BUDGET_EXHAUSTED',
    });
    expect(lifecycleEvents(await readAuditTrail(before.sessDir))).toMatchObject([
      {
        event: 'review:capacity_recovered',
        detail: {
          priorBlockedCode: 'REVIEWER_STEP_BUDGET_EXHAUSTED',
          operation: { source: 'host_command', obligationId: expect.any(String) },
        },
      },
    ]);
    await expect(host.command('recover-capacity', sessionID)).rejects.toThrow(
      'REVIEW_CAPACITY_NOT_LOCKED',
    );

    const unknown = await capacityLockedState('REVIEWER_EXECUTION_OUTCOME_UNKNOWN');
    await seedState(unknown);
    await expect(host.command('recover-capacity', sessionID)).rejects.toThrow(
      'REVIEW_CAPACITY_RECOVERY_UNSAFE',
    );
    expect((await workflow()).state.reviewAssurance?.capacityLock?.code).toBe(
      'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    );
  });
  it('binds the explicit check scope to the native command and restores the agent', async () => {
    const sessionId = 'check-session';
    const scopes = new Map<string, 'check'>();
    const rework = new Map([[sessionId, { marker: true }]]);
    const runtime = { activeCommandScopes: scopes, checkReworkContinuations: rework };
    const switchAgent = vi.fn(async () => {});
    const prompt = vi.fn(async () => {
      expect(scopes.get(sessionId)).toBe('check');
      return { id: 'prompt', type: 'prompt' };
    });
    const wait = vi.fn(async () => {});
    const ctx = {
      session: {
        get: vi.fn(async () => ({ agent: 'plan' })),
        switchAgent,
        prompt,
        wait,
      },
    } as never;
    const deps = {
      guard: <T>(run: () => Promise<T>) => run(),
      invoke: async (
        _id: string,
        action: (entry: { runtime: unknown; scope: unknown }) => Promise<unknown>,
      ) => action({ runtime, scope: { sessionId, root: { sessionId } } }),
    } as never;
    await executeCheckCommand(ctx, deps, sessionId);
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: sessionId,
        text: expect.stringContaining('flowguard_run_check'),
      }),
    );
    expect(switchAgent).toHaveBeenNthCalledWith(1, { sessionID: sessionId, agent: 'build' });
    expect(switchAgent).toHaveBeenNthCalledWith(2, { sessionID: sessionId, agent: 'plan' });
    expect(scopes.has(sessionId)).toBe(false);
    expect(rework.has(sessionId)).toBe(false);
  });

  it('keeps the check scope cleanup durable when restoring the previous agent fails', async () => {
    const sessionId = 'check-restore-session';
    const scopes = new Map<string, 'check'>();
    const runtime = { activeCommandScopes: scopes, checkReworkContinuations: new Map() };
    const switchAgent = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('agent restore failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = {
      session: {
        get: vi.fn(async () => ({ agent: 'plan' })),
        switchAgent,
        prompt: vi.fn(async () => ({ id: 'prompt', type: 'prompt' })),
        wait: vi.fn(async () => {}),
      },
    } as never;
    const deps = {
      guard: <T>(run: () => Promise<T>) => run(),
      invoke: async (
        _id: string,
        action: (entry: { runtime: unknown; scope: unknown }) => Promise<unknown>,
      ) => action({ runtime, scope: { sessionId, root: { sessionId } } }),
    } as never;
    await expect(executeCheckCommand(ctx, deps, sessionId)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not restore the previous agent'),
      expect.any(Error),
    );
    expect(scopes.has(sessionId)).toBe(false);
  });

  it('registers check from the native catalogue without routing it through a tool alias', () => {
    const h = checkHarness();
    const add = vi.fn();
    addCheckCommand(h.ctx as never, h.deps as never, { add });
    expect(add).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        name: getInstalledCommand('/check')?.target.nativeCommand,
        description: `FlowGuard — ${getInstalledCommand('/check')?.description}`,
        execute: expect.any(Function),
      }),
    );
    expect(h.deps.invoke).not.toHaveBeenCalled();
  });

  it('does not grant native check authority to a delegated child', async () => {
    const h = checkHarness('parent-session');
    await expect(
      executeCheckCommand(h.ctx as never, h.deps as never, 'check-session'),
    ).rejects.toThrow('A delegated child cannot run the root /check command.');
    expect(h.scopes.size).toBe(0);
    expect(h.ctx.session.get).not.toHaveBeenCalled();
    expect(h.ctx.session.prompt).not.toHaveBeenCalled();
  });

  it('requires ACTIVE callback admission before touching the agent or check scope', async () => {
    const h = checkHarness();
    h.deps.invoke.mockRejectedValueOnce(
      Object.assign(new Error('inactive scope'), { code: 'GOVERNANCE_AUTHORITY_BLOCKED' }),
    );
    await expect(
      executeCheckCommand(h.ctx as never, h.deps as never, 'check-session'),
    ).rejects.toMatchObject({ code: 'GOVERNANCE_AUTHORITY_BLOCKED' });
    expect(h.deps.invoke).toHaveBeenCalledWith('check-session', expect.any(Function), true);
    expect(h.scopes.size).toBe(0);
    expect(h.ctx.session.get).not.toHaveBeenCalled();
    expect(h.ctx.session.prompt).not.toHaveBeenCalled();
  });

  it.each(['prompt', 'wait'] as const)(
    'cleans check scope and restores the agent if %s fails',
    async (operation) => {
      const h = checkHarness();
      h.ctx.session[operation].mockRejectedValueOnce(new Error('check turn failed'));
      await expect(
        executeCheckCommand(h.ctx as never, h.deps as never, 'check-session'),
      ).rejects.toThrow('check turn failed');
      expect(h.scopes.size).toBe(0);
      expect(h.ctx.session.switchAgent).toHaveBeenNthCalledWith(1, {
        sessionID: 'check-session',
        agent: 'build',
      });
      expect(h.ctx.session.switchAgent).toHaveBeenNthCalledWith(2, {
        sessionID: 'check-session',
        agent: 'plan',
      });
    },
  );
});
