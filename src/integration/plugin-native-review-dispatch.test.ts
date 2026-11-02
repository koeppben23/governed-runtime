/** Real ledger/journal persistence with native-hook-shaped component inputs.
 * Does not certify capture, host execution or recovery. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenCodeEvent } from '@opencode/client';
import type { SessionPrompt, SessionModelRequest } from '@opencode/plugin/promise/session';
import { readState, writeState } from '../adapters/persistence.js';
import {
  resolveGovernanceActivation,
  governanceDelegationKey,
} from '../adapters/governance-activation.js';
import { createTestWorkspace, type TestWorkspace } from './test-helpers.js';
import { createWorkspace } from './plugin-workspace.js';
import { seedStrictPlanSession } from './plugin-host-task-diagnostics-test-helpers.js';
import { registerPendingReviewForAttempt } from './review/enforcement/enforcement.js';
import { createNativeReviewerAuthority } from './plugin-native-review.js';
import { OpenCodeGovernance, type NativeBefore } from './opencode-governance.js';
import { OpenCodeHostAdapter, nativeHostCallId } from './opencode-host-adapter.js';
import { createV2Host, v2ToolEvent } from './opencode-v2-test-helpers.js';
import { hashText } from '../shared/hashing.js';
import { createEventFence } from './plugin-native-events.js';
import {
  nativeReviewDispatchLineage,
  bindNativeReviewChild,
  authorizeNativeReviewDispatch,
} from './review/dispatch/native-review-dispatch.js';
import { evaluateProofGraphGate } from '../audit/proofgraph/gate.js';
import { renderPlanClaimDeclarations } from '../presentation/plan-claim-declarations.js';
import type { SessionState } from '../state/schema.js';

let ws: TestWorkspace;
let host: ReturnType<typeof createV2Host>;
let workspace: ReturnType<typeof createWorkspace>;
let reviewer: ReturnType<typeof createNativeReviewerAuthority>;
let governance: OpenCodeGovernance;
let controller: AbortController;
let seeded: Awaited<ReturnType<typeof seedStrictPlanSession>>;

beforeEach(async () => {
  ws = await createTestWorkspace();
  seeded = await seedStrictPlanSession(ws.tmpDir, 'root');
  const state = (await readState(seeded.sessDir))!;
  host = createV2Host(ws.tmpDir);
  await host.seedActive('root', state.policySnapshot.hash);
  host.sessionGet.mockImplementation(async ({ sessionID }) => ({
    id: sessionID,
    location: { directory: ws.tmpDir },
    ...(sessionID.startsWith('child') ? { parentID: 'root', agent: 'flowguard-reviewer' } : {}),
  }));
  workspace = createWorkspace({ auditWorktree: ws.tmpDir });
  const attempt = state.reviewAssurance!.attempts[0]!;
  registerPendingReviewForAttempt(
    workspace.getEnforcementState('root'),
    'flowguard_plan',
    {
      obligationId: seeded.obligationId,
      attemptId: attempt.attemptId,
    },
    new Date().toISOString(),
  );
  reviewer = createNativeReviewerAuthority(host.ctx, async () => ({ ws: workspace }) as never);
  controller = new AbortController();
  governance = new OpenCodeGovernance(
    host.ctx,
    new OpenCodeHostAdapter(host.ctx, controller.signal),
    controller.signal,
    reviewer,
  );
});
afterEach(async () => {
  controller.abort();
  vi.restoreAllMocks();
  await ws.cleanup();
});

function event(extra: Record<string, unknown> = {}, id = 'call') {
  return v2ToolEvent({
    sessionID: 'root',
    tool: 'subagent',
    id,
    input: {
      agent: 'flowguard-reviewer',
      description: 'review',
      prompt: 'UNTRUSTED AUTHOR PROMPT',
      ...extra,
    },
  }) as NativeBefore;
}
async function rootScope() {
  const result = await governance.resolve('root');
  if (result.kind !== 'active') throw new Error('Missing fixture activation');
  return result.scope;
}
function receipt(child = 'child', id = 'call', message = 'message') {
  return {
    type: 'session.tool.progress',
    id: 'receipt',
    created: 1,
    data: {
      sessionID: 'root',
      assistantMessageID: message,
      id,
      metadata: { sessionID: child, status: 'running' },
    },
  } as OpenCodeEvent;
}
async function authorizedChild(extra: Record<string, unknown> = {}) {
  const call = event(extra);
  await governance.authorizeDispatch(await rootScope(), call);
  await governance.observeProgress(receipt());
  const child = await governance.resolve('child');
  if (child.kind !== 'active') throw new Error('Missing enrolled child');
  return { call, child: child.scope };
}

describe('canonical V2 reviewer dispatch admission', () => {
  it.each([null, 'malformed', 42, []])(
    'keeps malformed event error data %j fail-closed after event-fence extraction',
    async (data) => {
      const adapter = new OpenCodeHostAdapter(host.ctx, controller.signal);
      vi.spyOn(adapter, 'log').mockImplementation(() => {});
      const fence = createEventFence(governance, adapter);
      expect(() =>
        fence.failed(new Error('event failure'), {
          type: 'session.tool.progress',
          data,
        } as unknown as OpenCodeEvent),
      ).not.toThrow();
      const scope = await rootScope();
      expect(() => fence.assert(scope)).toThrow('PLUGIN_ENFORCEMENT_UNAVAILABLE');
    },
  );
  it('persists the exact release before publishing native delegation, then binds only its observed child', async () => {
    const set = host.activation.store.set;
    const published: string[] = [];
    vi.spyOn(host.activation.store, 'set').mockImplementation(async (key, value) => {
      if (key === governanceDelegationKey('root', 'message', 'call')) {
        const state = (await readState(seeded.sessDir))!;
        expect(state.reviewAssurance!.dispatches).toMatchObject([
          {
            hostCallId: nativeHostCallId('root', 'message', 'call'),
            obligationId: seeded.obligationId,
            attemptId: state.reviewAssurance!.attempts[0]!.attemptId,
            dispatchStatus: 'authorized',
          },
        ]);
        expect(state.reviewAssurance!.attempts[0]!.childSessionId).toBeUndefined();
        published.push(key);
      }
      return set(key, value);
    });
    const { call, child } = await authorizedChild({ background: false });
    expect(published).toHaveLength(1);
    const args = call.input as Record<string, unknown>;
    expect(args).toMatchObject({ agent: 'flowguard-reviewer', background: false });
    expect(args.prompt).not.toContain('UNTRUSTED AUTHOR PROMPT');
    const state = (await readState(seeded.sessDir))!;
    expect(state.reviewAssurance!.dispatches[0]!.canonicalPromptDigest).toBe(
      hashText(args.prompt as string),
    );
    expect(state.reviewAssurance!.attempts[0]).toMatchObject({
      status: 'created',
      childSessionId: 'child',
    });
    expect(child.record.parentDispatch).toEqual({
      sessionId: 'root',
      messageId: 'message',
      callId: 'call',
    });
    expect(state.reviewAssurance!.invocations).toEqual([]);
    expect(state.reviewAssurance!.obligations[0]!.status).toBe('pending');
  });

  it('rejects replay, same raw call in another message and competing releases without another ledger entry', async () => {
    const scope = await rootScope();
    const results = await Promise.allSettled([
      governance.authorizeDispatch(scope, event()),
      governance.authorizeDispatch(scope, event({}, 'competing')),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const state = (await readState(seeded.sessDir))!;
    expect(state.reviewAssurance!.dispatches).toHaveLength(1);
    await expect(governance.authorizeDispatch(scope, event())).rejects.toThrow();
    await expect(
      governance.authorizeDispatch(scope, {
        ...event(),
        messageID: 'foreign-message',
      } as NativeBefore),
    ).rejects.toThrow();
    expect((await readState(seeded.sessDir))!.reviewAssurance!.dispatches).toEqual(
      state.reviewAssurance!.dispatches,
    );
  });

  it.each([
    { background: true },
    { model: 'provider/model#variant' },
    { sessionID: 'child' },
    { task_id: 'obsolete' },
  ])('rejects unauthorized release arguments before ledger or child creation: %j', async (args) => {
    await expect(governance.authorizeDispatch(await rootScope(), event(args))).rejects.toThrow();
    expect((await readState(seeded.sessDir))!.reviewAssurance!.dispatches).toEqual([]);
    expect(await resolveGovernanceActivation(host.activation.store, 'child')).toMatchObject({
      kind: 'inactive',
    });
  });

  it('does not release when the unique pending operation is absent', async () => {
    workspace.getEnforcementState('root').pendingReviews.clear();
    await expect(governance.authorizeDispatch(await rootScope(), event())).rejects.toThrow(
      'unique pending',
    );
    expect((await readState(seeded.sessDir))!.reviewAssurance!.dispatches).toEqual([]);
  });

  it('does not publish delegation when ledger persistence fails', async () => {
    vi.spyOn(workspace, 'updateReviewAssurance').mockRejectedValueOnce(
      new Error('injected disk failure'),
    );
    await expect(governance.authorizeDispatch(await rootScope(), event())).rejects.toThrow(
      'injected disk failure',
    );
    expect(host.activation.values.has(governanceDelegationKey('root', 'message', 'call'))).toBe(
      false,
    );
    expect(governance.observeProgress(receipt())).toBeUndefined();
  });

  it('refuses a write port that never invokes the durable mutation and a missing workflow state', async () => {
    vi.spyOn(workspace, 'updateReviewAssurance').mockResolvedValueOnce(undefined);
    await expect(governance.authorizeDispatch(await rootScope(), event())).rejects.toThrow(
      'No durable review authorization',
    );
    expect(host.activation.values.has(governanceDelegationKey('root', 'message', 'call'))).toBe(
      false,
    );
    await expect(
      workspace.updateReviewAssurance(`${ws.tmpDir}/missing-state`, (state) => state),
    ).rejects.toHaveProperty('code', 'REVIEW_ASSURANCE_STATE_UNAVAILABLE');
  });

  it('keeps the release spent when delegation persistence fails after ledger authorization', async () => {
    vi.spyOn(host.activation.store, 'set').mockRejectedValueOnce(
      new Error('injected store failure'),
    );
    await expect(governance.authorizeDispatch(await rootScope(), event())).rejects.toThrow(
      'injected store failure',
    );
    await expect(
      governance.authorizeDispatch(await rootScope(), event({}, 'retry')),
    ).rejects.toThrow('quarantined');
    expect(governance.observeProgress(receipt())).toBeUndefined();
    expect((await readState(seeded.sessDir))!.reviewAssurance!.dispatches).toHaveLength(1);
  });

  it('ignores foreign message receipts and refuses multiple children for one dispatch', async () => {
    await governance.authorizeDispatch(await rootScope(), event());
    expect(governance.observeProgress(receipt('child', 'call', 'foreign'))).toBeUndefined();
    await governance.observeProgress(receipt());
    // A later receipt cannot enroll a second child, even if the first receipt settled.
    await governance.observeProgress(receipt('child-other'));
    expect(await resolveGovernanceActivation(host.activation.store, 'child-other')).toMatchObject({
      kind: 'inactive',
    });
    expect((await readState(seeded.sessDir))!.reviewAssurance!.attempts[0]!.childSessionId).toBe(
      'child',
    );
  });

  it('blocks child execution if its binding write fails, without committing enrollment', async () => {
    await governance.authorizeDispatch(await rootScope(), event());
    vi.spyOn(workspace, 'updateReviewAssurance').mockRejectedValueOnce(
      new Error('child binding failed'),
    );
    await expect(governance.observeProgress(receipt())).rejects.toThrow('child binding failed');
    expect(await resolveGovernanceActivation(host.activation.store, 'child')).toMatchObject({
      kind: 'inactive',
    });
    await expect(governance.resolve('child')).resolves.toMatchObject({ kind: 'blocked' });
  });

  it('allows only the exact initial host-prefixed prompt and refuses capture, replay and foreign context', async () => {
    const { call, child } = await authorizedChild();
    const text = `You are a subagent spawned by another session.\n${(call.input as Record<string, unknown>).prompt}`;
    const prompt = {
      sessionID: 'child',
      messageID: 'msg_actual_request',
      prompt: { text },
      delivery: 'steer',
    } as SessionPrompt;
    await expect(reviewer.prompt(child, prompt)).resolves.toBeUndefined();
    const frozen = (call.input as Record<string, unknown>).prompt as string;
    await expect(
      reviewer.prompt(child, {
        ...prompt,
        prompt: { text: `You are a subagent spawned by another session.\nFOREIGN ${frozen}` },
      }),
    ).rejects.toThrow('exact host-prefixed');
    await expect(
      reviewer.prompt(child, {
        ...prompt,
        prompt: { text: `Foo are a subagent spawned by another session.\n${frozen}` },
      }),
    ).rejects.toThrow('exact host-prefixed');
    for (const field of ['files', 'agents', 'skills']) {
      await expect(
        reviewer.prompt(child, {
          ...prompt,
          prompt: { text, [field]: ['foreign'] },
        }),
      ).rejects.toThrow('attachments, agent mentions and skills');
    }
    await expect(
      reviewer.prompt(child, { ...prompt, prompt: { text: `foreign prefix ${text}` } }),
    ).rejects.toThrow('exact host-prefixed');
    await expect(
      reviewer.prompt(child, { ...prompt, prompt: { text: 'Serialize as JSON' } }),
    ).rejects.toThrow('Capture remains blocked');
    host.sessionContext.mockResolvedValue([
      { type: 'user', id: 'msg_actual_request', text, files: [] },
    ]);
    await expect(reviewer.context(child, { tools: {} })).resolves.toBeUndefined();
    const request = {
      sessionID: 'child',
      agent: 'flowguard-reviewer',
      kind: 'primary',
      model: { providerID: 'provider', id: 'model', variant: 'selected' },
    } as SessionModelRequest;
    await expect(reviewer.request(child, request)).resolves.toBeUndefined();
    await expect(
      reviewer.request(child, { ...request, kind: 'compaction' }),
    ).rejects.toHaveProperty('code', 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN');
    await expect(
      reviewer.request(child, { ...request, agent: 'general' as SessionModelRequest['agent'] }),
    ).rejects.toHaveProperty('code', 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN');
    await expect(reviewer.prompt(child, prompt)).rejects.toThrow('replayed');
  });

  it.each(['idle', 'compaction', 'synthetic', 'assistant', 'user'])(
    'rejects unexplained initial history %s before a model request',
    async (type) => {
      const { call, child } = await authorizedChild();
      const text = `You are a subagent spawned by another session.\n${(call.input as Record<string, unknown>).prompt}`;
      await reviewer.prompt(child, {
        sessionID: 'child',
        messageID: 'msg_initial',
        prompt: { text },
      } as SessionPrompt);
      host.sessionContext.mockResolvedValue([
        { type: 'user', id: 'msg_initial', text, files: [] },
        { type },
      ]);
      await expect(reviewer.context(child, { tools: {} })).rejects.toHaveProperty(
        'code',
        'REVIEWER_COMPLETION_UNVERIFIABLE',
      );
    },
  );

  it('rejects each independently corrupted lineage field at the native ledger reader, not only at the outer journal', async () => {
    await authorizedChild();
    const state = (await readState(seeded.sessDir))!;
    const scope = await rootScope();
    const authority = {
      parentSessionId: 'root',
      policyDigest: scope.root.policyDigest,
      worktreeRoot: scope.root.worktreeRoot,
    };
    const assurance = state.reviewAssurance!;
    const d = assurance.dispatches[0]!;
    const a = assurance.attempts[0]!;
    const o = assurance.obligations[0]!;
    const withAssurance = (
      patch: Partial<NonNullable<SessionState['reviewAssurance']>>,
    ): SessionState => ({ ...state, reviewAssurance: { ...assurance, ...patch } });
    const cases: Array<[string, SessionState]> = [
      ['foreign parent', { ...state, binding: { ...state.binding, hostSessionId: 'foreign' } }],
      ['foreign worktree', { ...state, binding: { ...state.binding, worktree: '/foreign' } }],
      [
        'foreign policy',
        { ...state, policySnapshot: { ...state.policySnapshot, hash: 'f'.repeat(64) } },
      ],
      [
        'blocking state error',
        {
          ...state,
          error: {
            code: 'REVIEW_ASSURANCE_STATE_UNAVAILABLE',
            message: 'blocked',
            recoveryHint: 'inspect',
            occurredAt: new Date().toISOString(),
          },
        },
      ],
      ['missing dispatch', withAssurance({ dispatches: [] })],
      [
        'ambiguous dispatch',
        withAssurance({
          dispatches: [d, { ...d, dispatchId: '22222222-2222-4222-8222-222222222222' }],
        }),
      ],
      ['foreign call', withAssurance({ dispatches: [{ ...d, hostCallId: 'foreign-call' }] })],
      [
        'foreign dispatch attempt',
        withAssurance({
          dispatches: [{ ...d, attemptId: '22222222-2222-4222-8222-222222222222' }],
        }),
      ],
      [
        'foreign dispatch obligation',
        withAssurance({
          dispatches: [{ ...d, obligationId: '22222222-2222-4222-8222-222222222222' }],
        }),
      ],
      [
        'unknown dispatch',
        withAssurance({ dispatches: [{ ...d, dispatchStatus: 'outcome_unknown' }] }),
      ],
      [
        'completed dispatch',
        withAssurance({
          dispatches: [
            { ...d, dispatchStatus: 'completed', completedAt: new Date().toISOString() },
          ],
        }),
      ],
      ['missing attempt', withAssurance({ attempts: [] })],
      ['ambiguous attempt', withAssurance({ attempts: [a, a] })],
      [
        'stale attempt',
        withAssurance({
          attempts: [{ ...a, status: 'stale', completedAt: new Date().toISOString() }],
        }),
      ],
      [
        'foreign attempt obligation',
        withAssurance({
          attempts: [{ ...a, obligationId: '22222222-2222-4222-8222-222222222222' }],
        }),
      ],
      ['foreign child', withAssurance({ attempts: [{ ...a, childSessionId: 'foreign-child' }] })],
      ['missing obligation', withAssurance({ obligations: [] })],
      ['ambiguous obligation', withAssurance({ obligations: [o, o] })],
      [
        'blocked obligation',
        withAssurance({
          obligations: [{ ...o, status: 'blocked', blockedCode: 'REVIEW_ATTEMPT_UNAVAILABLE' }],
        }),
      ],
      [
        'obsolete criteria',
        withAssurance({ obligations: [{ ...o, criteriaVersion: 'obsolete-criteria' }] }),
      ],
      [
        'foreign mandate',
        withAssurance({ obligations: [{ ...o, mandateDigest: 'f'.repeat(64) }] }),
      ],
      [
        'capacity lock',
        withAssurance({
          capacityLock: {
            obligationId: o.obligationId,
            code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
            createdAt: new Date().toISOString(),
          },
        }),
      ],
    ];
    // These deliberately malformed boundary values are never persisted or used
    // to manufacture a positive execution/evidence fixture.
    for (const [label, broken] of cases) {
      let error: unknown;
      try {
        nativeReviewDispatchLineage(broken, authority, d.hostCallId, 'child');
      } catch (caught) {
        error = caught;
      }
      expect(error, label).toHaveProperty('code', 'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE');
    }
  });

  it('keeps root, agent and native-parent authorization checks independent at the injected reviewer port', async () => {
    const scope = await rootScope();
    await expect(reviewer.authorize({ ...scope, sessionId: 'child' }, event())).rejects.toThrow(
      'Delegated children',
    );
    await expect(
      reviewer.authorize(scope, { ...event(), sessionID: 'foreign' } as NativeBefore),
    ).rejects.toThrow('Delegated children');
    await expect(reviewer.authorize(scope, event({ agent: 'general' }))).rejects.toThrow(
      'fresh foreground',
    );
    const ordinary = { sessionID: 'root', agent: 'build', kind: 'primary' } as SessionModelRequest;
    await expect(reviewer.request(scope, ordinary)).resolves.toBeUndefined();
    expect((await readState(seeded.sessDir))!.reviewAssurance!.dispatches).toEqual([]);
  });

  it('rechecks native dispatch authority after child enrollment instead of trusting the committed activation alone', async () => {
    const { child } = await authorizedChild();
    await expect(
      reviewer.validate({
        ...child,
        record: {
          ...child.record,
          parentDispatch: { sessionId: 'foreign', messageId: 'message', callId: 'call' },
        },
      }),
    ).rejects.toThrow('direct child');
    const state = (await readState(seeded.sessDir))!;
    await writeState(seeded.sessDir, {
      ...state,
      reviewAssurance: {
        ...state.reviewAssurance!,
        obligations: state.reviewAssurance!.obligations.map((item) => ({
          ...item,
          status: 'blocked',
          blockedCode: 'REVIEW_ATTEMPT_UNAVAILABLE',
        })),
      },
    });
    await expect(governance.resolve('child')).rejects.toHaveProperty(
      'code',
      'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
    );
  });

  it('refuses stale pending identifiers, spent attempts and fresh-scope changes inside the canonical ledger mutation', async () => {
    const scope = await rootScope();
    const state = (await readState(seeded.sessDir))!;
    const assurance = state.reviewAssurance!;
    const original = assurance.attempts[0]!;
    const authority = {
      parentSessionId: 'root',
      policyDigest: scope.root.policyDigest,
      worktreeRoot: scope.root.worktreeRoot,
    };
    const enforcement = workspace.getEnforcementState('root');
    const key = 'flowguard_plan' as const;
    const pending = enforcement.pendingReviews.get(key)!;
    const input = {
      sessDir: seeded.sessDir,
      state,
      authority,
      enforcement,
      hostCallId: nativeHostCallId('root', 'message', 'call'),
      proof: { evaluateProofGraphGate, renderPlanClaimDeclarations },
      deps: {
        updateReviewAssurance: async (
          _dir: string,
          update: (value: SessionState, now: string) => SessionState,
        ) => {
          update(state, new Date().toISOString());
        },
      },
    };
    enforcement.pendingReviews.set(key, {
      ...pending,
      attemptId: '22222222-2222-4222-8222-222222222222',
    });
    await expect(authorizeNativeReviewDispatch(input)).rejects.toThrow(
      'current unbound review attempt',
    );
    enforcement.pendingReviews.set(key, pending);
    enforcement.pendingReviews.set('flowguard_architecture', pending);
    await expect(authorizeNativeReviewDispatch(input)).rejects.toThrow('unique pending');
    enforcement.pendingReviews.delete('flowguard_architecture');
    for (const dispatchStatus of ['outcome_unknown', 'completed'] as const) {
      const spent = {
        ...state,
        reviewAssurance: {
          ...assurance,
          dispatches: [
            {
              dispatchId: '22222222-2222-4222-8222-222222222222',
              attemptId: original.attemptId,
              obligationId: original.obligationId,
              hostCallId: 'spent-call',
              canonicalPromptDigest: 'f'.repeat(64),
              dispatchAuthorizedAt: new Date().toISOString(),
              dispatchStatus,
            },
          ],
        },
      };
      await expect(
        authorizeNativeReviewDispatch({ ...input, state: spent }),
      ).rejects.toHaveProperty('code', 'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE');
    }
    const freshStates = [
      { ...state, binding: { ...state.binding, worktree: '/foreign' } },
      { ...state, policySnapshot: { ...state.policySnapshot, hash: 'f'.repeat(64) } },
    ];
    for (const fresh of freshStates) {
      const deps = {
        updateReviewAssurance: async (
          _dir: string,
          update: (value: SessionState, now: string) => SessionState,
        ) => {
          update(fresh, new Date().toISOString());
        },
      };
      await expect(authorizeNativeReviewDispatch({ ...input, deps })).rejects.toThrow(
        'ACTIVE parent/worktree/policy',
      );
    }
    const successor = {
      ...state,
      reviewAssurance: {
        ...assurance,
        attempts: [{ ...original, attemptId: '22222222-2222-4222-8222-222222222222' }],
      },
    };
    const deps = {
      updateReviewAssurance: async (
        _dir: string,
        update: (value: SessionState, now: string) => SessionState,
      ) => {
        enforcement.pendingReviews.set(key, {
          ...pending,
          attemptId: successor.reviewAssurance.attempts[0]!.attemptId,
        });
        update(successor, new Date().toISOString());
      },
    };
    await expect(authorizeNativeReviewDispatch({ ...input, deps })).rejects.toThrow(
      'changed before durable authorization',
    );
    expect((await readState(seeded.sessDir))!.reviewAssurance!.dispatches).toEqual([]);
  });

  it('does not bind parent/shared/replacement children or claim success from a skipped child write', async () => {
    await governance.authorizeDispatch(await rootScope(), event());
    const state = (await readState(seeded.sessDir))!;
    const scope = await rootScope();
    const authority = {
      parentSessionId: 'root',
      policyDigest: scope.root.policyDigest,
      worktreeRoot: scope.root.worktreeRoot,
    };
    const assurance = state.reviewAssurance!;
    const attempt = assurance.attempts[0]!;
    const hostCallId = assurance.dispatches[0]!.hostCallId;
    const cases = [
      { label: 'parent', state, child: 'root' },
      {
        label: 'replacement',
        state: {
          ...state,
          reviewAssurance: {
            ...assurance,
            attempts: [{ ...attempt, childSessionId: 'original-child' }],
          },
        },
        child: 'child',
      },
      {
        label: 'shared',
        state: {
          ...state,
          reviewAssurance: {
            ...assurance,
            attempts: [
              attempt,
              {
                ...attempt,
                attemptId: '22222222-2222-4222-8222-222222222222',
                childSessionId: 'child',
              },
            ],
          },
        },
        child: 'child',
      },
    ];
    for (const test of cases) {
      const deps = {
        updateReviewAssurance: async (
          _dir: string,
          update: (value: SessionState, now: string) => SessionState,
        ) => {
          update(test.state, new Date().toISOString());
        },
      };
      await expect(
        bindNativeReviewChild({
          deps,
          sessDir: seeded.sessDir,
          authority,
          hostCallId,
          childSessionId: test.child,
        }),
        test.label,
      ).rejects.toHaveProperty('code', 'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE');
    }
    await expect(
      bindNativeReviewChild({
        deps: { updateReviewAssurance: async () => {} },
        sessDir: seeded.sessDir,
        authority,
        hostCallId,
        childSessionId: 'child',
      }),
    ).rejects.toThrow('not durably bound');
    await governance.observeProgress(receipt());
    await expect(
      bindNativeReviewChild({
        deps: workspace,
        sessDir: seeded.sessDir,
        authority,
        hostCallId,
        childSessionId: 'child',
      }),
    ).resolves.toBeUndefined();
  });

  it('does not reconstruct execution authority after reload from a pending unbound receipt', async () => {
    await governance.authorizeDispatch(await rootScope(), event());
    const reloaded = new OpenCodeGovernance(
      host.ctx,
      new OpenCodeHostAdapter(host.ctx, controller.signal),
      controller.signal,
      reviewer,
    );
    expect(reloaded.observeProgress(receipt())).toBeUndefined();
    await expect(reloaded.authorizeDispatch(await rootScope(), event({}, 'new'))).rejects.toThrow(
      'quarantined',
    );
    expect(await resolveGovernanceActivation(host.activation.store, 'child')).toMatchObject({
      kind: 'inactive',
    });
  });

  it('quarantines an already enrolled reviewer after reload rather than resuming from persisted lineage alone', async () => {
    await authorizedChild();
    const reloaded = new OpenCodeGovernance(
      host.ctx,
      new OpenCodeHostAdapter(host.ctx, controller.signal),
      controller.signal,
      reviewer,
    );
    expect(await reloaded.resolve('child')).toMatchObject({ kind: 'blocked' });
    await expect(reloaded.authorizeDispatch(await rootScope(), event({}, 'new'))).rejects.toThrow(
      'current unbound review attempt',
    );
  });

  it('does not let an ordinary-agent continuation reassign the independently bound reviewer child', async () => {
    await authorizedChild();
    await expect(
      governance.authorizeDispatch(
        await rootScope(),
        event({ agent: 'general', sessionID: 'child' }, 'reassign'),
      ),
    ).rejects.toThrow('cannot be continued or reassigned');
    expect(host.activation.values.has(governanceDelegationKey('root', 'message', 'reassign'))).toBe(
      false,
    );
    expect((await readState(seeded.sessDir))!.reviewAssurance!.attempts[0]!.childSessionId).toBe(
      'child',
    );
  });

  it('quarantines further child admission at the exact parent return without granting recovery or certifying quiescence', async () => {
    const { call } = await authorizedChild();
    governance.quarantineReviewerDispatch({
      ...call,
      messageID: 'foreign-message',
    } as NativeBefore);
    expect(await governance.resolve('child')).toMatchObject({ kind: 'active' });
    governance.quarantineReviewerDispatch(call);
    expect(await governance.resolve('child')).toMatchObject({ kind: 'blocked' });
    expect(governance.observeProgress(receipt('child-other'))).toBeUndefined();
    const state = (await readState(seeded.sessDir))!;
    expect(state.reviewAssurance!.dispatches[0]!.dispatchStatus).toBe('authorized');
    expect(state.reviewAssurance!.obligations[0]!.status).toBe('pending');
    expect(state.reviewAssurance!.invocations).toEqual([]);
  });

  it.each(['obligation', 'attempt', 'child', 'capacity', 'scope'] as const)(
    'rejects independently changed %s authority before native release',
    async (field) => {
      const state = (await readState(seeded.sessDir))!;
      const assurance = state.reviewAssurance!;
      const changed =
        field === 'scope'
          ? { ...state, binding: { ...state.binding, hostSessionId: 'foreign' } }
          : {
              ...state,
              reviewAssurance: {
                ...assurance,
                ...(field === 'obligation'
                  ? {
                      obligations: assurance.obligations.map((item) => ({
                        ...item,
                        status: 'blocked' as const,
                        blockedCode: 'REVIEW_ATTEMPT_UNAVAILABLE',
                      })),
                    }
                  : {}),
                ...(field === 'attempt'
                  ? {
                      attempts: assurance.attempts.map((item) => ({
                        ...item,
                        status: 'stale' as const,
                        completedAt: new Date().toISOString(),
                      })),
                    }
                  : {}),
                ...(field === 'child'
                  ? {
                      attempts: assurance.attempts.map((item) => ({
                        ...item,
                        childSessionId: 'foreign-child',
                      })),
                    }
                  : {}),
                ...(field === 'capacity'
                  ? {
                      obligations: [
                        ...assurance.obligations,
                        {
                          ...assurance.obligations[0]!,
                          obligationId: '22222222-2222-4222-8222-222222222222',
                          status: 'blocked' as const,
                          blockedCode: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
                        },
                      ],
                      capacityLock: {
                        obligationId: '22222222-2222-4222-8222-222222222222',
                        code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
                        createdAt: new Date().toISOString(),
                      },
                    }
                  : {}),
              },
            };
      await writeState(seeded.sessDir, changed);
      await expect(governance.authorizeDispatch(await rootScope(), event())).rejects.toHaveProperty(
        'code',
        'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
      );
      expect((await readState(seeded.sessDir))!.reviewAssurance!.dispatches).toEqual([]);
    },
  );

  it('revalidates the exact frozen prompt under the ledger write lock', async () => {
    const update = workspace.updateReviewAssurance.bind(workspace);
    vi.spyOn(workspace, 'updateReviewAssurance').mockImplementationOnce(
      async (dir, mutate, intents) => {
        const state = (await readState(dir))!;
        await writeState(dir, {
          ...state,
          reviewAssurance: {
            ...state.reviewAssurance!,
            obligations: state.reviewAssurance!.obligations.map((item) => ({
              ...item,
              reviewMaterial: {
                ...item.reviewMaterial,
                content: 'foreign frozen subject without a valid digest',
              },
            })),
          },
        });
        await update(dir, mutate, intents);
      },
    );
    await expect(governance.authorizeDispatch(await rootScope(), event())).rejects.toThrow();
    expect((await readState(seeded.sessDir))!.reviewAssurance!.dispatches).toEqual([]);
    expect(host.activation.values.has(governanceDelegationKey('root', 'message', 'call'))).toBe(
      false,
    );
  });

  it.each([{ parentID: 'foreign' }, { agent: 'general' }, { location: { directory: '/foreign' } }])(
    'does not bind a child with foreign native identity %j',
    async (patch) => {
      await governance.authorizeDispatch(await rootScope(), event());
      host.sessionGet.mockImplementation(async ({ sessionID }) => ({
        id: sessionID,
        location: { directory: ws.tmpDir },
        ...(sessionID === 'child'
          ? { parentID: 'root', agent: 'flowguard-reviewer', ...patch }
          : {}),
      }));
      await expect(governance.observeProgress(receipt())).rejects.toThrow();
      expect(
        (await readState(seeded.sessDir))!.reviewAssurance!.attempts[0]!.childSessionId,
      ).toBeUndefined();
    },
  );
});
