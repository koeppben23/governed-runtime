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
const { Plugin, Command, Slot } = require('@opencode/plugin/gui');
const { createEffect, createSignal, onCleanup } = require('solid-js');

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

function statusLabel(view) {
  if (!view) return 'FlowGuard';
  if (view.kind === 'choose_flow') return 'FlowGuard · READY · choose workflow';
  if (view.kind === 'decision_required') return 'FlowGuard · ' + (view.phase || 'review') + ' · decision required';
  if (view.kind === 'next_action') return 'FlowGuard · ' + (view.phase || 'active') + ' · ' + ((view.actions[0] && view.actions[0].invocation) || 'next action');
  if (view.kind === 'system_work') return 'FlowGuard · ' + (view.phase || 'active') + ' · in progress';
  if (view.kind === 'blocked') return 'FlowGuard · not active or blocked';
  return 'FlowGuard · ' + (view.phase || 'terminal');
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
  if (!first || first.stateDigest === null) {
    toast(ctx, 'No FlowGuard action is available for this session.', 'default');
    return;
  }
  const binding = first.kind === 'decision_required' ? first.decisionBinding : null;
  if (first.kind !== 'choose_flow' && binding === null) {
    toast(ctx, 'This FlowGuard state has no native decision binding.', 'default');
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

  const latest = await getView(session);
  if (!latest || latest.stateDigest === null || !sameView(first, latest, selected)) {
    toast(ctx, 'FlowGuard state changed; no action was executed. Reopen the chooser.', 'error');
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

  await session.server.client.session.command({ sessionID: session.id, name: selected.replace(/^\\//, ''), text: '' });
  toast(ctx, 'FlowGuard action requested.', 'success');
}

function Status(ctx, sessionAccessor) {
  const [label, setLabel] = createSignal('FlowGuard');

  createEffect(() => {
    const session = sessionAccessor();
    if (!session) {
      setLabel('FlowGuard');
      return;
    }
    let alive = true;
    const refresh = async () => {
      try {
        const view = await getView(session);
        if (alive) setLabel(statusLabel(view));
      } catch {
        if (alive) setLabel('FlowGuard');
      }
    };
    void refresh();
    const timer = setInterval(refresh, 3000);
    onCleanup(() => {
      alive = false;
      clearInterval(timer);
    });
  });

  return ctx.ui.Button({
    variant: 'ghost-muted',
    size: 'small',
    children: label(),
    onClick: () => {
      const session = sessionAccessor();
      if (!session) {
        toast(ctx, 'Open a session before choosing a FlowGuard action.', 'default');
        return;
      }
      void choose(ctx, session);
    },
  });
}

module.exports = Plugin.define({
  setup(ctx) {
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
    ctx.add(Slot, {
      at: 'session.header',
      render: (input) => Status(ctx, () => input.session),
    });
  },
});
`;
