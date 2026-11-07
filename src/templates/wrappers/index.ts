/** One auto-discovered native V2 plugin. Tools are registered by its setup. */
export const PLUGIN_RELATIVE_PATH = 'plugins/flowguard/index.ts';

export const PLUGIN_WRAPPER = `\
/** FlowGuard native OpenCode V2 plugin; installation does not activate governance. */
export { default } from "@flowguard/core/integration/plugin";
`;

/** Optional TUI companion; absence or an unsupported host leaves Markdown as fallback. */
export const TUI_PLUGIN_RELATIVE_PATH = 'plugins/flowguard/tui.ts';

export const TUI_PLUGIN_WRAPPER = `\
/** FlowGuard optional OpenCode TUI workflow chooser; never a governance authority. */
export { default } from "@flowguard/core/integration/tui-plugin";
`;

/** Optional Desktop GUI companion; the host loads this prebuilt CommonJS bundle. */
export const GUI_PLUGIN_RELATIVE_PATH = 'plugins/flowguard/gui-experimental.cjs';

export const GUI_PLUGIN_BUNDLE = `\
/** FlowGuard optional OpenCode Desktop GUI; never a governance authority. */
const { Plugin, Command, Panel, Slot } = require('@opencode/plugin/gui');

const RPC_ID = 'flowguard-governance';

function location(session) {
  const directory = session.location && session.location.directory;
  return directory ? { directory: directory } : undefined;
}

async function call(session, method, input) {
  const result = await session.server.client.rpc.call({
    rpcID: RPC_ID,
    method: method,
    location: location(session),
    input: input,
  });
  return result.output;
}

function getView(session) {
  return call(session, 'GetNextAction', { sessionID: session.id });
}

function isCurrentSession(ctx, session) {
  const current = ctx.sessions.current();
  return Boolean(current && current.id === session.id && current.server.id === session.server.id);
}

function sameBinding(left, right) {
  if (!left || !right) return left === right;
  return left.obligationId === right.obligationId &&
    left.subjectDigest === right.subjectDigest &&
    left.reviewCycle === right.reviewCycle &&
    left.iteration === right.iteration;
}

function sameView(first, latest, selected) {
  return first.kind === latest.kind &&
    first.stateDigest === latest.stateDigest &&
    first.activationId === latest.activationId &&
    first.activationGeneration === latest.activationGeneration &&
    first.policyDigest === latest.policyDigest &&
    sameBinding(first.decisionBinding, latest.decisionBinding) &&
    latest.actions.some((action) => action.invocation === selected);
}

function toast(ctx, description, variant) {
  ctx.toast.show({ title: 'FlowGuard', description: description, variant: variant || 'default' });
}

async function choose(ctx, session) {
  const first = await getView(session);
  if (!isCurrentSession(ctx, session)) return;
  if (!first || first.stateDigest === null) {
    toast(ctx, 'No FlowGuard action is available for this session.', 'default');
    return;
  }
  const binding = first.kind === 'decision_required' ? first.decisionBinding : null;
  const isNextAction = first.kind === 'next_action';
  if ((first.kind !== 'choose_flow' && !isNextAction && binding === null) || first.actions.length === 0) {
    toast(ctx, 'No FlowGuard action is available for this state. Run /status for details.', 'default');
    return;
  }
  const selected = await ctx.dialogs.select({
    title: first.title,
    options: first.actions.map((action) => ({
      title: action.invocation,
      value: action.invocation,
      description: action.description,
      ...(action.visibility === 'recommended' ? { footer: 'Recommended' } : {}),
    })),
  });
  if (selected === undefined) return;
  if (!isCurrentSession(ctx, session)) {
    toast(ctx, 'Session changed; no FlowGuard action was executed.', 'error');
    return;
  }

  let commandText = '';
  if (selected === '/task') {
    commandText = await ctx.dialogs.prompt({
      title: 'FlowGuard task',
      description: 'Describe the task, or pass --file <path> to use a repository file.',
      placeholder: 'What should FlowGuard implement?',
    });
    if (commandText === undefined) return;
    if (commandText.trim() === '') {
      toast(ctx, 'A task description is required.', 'error');
      return;
    }
  }

  const latest = await getView(session);
  if (!latest || latest.stateDigest === null || !sameView(first, latest, selected)) {
    toast(ctx, 'FlowGuard state changed; no action was executed. Reopen the chooser.', 'error');
    return;
  }
  if (!isCurrentSession(ctx, session)) {
    toast(ctx, 'Session changed; no FlowGuard action was executed.', 'error');
    return;
  }

  if (first.kind === 'next_action') {
    const confirmed = await ctx.dialogs.confirm({
      title: 'FlowGuard next action',
      description: first.actions[0].description,
      confirm: selected,
      cancel: 'Cancel',
    });
    if (!confirmed) return;
    if (!isCurrentSession(ctx, session)) {
      toast(ctx, 'Session changed; no FlowGuard action was executed.', 'error');
      return;
    }
    const afterConfirmation = await getView(session);
    if (!afterConfirmation || !sameView(first, afterConfirmation, selected) || !isCurrentSession(ctx, session)) {
      toast(ctx, 'FlowGuard state or session changed after confirmation; no action was executed.', 'error');
      return;
    }
    await session.server.client.session.command({ sessionID: session.id, name: selected.replace(/^\\//, ''), text: commandText });
    toast(ctx, 'FlowGuard action requested.', 'success');
    return;
  }

  if (first.kind === 'decision_required') {
    let rationale = '';
    if (selected === '/override-approve') {
      rationale = await ctx.dialogs.prompt({
        title: 'FlowGuard governance override rationale',
        description: 'Record why the exhausted review gate is being overridden. This rationale is durable audit evidence.',
        placeholder: 'Compensating verification and accepted residual risk',
      });
      if (rationale === undefined) return;
      if (rationale.trim() === '') {
        toast(ctx, 'A governance override requires a non-empty rationale.', 'error');
        return;
      }
    }
    // A rationale dialog can outlive the visible session or review. Re-read
    // before crossing the canonical server-side decision authority boundary.
    if (!isCurrentSession(ctx, session)) {
      toast(ctx, 'Session changed; no FlowGuard decision was submitted.', 'error');
      return;
    }
    const afterRationale = await getView(session);
    if (!afterRationale || !sameView(first, afterRationale, selected) || !isCurrentSession(ctx, session)) {
      toast(ctx, 'FlowGuard state or session changed; no decision was submitted.', 'error');
      return;
    }
    const result = await call(session, 'SubmitDecision', {
      sessionID: session.id,
      invocation: selected,
      expected: first.decisionBinding,
      ...(rationale === '' ? {} : { rationale: rationale }),
    });
    if (result.kind === 'blocked') toast(ctx, result.reason, 'error');
    else toast(ctx, 'FlowGuard decision recorded.', 'success');
    return;
  }

  await session.server.client.session.command({ sessionID: session.id, name: selected.replace(/^\\//, ''), text: commandText });
  toast(ctx, 'FlowGuard action requested.', 'success');
}

/**
 * Opt-in native UI capability probe. A DOM Node is a valid Solid child.
 * This deliberately avoids a new TSX/Vite production renderer before the
 * pinned Desktop proves Panel/Slot visibility. Only GetNextAction is read.
 */
function probeSessionKey(session) {
  return session && session.server ? session.server.id + ':' + session.id : null;
}

function probeSummary(view) {
  if (!view || !view.phase) return 'FlowGuard: state unavailable / NOT_VERIFIED';
  const phase = view.phase;
  if (view.kind === 'blocked') {
    const message = view.blocker && view.blocker.message;
    return 'FlowGuard · ' + phase + ' · BLOCKED: ' + (message || 'See /status for recovery.');
  }
  if (view.kind === 'decision_required') {
    return 'FlowGuard · ' + phase + ' · Decision required (not approved)';
  }
  if (view.kind === 'system_work') return 'FlowGuard · ' + phase + ' · System work in progress';
  if (view.kind === 'terminal') return 'FlowGuard · ' + phase + ' · Terminal state';
  const action = view.actions && view.actions[0];
  return 'FlowGuard · ' + phase + (action ? ' · Next: ' + action.invocation : '');
}

function renderProbe(ctx, props, compact) {
  const { createEffect, createSignal, onCleanup } = require('solid-js');
  const node = document.createElement(compact ? 'span' : 'section');
  node.setAttribute('data-flowguard-ui-probe', compact ? 'header' : 'panel');
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  const label = document.createElement(compact ? 'span' : 'p');
  label.textContent = 'FlowGuard · Loading read-only state...';
  let disposed = false;
  let generation = 0;
  const [revision, refresh] = createSignal(0);

  if (!compact) {
    const title = document.createElement('h2');
    title.textContent = 'FlowGuard · Desktop UI capability probe';
    const caption = document.createElement('p');
    caption.textContent =
      'Read-only GetNextAction projection. No decisions or workflow commands are issued by this panel.';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Refresh FlowGuard status';
    const handleRefresh = () => refresh((previous) => previous + 1);
    button.addEventListener('click', handleRefresh);
    onCleanup(() => button.removeEventListener('click', handleRefresh));
    node.appendChild(title);
    node.appendChild(caption);
    node.appendChild(label);
    node.appendChild(button);
  } else {
    node.appendChild(label);
  }

  createEffect(() => {
    const session = props.session;
    revision();
    const request = ++generation;
    const identity = probeSessionKey(session);
    label.textContent = identity ? 'FlowGuard · Loading ' + session.id + '...' : 'FlowGuard: no session';
    if (!identity) return;
    void getView(session).then(
      (view) => {
        if (disposed || request !== generation || probeSessionKey(props.session) !== identity) return;
        label.textContent = probeSummary(view);
      },
      () => {
        if (disposed || request !== generation || probeSessionKey(props.session) !== identity) return;
        label.textContent = 'FlowGuard · NOT_VERIFIED (status unavailable; use /status)';
      },
    );
  });

  // Session changes are reactive; a completed host turn also refreshes the
  // current session. The panel's button supplies a deterministic manual path.
  createEffect(() => {
    const session = props.session;
    if (!session || !ctx.servers || typeof ctx.servers.get !== 'function') return;
    const server = ctx.servers.get(session.server.id);
    if (!server || !server.data || typeof server.data.on !== 'function') return;
    const unsubscribe = server.data.on('session.execution.succeeded', (event) => {
      if (event && event.data && event.data.sessionID === session.id) {
        refresh((previous) => previous + 1);
      }
    });
    onCleanup(() => {
      if (typeof unsubscribe === 'function') unsubscribe();
    });
  });
  onCleanup(() => {
    disposed = true;
    generation += 1;
  });
  return node;
}

module.exports = Plugin.define({
  setup(ctx) {
    const probeTab = {
      id: 'workbench-probe',
      title: 'FlowGuard UI Probe',
      closable: 'compact',
      fallback: true,
      tabbable: true,
    };
    if (Panel) {
      ctx.add(Panel, {
        id: 'workbench-probe',
        region: 'side',
        list: (input) => input.open.includes('workbench-probe') ? [probeTab] : [],
        render: (props) => renderProbe(ctx, props, false),
      });
    }
    let headerRegistered = false;
    ctx.add(Command, {
      id: 'ui-probe',
      title: 'FlowGuard: inspect native UI (experimental)',
      description: 'Opt in to a read-only Desktop panel and session-header status probe.',
      group: 'FlowGuard',
      slash: { name: 'flowguard-ui-probe' },
      run: () => {
        const session = ctx.sessions.current();
        if (!session) {
          toast(ctx, 'Open a session before inspecting FlowGuard UI.', 'default');
          return;
        }
        if (!Panel || !Slot || !ctx.layout || typeof ctx.layout.open !== 'function') {
          toast(ctx, 'This Desktop build does not expose Panel/Slot/layout APIs.', 'error');
          return;
        }
        if (!headerRegistered) {
          ctx.add(Slot, {
            at: 'session.header',
            order: 90,
            render: (input) => renderProbe(ctx, input, true),
          });
          headerRegistered = true;
        }
        ctx.layout.open(ctx.id + ':workbench-probe', session, { tab: 'select' });
      },
    });
    ctx.add(Command, {
      id: 'choose-workflow',
      title: 'FlowGuard: choose workflow or decision',
      description: 'Open the canonical FlowGuard Next Action dialog.',
      group: 'FlowGuard',
      slash: { name: 'choose-workflow' },
      run: () => {
        const session = ctx.sessions.current();
        if (!session) {
          toast(ctx, 'Open a session before choosing a FlowGuard action.', 'default');
          return;
        }
        void choose(ctx, session);
      },
    });
  }
});
`;
