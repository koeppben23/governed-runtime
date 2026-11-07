/** The installed Desktop entry is a CommonJS template; this test executes it
 * with host-shaped stubs before an installed Desktop run. */
import { describe, expect, it, vi } from 'vitest';

import { GUI_PLUGIN_BUNDLE } from './templates.js';

interface FakeCommand {
  readonly id: string;
  readonly run: () => void;
}

function load(ctx: Record<string, unknown>, session: Record<string, unknown>) {
  const additions: Array<{ registry: string; value: unknown }> = [];
  const rpcCalls: Array<Record<string, unknown>> = [];
  const commandCalls: Array<Record<string, unknown>> = [];
  const views: unknown[] = [];
  const add = (registry: string, value: unknown) => additions.push({ registry, value });
  const host = {
    ...ctx,
    add,
    dialogs: {
      select: vi.fn(async () => '/task'),
      prompt: vi.fn(async () => 'Task description.'),
      confirm: vi.fn(async () => true),
    },
    sessions: { current: () => session },
    toast: { show: vi.fn() },
    ui: { Button: vi.fn(() => 'button') },
  };
  Object.assign(ctx, host);
  const module = { exports: {} as Record<string, unknown> };
  const requireStub = (name: string) => {
    if (name === '@opencode/plugin/gui') {
      return {
        Plugin: { define: (value: unknown) => value },
        Command: 'command',
        ComposerPill: 'composer-pill',
      };
    }
    if (name === 'solid-js') {
      return {
        createEffect: (fn: () => void) => fn(),
        createSignal: (initial: unknown) => {
          let value = initial;
          return [() => value, (next: unknown) => (value = next)];
        },
        onCleanup: () => {},
      };
    }
    throw new Error(`unexpected require: ${name}`);
  };
  const factory = new Function('require', 'module', 'exports', GUI_PLUGIN_BUNDLE);
  factory(requireStub, module, module.exports);
  const plugin = module.exports as {
    setup: (context: Record<string, unknown>) => void;
  };
  plugin.setup(host);
  const command = additions.find((entry) => entry.registry === 'command')?.value as FakeCommand;
  Object.assign(session, {
    id: 'ses_root',
    location: { directory: '/tmp/worktree' },
    server: {
      client: {
        rpc: {
          call: vi.fn(async (input: Record<string, unknown>) => {
            rpcCalls.push(input);
            return { output: views.shift() ?? null };
          }),
        },
        session: {
          command: vi.fn(async (input: Record<string, unknown>) => {
            commandCalls.push(input);
          }),
        },
      },
    },
  });
  return { command, rpcCalls, commandCalls, views, host };
}

describe('installed Desktop GUI bundle', () => {
  it('registers only the on-demand workflow command', () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);

    expect(loaded.command.id).toBe('choose-workflow');
  });

  it('runs the selected workflow command after re-reading the same view', async () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);
    const view = {
      kind: 'choose_flow',
      stateDigest: 'a'.repeat(64),
      activationId: '11111111-1111-4111-8111-111111111111',
      activationGeneration: 1,
      policyDigest: 'b'.repeat(64),
      decisionBinding: null,
      title: 'Choose a workflow',
      actions: [{ invocation: '/task', description: 'Start.', visibility: 'available' }],
    };
    loaded.views.push(view, view);

    loaded.command.run();

    await vi.waitFor(() =>
      expect(loaded.commandCalls).toContainEqual({
        sessionID: 'ses_root',
        name: 'task',
        text: 'Task description.',
      }),
    );
    expect(loaded.rpcCalls.map((call) => call['method'])).toEqual([
      'GetNextAction',
      'GetNextAction',
    ]);
  });

  it('renders the persistent next action and executes it after confirmation', async () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);
    const view = {
      kind: 'next_action',
      stateDigest: 'a'.repeat(64),
      activationId: '11111111-1111-4111-8111-111111111111',
      activationGeneration: 1,
      policyDigest: 'b'.repeat(64),
      decisionBinding: null,
      title: 'Plan required',
      actions: [
        { invocation: '/plan', description: 'Create the plan.', visibility: 'recommended' },
      ],
    };
    loaded.views.push(view, view);
    (ctx.dialogs as { select: ReturnType<typeof vi.fn> }).select.mockResolvedValueOnce('/plan');

    loaded.command.run();

    await vi.waitFor(() =>
      expect(loaded.commandCalls).toContainEqual({
        sessionID: 'ses_root',
        name: 'plan',
        text: '',
      }),
    );
    expect((ctx.dialogs as { confirm: ReturnType<typeof vi.fn> }).confirm).toHaveBeenCalledWith(
      expect.objectContaining({ confirm: '/plan' }),
    );
  });

  it('submits a decision only when the displayed subject binding is unchanged', async () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);
    const binding = {
      sessionID: 'ses_root',
      activationId: '11111111-1111-4111-8111-111111111111',
      activationGeneration: 1,
      policyDigest: 'b'.repeat(64),
      stateDigest: 'a'.repeat(64),
      phase: 'PLAN_REVIEW',
      obligationId: '22222222-2222-4222-8222-222222222222',
      subjectDigest: 'c'.repeat(64),
      reviewType: 'plan',
      reviewCycle: 1,
      iteration: 1,
    };
    const view = {
      kind: 'decision_required',
      stateDigest: 'a'.repeat(64),
      activationId: binding.activationId,
      activationGeneration: 1,
      policyDigest: binding.policyDigest,
      decisionBinding: binding,
      title: 'Plan decision required',
      actions: [{ invocation: '/approve', description: 'Approve.', visibility: 'available' }],
    };
    loaded.views.push(view, {
      ...view,
      decisionBinding: { ...binding, subjectDigest: 'd'.repeat(64) },
    });
    (ctx.dialogs as { select: ReturnType<typeof vi.fn> }).select.mockResolvedValueOnce('/approve');

    loaded.command.run();

    await vi.waitFor(() => expect(loaded.rpcCalls).toHaveLength(2));
    expect(loaded.rpcCalls.some((call) => call['method'] === 'SubmitDecision')).toBe(false);
    expect(loaded.commandCalls).toEqual([]);
    expect((ctx.toast as { show: ReturnType<typeof vi.fn> }).show).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'error' }),
    );
  });

  it('does not execute a next action when the session switches during confirmation', async () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);
    const view = {
      kind: 'next_action',
      stateDigest: 'a'.repeat(64),
      activationId: '11111111-1111-4111-8111-111111111111',
      activationGeneration: 1,
      policyDigest: 'b'.repeat(64),
      decisionBinding: null,
      title: 'Plan required',
      actions: [{ invocation: '/plan', description: 'Create plan.', visibility: 'recommended' }],
    };
    loaded.views.push(view, view);
    (ctx.dialogs as { select: ReturnType<typeof vi.fn> }).select.mockResolvedValueOnce('/plan');
    (ctx.dialogs as { confirm: ReturnType<typeof vi.fn> }).confirm.mockImplementationOnce(
      async () => {
        (ctx.sessions as { current: () => unknown }).current = () => ({
          id: 'ses_other',
          server: { id: 'other_server' },
        });
        return true;
      },
    );

    loaded.command.run();

    await vi.waitFor(() =>
      expect((ctx.toast as { show: ReturnType<typeof vi.fn> }).show).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'error' }),
      ),
    );
    expect(loaded.commandCalls).toEqual([]);
    expect(loaded.rpcCalls.filter((call) => call['method'] === 'SubmitDecision')).toEqual([]);
  });

  it('does not submit an override when the session switches during rationale input', async () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);
    const binding = {
      sessionID: 'ses_root',
      activationId: '11111111-1111-4111-8111-111111111111',
      activationGeneration: 1,
      policyDigest: 'b'.repeat(64),
      stateDigest: 'a'.repeat(64),
      phase: 'PLAN_REVIEW',
      obligationId: '22222222-2222-4222-8222-222222222222',
      subjectDigest: 'c'.repeat(64),
      reviewType: 'plan',
      reviewCycle: 1,
      iteration: 1,
    };
    const view = {
      kind: 'decision_required',
      stateDigest: binding.stateDigest,
      activationId: binding.activationId,
      activationGeneration: binding.activationGeneration,
      policyDigest: binding.policyDigest,
      decisionBinding: binding,
      title: 'Decision required',
      actions: [{
        invocation: '/override-approve',
        description: 'Override an exhausted gate.',
        visibility: 'available',
      }],
    };
    loaded.views.push(view, view);
    (ctx.dialogs as { select: ReturnType<typeof vi.fn> }).select.mockResolvedValueOnce('/override-approve');
    (ctx.dialogs as { prompt: ReturnType<typeof vi.fn> }).prompt.mockImplementationOnce(
      async () => {
        (ctx.sessions as { current: () => unknown }).current = () => ({
          id: 'ses_other',
          server: { id: 'other_server' },
        });
        return 'Documented reason.';
      },
    );

    loaded.command.run();

    await vi.waitFor(() =>
      expect((ctx.toast as { show: ReturnType<typeof vi.fn> }).show).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'error' }),
      ),
    );
    expect(loaded.rpcCalls.filter((call) => call['method'] === 'SubmitDecision')).toEqual([]);
    expect(loaded.commandCalls).toEqual([]);
  });

});
