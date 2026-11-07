/**
 * @module integration/tui-plugin.test
 * @description TUI chooser request semantics: cancel, stale state and explicit command only.
 */

import { describe, expect, it, vi } from 'vitest';

import type { DecisionBinding } from './status/decision-binding.js';
import type { NextActionResult } from './status/next-action-projection.js';
import plugin, { chooseWorkflow, type WorkflowChooserDeps } from './tui-plugin.js';

function choiceView(overrides: Partial<NextActionResult> = {}): NextActionResult {
  return {
    schemaVersion: 'next-action.v1',
    kind: 'choose_flow',
    sessionID: 'ses_root',
    phase: 'READY',
    stateDigest: 'a'.repeat(64),
    policyDigest: 'b'.repeat(64),
    activationId: '11111111-1111-4111-8111-111111111111',
    activationGeneration: 1,
    decisionBinding: null,
    title: 'Choose a workflow',
    question: 'Choose one workflow to start. Nothing runs until you send a command.',
    actions: [
      { invocation: '/task', description: 'Start the task flow.', visibility: 'available' },
      {
        invocation: '/architecture',
        description: 'Create an ADR.',
        visibility: 'available',
      },
      { invocation: '/review', description: 'Review content.', visibility: 'available' },
    ],
    blocker: null,
    ...overrides,
  };
}

function decisionView(overrides: Partial<NextActionResult> = {}): NextActionResult {
  return choiceView({
    kind: 'decision_required',
    title: 'Plan decision required',
    question: 'The plan review is complete. Choose one decision.',
    decisionBinding: {
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
    },
    actions: [
      { invocation: '/approve', description: 'Accept the plan.', visibility: 'available' },
      { invocation: '/request-changes', description: 'Request changes.', visibility: 'available' },
      { invocation: '/reject', description: 'Reject the plan.', visibility: 'available' },
    ],
    ...overrides,
  });
}

function deps(
  overrides: Partial<WorkflowChooserDeps> & {
    readonly view?: NextActionResult;
    readonly latest?: NextActionResult;
  } = {},
): WorkflowChooserDeps & {
  readonly command: ReturnType<typeof vi.fn>;
  readonly submitDecision: ReturnType<typeof vi.fn>;
  readonly promptRationale: ReturnType<typeof vi.fn>;
  readonly promptCommandText: ReturnType<typeof vi.fn>;
  readonly notify: ReturnType<typeof vi.fn>;
} {
  const view = overrides.view ?? choiceView();
  const latest = overrides.latest ?? view;
  let calls = 0;
  const getView = vi.fn(async () => {
    calls += 1;
    return calls === 1 ? view : latest;
  });
  const command = vi.fn(async () => {});
  const submitDecision = vi.fn(async () => ({ kind: 'applied' as const, invocation: '/approve' }));
  const promptRationale = vi.fn(async () => 'Documented override rationale.');
  const promptCommandText = vi.fn(async () => 'Describe the task.');
  const notify = vi.fn();
  return {
    getView,
    currentSessionID: () => 'ses_root',
    select: vi.fn(async () => '/task'),
    command,
    submitDecision,
    promptRationale,
    promptCommandText,
    notify,
    isAlive: () => true,
    ...overrides,
  } as WorkflowChooserDeps & {
    readonly command: ReturnType<typeof vi.fn>;
    readonly submitDecision: ReturnType<typeof vi.fn>;
    readonly promptRationale: ReturnType<typeof vi.fn>;
    readonly promptCommandText: ReturnType<typeof vi.fn>;
    readonly notify: ReturnType<typeof vi.fn>;
  };
}

describe('TUI workflow chooser', () => {
  it('exports a TUI plugin definition with a setup hook', () => {
    expect(plugin.id).toBe('flowguard-tui');
    expect(typeof plugin.setup).toBe('function');
  });

  it('requests the selected canonical command only after re-reading the same state', async () => {
    const d = deps();

    const outcome = await chooseWorkflow(d, 'ses_root');

    expect(outcome).toEqual({ status: 'selected', stateDigest: 'a'.repeat(64) });
    expect(d.command).toHaveBeenCalledWith('ses_root', 'task', 'Describe the task.');
  });

  it('cancellation executes nothing', async () => {
    const d = deps({ select: vi.fn(async () => undefined) });

    const outcome = await chooseWorkflow(d, 'ses_root');

    expect(outcome.status).toBe('cancelled');
    expect(d.command).not.toHaveBeenCalled();
  });

  it('refuses a stale state after selection', async () => {
    const d = deps({
      latest: choiceView({ stateDigest: 'c'.repeat(64) }),
    });

    const outcome = await chooseWorkflow(d, 'ses_root');

    expect(outcome.status).toBe('stale');
    expect(d.command).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining('state changed'), 'warning');
  });

  it('refuses when the active session changes during the post-selection RPC', async () => {
    let active = 'ses_root';
    let calls = 0;
    const d = deps({
      currentSessionID: () => active,
      getView: vi.fn(async () => {
        calls += 1;
        if (calls === 2) active = 'ses_other';
        return choiceView();
      }),
    });

    const outcome = await chooseWorkflow(d, 'ses_root');

    expect(outcome.status).toBe('stale');
    expect(d.command).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining('Session changed'), 'warning');
  });

  it('refuses a late dialog result after plugin unload', async () => {
    let alive = true;
    const d = deps({
      isAlive: () => alive,
      select: vi.fn(async () => {
        alive = false;
        return '/task';
      }),
    });

    const outcome = await chooseWorkflow(d, 'ses_root');

    expect(outcome.status).toBe('disposed');
    expect(d.command).not.toHaveBeenCalled();
  });

  it('refuses when the activation generation changed after selection', async () => {
    const d = deps({
      latest: choiceView({ activationGeneration: 2 }),
    });

    const outcome = await chooseWorkflow(d, 'ses_root');

    expect(outcome.status).toBe('stale');
    expect(d.command).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining('state changed'), 'warning');
  });

  it('refuses when the activation id changed after selection', async () => {
    const d = deps({
      latest: choiceView({ activationId: '22222222-2222-4222-8222-222222222222' }),
    });

    const outcome = await chooseWorkflow(d, 'ses_root');

    expect(outcome.status).toBe('stale');
    expect(d.command).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining('state changed'), 'warning');
  });

  it('refuses when the active session changes while the dialog is open', async () => {
    let active = 'ses_root';
    const d = deps({
      currentSessionID: () => active,
      select: vi.fn(async () => {
        active = 'ses_other';
        return '/task';
      }),
    });

    const outcome = await chooseWorkflow(d, 'ses_root');

    expect(outcome.status).toBe('stale');
    expect(d.command).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining('Session changed'), 'warning');
  });

  it('submits a review decision with the displayed obligation binding', async () => {
    const view = decisionView();
    const d = deps({
      view,
      select: vi.fn(async () => '/approve'),
    });

    const outcome = await chooseWorkflow(d, 'ses_root');

    expect(outcome).toEqual({ status: 'selected', stateDigest: 'a'.repeat(64) });
    expect(d.command).not.toHaveBeenCalled();
    expect(d.submitDecision).toHaveBeenCalledWith('ses_root', '/approve', view.decisionBinding, '');
  });

  it('refuses a decision when the subject binding changed after selection', async () => {
    const view = decisionView();
    const d = deps({
      view,
      latest: decisionView({
        decisionBinding: { ...view.decisionBinding!, subjectDigest: 'd'.repeat(64) },
      }),
      select: vi.fn(async () => '/approve'),
    });

    const outcome = await chooseWorkflow(d, 'ses_root');

    expect(outcome.status).toBe('stale');
    expect(d.submitDecision).not.toHaveBeenCalled();
    expect(d.command).not.toHaveBeenCalled();
  });

  it('does not offer a decision when no canonical obligation binding exists', async () => {
    const d = deps({
      view: decisionView({ decisionBinding: null }),
      select: vi.fn(async () => '/approve'),
    });

    const outcome = await chooseWorkflow(d, 'ses_root');

    expect(outcome.status).toBe('unavailable');
    expect(d.select).not.toHaveBeenCalled();
    expect(d.submitDecision).not.toHaveBeenCalled();
  });

  it('does not auto-open a review decision from the background idle path', async () => {
    const d = deps({
      view: decisionView(),
      select: vi.fn(async () => '/approve'),
    });

    const outcome = await chooseWorkflow(d, 'ses_root', { allowDecision: false });

    expect(outcome.status).toBe('unavailable');
    expect(d.select).not.toHaveBeenCalled();
    expect(d.submitDecision).not.toHaveBeenCalled();
  });

  it('requires a non-empty rationale for a governance override', async () => {
    const view = decisionView({
      actions: [
        {
          invocation: '/override-approve',
          description: 'Accept with governance override.',
          visibility: 'available',
        },
      ],
    });
    const d = deps({
      view,
      select: vi.fn(async () => '/override-approve'),
      promptRationale: vi.fn(async () => '  '),
    });

    const outcome = await chooseWorkflow(d, 'ses_root');

    expect(outcome.status).toBe('cancelled');
    expect(d.submitDecision).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(
      expect.stringContaining('non-empty rationale'),
      'warning',
    );
  });

  it('submits an override with its explicit rationale', async () => {
    const view = decisionView({
      actions: [
        {
          invocation: '/override-approve',
          description: 'Accept with governance override.',
          visibility: 'available',
        },
      ],
    });
    const d = deps({
      view,
      select: vi.fn(async () => '/override-approve'),
      promptRationale: vi.fn(async () => 'Compensating verification is documented.'),
    });

    const outcome = await chooseWorkflow(d, 'ses_root');

    expect(outcome.status).toBe('selected');
    expect(d.submitDecision).toHaveBeenCalledWith(
      'ses_root',
      '/override-approve',
      view.decisionBinding,
      'Compensating verification is documented.',
    );
  });

  it('does not submit an override after the user switches session in the rationale dialog', async () => {
    const view = decisionView({
      actions: [
        {
          invocation: '/override-approve',
          description: 'Accept with governance override.',
          visibility: 'available',
        },
      ],
    });
    let activeSession = 'ses_root';
    const d = deps({
      view,
      currentSessionID: () => activeSession,
      select: vi.fn(async () => '/override-approve'),
      promptRationale: vi.fn(async () => {
        activeSession = 'ses_other';
        return 'Valid rationale for a different session.';
      }),
    });

    const outcome = await chooseWorkflow(d, 'ses_root');

    expect(outcome.status).toBe('stale');
    expect(d.submitDecision).not.toHaveBeenCalled();
    expect(d.command).not.toHaveBeenCalled();
  });

  it('does not submit an override if its review changed while rationale was entered', async () => {
    const view = decisionView({
      actions: [
        {
          invocation: '/override-approve',
          description: 'Accept with governance override.',
          visibility: 'available',
        },
      ],
    });
    let reads = 0;
    const d = deps({
      view,
      select: vi.fn(async () => '/override-approve'),
      getView: vi.fn(async () => {
        reads += 1;
        if (reads === 3) {
          return decisionView({
            ...view,
            decisionBinding: { ...view.decisionBinding!, subjectDigest: 'f'.repeat(64) },
          });
        }
        return view;
      }),
      promptRationale: vi.fn(async () => 'A documented override rationale.'),
    });

    const outcome = await chooseWorkflow(d, 'ses_root');

    expect(outcome.status).toBe('stale');
    expect(d.submitDecision).not.toHaveBeenCalled();
    expect(reads).toBe(3);
  });

  it('does not submit after the override dialog resolves on a disposed plugin', async () => {
    const view = decisionView({
      actions: [
        {
          invocation: '/override-approve',
          description: 'Accept with governance override.',
          visibility: 'available',
        },
      ],
    });
    let alive = true;
    const d = deps({
      view,
      select: vi.fn(async () => '/override-approve'),
      isAlive: () => alive,
      promptRationale: vi.fn(async () => {
        alive = false;
        return 'This dialog completed after unloading.';
      }),
    });

    const outcome = await chooseWorkflow(d, 'ses_root');

    expect(outcome.status).toBe('disposed');
    expect(d.submitDecision).not.toHaveBeenCalled();
  });

  it('treats a blocked native decision as failure without executing a command', async () => {
    const view = decisionView();
    const d = deps({
      view,
      select: vi.fn(async () => '/approve'),
      submitDecision: vi.fn(async () => ({
        kind: 'blocked' as const,
        code: 'DECISION_BINDING_STALE',
        reason: 'The reviewed subject changed.',
      })),
    });

    const outcome = await chooseWorkflow(d, 'ses_root');

    expect(outcome.status).toBe('stale');
    expect(d.command).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(
      expect.stringContaining('The reviewed subject changed.'),
      'warning',
    );
  });

  it('does not open a chooser for a non-choose-flow projection', async () => {
    const select = vi.fn(async () => '/task');
    const d = deps({
      view: choiceView({ kind: 'terminal', actions: [] }),
      select,
    });

    const outcome = await chooseWorkflow(d, 'ses_root');

    expect(outcome.status).toBe('unavailable');
    expect(select).not.toHaveBeenCalled();
    expect(d.command).not.toHaveBeenCalled();
  });
});
