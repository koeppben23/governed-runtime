/**
 * @module integration/tui-plugin
 * @description Optional OpenCode TUI workflow chooser.
 *
 * The TUI surface only reads the canonical next-action RPC projection and
 * requests the exact slash command the user selected. It never approves,
 * overrides or mutates governance directly.
 */

import type { Plugin } from '@opencode/plugin/tui';

import { FlowGuardGovernance, type NextActionDecisionResult } from './opencode-governance-rpc.js';
import type { DecisionBinding } from './status/decision-binding.js';
import type { NextActionResult } from './status/next-action-projection.js';

type NotifyVariant = 'info' | 'success' | 'warning' | 'error';

export interface WorkflowChooserDeps {
  readonly getView: (sessionID: string) => Promise<NextActionResult>;
  readonly currentSessionID: () => string | null;
  readonly select: (options: {
    readonly title: string;
    readonly options: readonly {
      readonly title: string;
      readonly value: string;
      readonly description?: string;
      readonly footer?: string;
    }[];
  }) => Promise<string | undefined>;
  readonly command: (sessionID: string, name: string, text?: string) => Promise<void>;
  readonly submitDecision: (
    sessionID: string,
    invocation: string,
    expected: DecisionBinding,
    rationale?: string,
  ) => Promise<NextActionDecisionResult>;
  readonly promptRationale: (options: {
    readonly title: string;
    readonly description?: string;
    readonly placeholder?: string;
  }) => Promise<string | undefined>;
  readonly promptCommandText: (options: {
    readonly title: string;
    readonly description?: string;
    readonly placeholder?: string;
  }) => Promise<string | undefined>;
  readonly notify: (message: string, variant: NotifyVariant) => void;
  readonly isAlive: () => boolean;
}

export type WorkflowChoiceStatus = 'selected' | 'cancelled' | 'stale' | 'unavailable' | 'disposed';

export interface WorkflowChoiceOutcome {
  readonly status: WorkflowChoiceStatus;
  readonly stateDigest: string | null;
}

function chooserOptions(view: NextActionResult): Array<{
  readonly title: string;
  readonly value: string;
  readonly description: string;
  readonly footer?: string;
}> {
  return view.actions.map((action) => ({
    title: action.invocation,
    value: action.invocation,
    description: action.description,
    ...(action.visibility === 'recommended' ? { footer: 'Recommended' } : {}),
  }));
}

function disposedOutcome(): WorkflowChoiceOutcome {
  return { status: 'disposed', stateDigest: null };
}

function sessionChangedOutcome(
  deps: WorkflowChooserDeps,
  stateDigest: string | null,
): WorkflowChoiceOutcome {
  deps.notify('Session changed; no workflow was started.', 'warning');
  return { status: 'stale', stateDigest };
}

/** Reject a disposed plugin or a session switch at an execution boundary. */
function currentOrNull(
  deps: WorkflowChooserDeps,
  sessionID: string,
  stateDigest: string | null,
): WorkflowChoiceOutcome | null {
  if (!deps.isAlive()) return disposedOutcome();
  if (deps.currentSessionID() !== sessionID) {
    return sessionChangedOutcome(deps, stateDigest);
  }
  return null;
}

function sameDecisionBinding(
  view: DecisionBinding | null,
  latest: DecisionBinding | null,
): boolean {
  if (view === null || latest === null) return view === latest;
  return (
    view.obligationId === latest.obligationId &&
    view.subjectDigest === latest.subjectDigest &&
    view.reviewCycle === latest.reviewCycle &&
    view.iteration === latest.iteration
  );
}

function sameSelection(
  view: NextActionResult,
  latest: NextActionResult,
  selected: string,
): boolean {
  return (
    latest.kind === view.kind &&
    latest.stateDigest === view.stateDigest &&
    latest.activationId === view.activationId &&
    latest.activationGeneration === view.activationGeneration &&
    latest.policyDigest === view.policyDigest &&
    sameDecisionBinding(view.decisionBinding, latest.decisionBinding) &&
    latest.actions.some((action) => action.invocation === selected)
  );
}

function decisionBindingFor(view: NextActionResult): DecisionBinding | null {
  return view.kind === 'decision_required' ? view.decisionBinding : null;
}

function actionable(view: NextActionResult, binding: DecisionBinding | null): boolean {
  return view.stateDigest !== null && (view.kind === 'choose_flow' || binding !== null);
}

interface SelectionRequest {
  readonly sessionID: string;
  readonly view: NextActionResult;
  readonly latest: NextActionResult;
  readonly selected: string;
  readonly binding: DecisionBinding | null;
  readonly text: string;
}

async function executeDecisionSelection(
  deps: WorkflowChooserDeps,
  request: SelectionRequest & { readonly binding: DecisionBinding },
): Promise<WorkflowChoiceOutcome> {
  const { selected, sessionID, view, latest, binding } = request;
  const rationale =
    selected === '/override-approve'
      ? await deps.promptRationale({
          title: 'FlowGuard governance override rationale',
          description:
            'Record why the exhausted review gate is being overridden. This rationale is durable audit evidence.',
          placeholder: 'Compensating verification and accepted residual risk',
        })
      : '';
  const afterRationale = currentOrNull(deps, sessionID, latest.stateDigest);
  if (afterRationale !== null) return afterRationale;
  if (rationale === undefined) return { status: 'cancelled', stateDigest: view.stateDigest };
  if (selected === '/override-approve' && rationale.trim() === '') {
    deps.notify('A governance override requires a non-empty rationale.', 'warning');
    return { status: 'cancelled', stateDigest: view.stateDigest };
  }
  // Rationale collection is another asynchronous interaction. It can outlive
  // the displayed review or activation, so refresh before requesting authority.
  if (selected === '/override-approve') {
    const refreshed = await deps.getView(sessionID);
    const afterRefresh = currentOrNull(deps, sessionID, refreshed.stateDigest);
    if (afterRefresh !== null) return afterRefresh;
    if (!sameSelection(view, refreshed, selected)) {
      deps.notify('FlowGuard state changed; no decision was submitted. Reopen the chooser.', 'warning');
      return { status: 'stale', stateDigest: refreshed.stateDigest };
    }
  }
  const result = await deps.submitDecision(sessionID, selected, binding, rationale);
  if (result.kind === 'blocked') {
    deps.notify(`FlowGuard decision was not applied: ${result.reason}`, 'warning');
    return { status: 'stale', stateDigest: latest.stateDigest };
  }
  return { status: 'selected', stateDigest: view.stateDigest };
}

async function executeSelection(
  deps: WorkflowChooserDeps,
  request: SelectionRequest,
): Promise<WorkflowChoiceOutcome> {
  if (request.binding !== null) {
    return executeDecisionSelection(deps, { ...request, binding: request.binding });
  }
  await deps.command(request.sessionID, request.selected.replace(/^\//, ''), request.text);
  return { status: 'selected', stateDigest: request.view.stateDigest };
}

/** Collect the task argument before the final freshness read. */
async function commandTextFor(deps: WorkflowChooserDeps, selected: string): Promise<string | null> {
  if (selected !== '/task') return '';
  const text = await deps.promptCommandText({
    title: 'FlowGuard task',
    description: 'Describe the task, or pass --file <path> to use a repository file.',
    placeholder: 'What should FlowGuard implement?',
  });
  if (text === undefined) return null;
  if (text.trim() === '') {
    deps.notify('A task description is required.', 'warning');
    return null;
  }
  return text;
}

/**
 * Open the workflow chooser and request the selected canonical command after a
 * fresh binding check. Cancellation and stale state never execute anything.
 */
export async function chooseWorkflow(
  deps: WorkflowChooserDeps,
  sessionID: string,
  options: { readonly allowDecision?: boolean } = {},
): Promise<WorkflowChoiceOutcome> {
  if (!deps.isAlive()) return disposedOutcome();
  const view = await deps.getView(sessionID);
  if (!deps.isAlive()) return disposedOutcome();
  const decisionBinding = options.allowDecision === false ? null : decisionBindingFor(view);
  if (!actionable(view, decisionBinding)) {
    return { status: 'unavailable', stateDigest: view.stateDigest };
  }
  if (deps.currentSessionID() !== sessionID) {
    return { status: 'stale', stateDigest: view.stateDigest };
  }

  const selected = await deps.select({
    title: view.title,
    options: chooserOptions(view),
  });
  const afterSelect = currentOrNull(deps, sessionID, view.stateDigest);
  if (afterSelect !== null) return afterSelect;
  if (selected === undefined) {
    return { status: 'cancelled', stateDigest: view.stateDigest };
  }

  const commandText = await commandTextFor(deps, selected);
  if (commandText === null) {
    return { status: 'cancelled', stateDigest: view.stateDigest };
  }

  const latest = await deps.getView(sessionID);
  if (!sameSelection(view, latest, selected)) {
    deps.notify('FlowGuard state changed; no workflow was started. Reopen the chooser.', 'warning');
    return { status: 'stale', stateDigest: latest.stateDigest };
  }
  const beforeCommand = currentOrNull(deps, sessionID, latest.stateDigest);
  if (beforeCommand !== null) return beforeCommand;

  return executeSelection(deps, {
    sessionID,
    view,
    latest,
    selected,
    binding: decisionBinding,
    text: commandText,
  });
}

function createDeps(ctx: Plugin.Context, isAlive: () => boolean): WorkflowChooserDeps {
  return {
    getView: (sessionID) =>
      ctx.client.rpc(FlowGuardGovernance).GetNextAction({ sessionID }, { location: ctx.location }),
    currentSessionID: () => {
      const route = ctx.ui.router.current();
      return route.type === 'session' ? route.sessionID : null;
    },
    select: (options) => ctx.ui.dialog.select<string>(options),
    command: async (sessionID, name, text) => {
      await ctx.client.session.command({ sessionID, name, text: text ?? '' });
    },
    submitDecision: (sessionID, invocation, expected, rationale) =>
      ctx.client.rpc(FlowGuardGovernance).SubmitDecision(
        {
          sessionID,
          invocation,
          expected,
          ...(rationale === undefined ? {} : { rationale }),
        },
        { location: ctx.location },
      ),
    promptRationale: (options) => ctx.ui.dialog.prompt(options),
    promptCommandText: (options) => ctx.ui.dialog.prompt(options),
    notify: (message, variant) => {
      ctx.ui.toast.show({ message, variant });
    },
    isAlive,
  };
}

interface TuiPluginDefinition {
  readonly id: string;
  readonly setup: (ctx: Plugin.Context) => (() => void) | void;
}

const plugin: TuiPluginDefinition = {
  id: 'flowguard-tui',
  setup(ctx) {
    const inFlight = new Set<string>();
    let disposed = false;
    const deps = createDeps(ctx, () => !disposed);

    const openChooser = async (sessionID: string): Promise<void> => {
      if (disposed || inFlight.has(sessionID)) return;
      inFlight.add(sessionID);
      try {
        const outcome = await chooseWorkflow(deps, sessionID);
        if (disposed) return;
        if (outcome.status === 'unavailable') {
          deps.notify('No workflow choice is available for this session.', 'info');
        }
        if (outcome.status === 'selected') {
          deps.notify('FlowGuard action requested.', 'success');
        }
      } catch (error) {
        if (!disposed) {
          deps.notify(
            `FlowGuard chooser failed: ${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
        }
      } finally {
        inFlight.delete(sessionID);
      }
    };

    ctx.keymap.layer(() => ({
      mode: 'global',
      priority: 100,
      commands: [
        {
          id: 'flowguard.choose-workflow',
          title: 'FlowGuard: choose workflow',
          description: 'Open the canonical FlowGuard workflow chooser.',
          group: 'FlowGuard',
          palette: true,
          slash: { name: 'choose-workflow' },
          run: async () => {
            const sessionID = deps.currentSessionID();
            if (sessionID === null) {
              deps.notify('Open a session before choosing a FlowGuard workflow.', 'warning');
              return;
            }
            await openChooser(sessionID);
          },
        },
      ],
    }));

    return () => {
      disposed = true;
    };
  },
};

export default plugin;
