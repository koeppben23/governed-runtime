/**
 * @module integration/tui-plugin.test
 * @description TUI chooser request semantics: cancel, stale state and explicit command only.
 */

import { describe, expect, it, vi } from 'vitest';

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

function deps(
  overrides: Partial<WorkflowChooserDeps> & {
    readonly view?: NextActionResult;
    readonly latest?: NextActionResult;
  } = {},
): WorkflowChooserDeps & {
  readonly command: ReturnType<typeof vi.fn>;
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
  const notify = vi.fn();
  return {
    getView,
    currentSessionID: () => 'ses_root',
    select: vi.fn(async () => '/task'),
    command,
    notify,
    ...overrides,
  } as WorkflowChooserDeps & {
    readonly command: ReturnType<typeof vi.fn>;
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
    expect(d.command).toHaveBeenCalledWith('ses_root', 'task');
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
