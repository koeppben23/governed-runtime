/**
 * @module integration/tui-plugin
 * @description Optional OpenCode TUI workflow chooser.
 *
 * The TUI surface only reads the canonical next-action RPC projection and
 * requests the exact slash command the user selected. It never approves,
 * overrides or mutates governance directly.
 */

import type { Plugin } from '@opencode/plugin/tui';

import { FlowGuardGovernance } from './opencode-governance-rpc.js';
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
  readonly command: (sessionID: string, name: string) => Promise<void>;
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

function sameSelection(
  view: NextActionResult,
  latest: NextActionResult,
  selected: string,
): boolean {
  return (
    latest.kind === 'choose_flow' &&
    latest.stateDigest === view.stateDigest &&
    latest.activationId === view.activationId &&
    latest.activationGeneration === view.activationGeneration &&
    latest.actions.some((action) => action.invocation === selected)
  );
}

/**
 * Open the workflow chooser and request the selected canonical command after a
 * fresh binding check. Cancellation and stale state never execute anything.
 */
export async function chooseWorkflow(
  deps: WorkflowChooserDeps,
  sessionID: string,
): Promise<WorkflowChoiceOutcome> {
  if (!deps.isAlive()) return disposedOutcome();
  const view = await deps.getView(sessionID);
  if (!deps.isAlive()) return disposedOutcome();
  if (view.kind !== 'choose_flow' || view.stateDigest === null) {
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

  const latest = await deps.getView(sessionID);
  const afterLatest = currentOrNull(deps, sessionID, latest.stateDigest);
  if (afterLatest !== null) return afterLatest;
  if (!sameSelection(view, latest, selected)) {
    deps.notify('FlowGuard state changed; no workflow was started. Reopen the chooser.', 'warning');
    return { status: 'stale', stateDigest: latest.stateDigest };
  }
  const beforeCommand = currentOrNull(deps, sessionID, latest.stateDigest);
  if (beforeCommand !== null) return beforeCommand;

  await deps.command(sessionID, selected.replace(/^\//, ''));
  return { status: 'selected', stateDigest: view.stateDigest };
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
    command: async (sessionID, name) => {
      await ctx.client.session.command({ sessionID, name, text: '' });
    },
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
    const [memory, updateMemory] = ctx.storage.memory<{
      prompted: Record<string, string>;
    }>('flowguard.workflow-choice', { initial: { prompted: {} } });
    const inFlight = new Set<string>();
    let disposed = false;
    const deps = createDeps(ctx, () => !disposed);

    const recordOutcome = (sessionID: string, outcome: WorkflowChoiceOutcome): void => {
      updateMemory((draft) => {
        if (outcome.stateDigest === null) delete draft.prompted[sessionID];
        else draft.prompted[sessionID] = outcome.stateDigest;
      });
    };

    const openChooser = async (sessionID: string, quiet: boolean): Promise<void> => {
      if (disposed || inFlight.has(sessionID)) return;
      inFlight.add(sessionID);
      try {
        const outcome = await chooseWorkflow(deps, sessionID);
        if (disposed) return;
        recordOutcome(sessionID, outcome);
        if (!quiet && outcome.status === 'unavailable') {
          deps.notify('No workflow choice is available for this session.', 'info');
        }
        if (!quiet && outcome.status === 'selected') {
          deps.notify('Workflow command requested.', 'success');
        }
      } catch (error) {
        if (!disposed && !quiet) {
          deps.notify(
            `FlowGuard chooser failed: ${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
        }
      } finally {
        inFlight.delete(sessionID);
      }
    };

    const unsubscribe = ctx.data.on('session.idle', (event) => {
      const sessionID = event.data.sessionID;
      if (memory.prompted[sessionID] !== undefined) return;
      if (deps.currentSessionID() !== sessionID) return;
      void openChooser(sessionID, true);
    });

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
            await openChooser(sessionID, false);
          },
        },
      ],
    }));

    return () => {
      disposed = true;
      unsubscribe();
    };
  },
};

export default plugin;
