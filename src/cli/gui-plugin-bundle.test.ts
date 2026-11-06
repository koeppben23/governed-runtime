/** The installed Desktop entry is a CommonJS template; this test executes it
 * with host-shaped stubs before an installed Desktop run. */
import { describe, expect, it, vi } from 'vitest';

import { GUI_PLUGIN_BUNDLE } from './templates.js';

interface FakeCommand {
  readonly id: string;
  readonly run: () => void;
}

interface FakeSlot {
  readonly at: string;
  readonly render: (input: { readonly session: Record<string, unknown> }) => unknown;
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
      prompt: vi.fn(async () => 'Documented override rationale.'),
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
        Slot: 'slot',
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
  const slot = additions.find((entry) => entry.registry === 'slot')?.value as FakeSlot;
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
  return { command, slot, rpcCalls, commandCalls, views, host };
}

describe('installed Desktop GUI bundle', () => {
  it('registers one command and one persistent session-header slot', () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);

    expect(loaded.command.id).toBe('choose-workflow');
    expect(loaded.slot.at).toBe('session.header');
    expect(loaded.slot.render({ session })).toBe('button');
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
        text: '',
      }),
    );
    expect(loaded.rpcCalls.map((call) => call['method'])).toEqual([
      'GetNextAction',
      'GetNextAction',
    ]);
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
});
