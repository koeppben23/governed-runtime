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
    return 'FlowGuard | ' + phase + ' | BLOCKED: ' + (message || 'See /status for recovery.');
  }
  if (view.kind === 'decision_required') {
    return 'FlowGuard | ' + phase + ' | Decision required (not approved)';
  }
  if (view.kind === 'system_work') return 'FlowGuard | ' + phase + ' | System work in progress';
  if (view.kind === 'terminal') return 'FlowGuard | ' + phase + ' | Terminal state';
  const action = view.actions && view.actions[0];
  return 'FlowGuard | ' + phase + (action ? ' | Next: ' + action.invocation : '');
}

function renderProbe(ctx, props, compact) {
  const { createEffect, createSignal, onCleanup } = require('solid-js');
  const node = document.createElement(compact ? 'span' : 'section');
  node.setAttribute('data-flowguard-ui-probe', compact ? 'header' : 'panel');
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  const label = document.createElement(compact ? 'span' : 'p');
  label.textContent = 'FlowGuard | Loading read-only state...';
  let disposed = false;
  let generation = 0;
  const [revision, refresh] = createSignal(0);

  if (!compact) {
    const title = document.createElement('h2');
    title.textContent = 'FlowGuard | Desktop UI capability probe';
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
    label.textContent = identity ? 'FlowGuard | Loading ' + session.id + '...' : 'FlowGuard: no session';
    if (!identity) return;
    void getView(session).then(
      (view) => {
        if (disposed || request !== generation || probeSessionKey(props.session) !== identity) return;
        label.textContent = probeSummary(view);
      },
      () => {
        if (disposed || request !== generation || probeSessionKey(props.session) !== identity) return;
        label.textContent = 'FlowGuard | NOT_VERIFIED (status unavailable; use /status)';
      },
    );
  });

  // Session route changes are tracked by Solid. A manual refresh is provided
  // because generic runtime-event subscriptions are not yet host-proved.
  onCleanup(() => {
    disposed = true;
    generation += 1;
  });
  return node;
}

/**
 * First native product slice. Read-only subject/reviewer/evidence information
 * comes from canonical ReviewView via GetWorkbenchReview. Native decisions
 * remain solely in the already installed, server-bound chooser.
 */
function renderWorkbench(ctx, props) {
  const { createEffect, createSignal, onCleanup } = require('solid-js');
  const root = document.createElement('section');
  root.setAttribute('data-flowguard-workbench', 'review-v1');
  root.setAttribute('aria-label', 'FlowGuard Review Workbench');
  root.style.display = 'grid';
  root.style.gap = '12px';
  root.style.padding = '16px';
  root.style.color = 'inherit';
  root.style.minWidth = '0';

  function element(tag, value, parent) {
    const node = document.createElement(tag);
    if (value !== undefined && value !== null) node.textContent = String(value);
    if (parent) parent.appendChild(node);
    return node;
  }

  function section(title, parent) {
    const card = element('section', null, parent);
    card.style.border = '1px solid currentColor';
    card.style.borderRadius = '10px';
    card.style.padding = '12px';
    card.style.minWidth = '0';
    card.style.overflowWrap = 'anywhere';
    element('h3', title, card).style.margin = '0 0 8px';
    return card;
  }

  const heading = element('h2', 'FlowGuard', root);
  heading.style.margin = '0';
  const status = element('p', 'Reading canonical governance state...', root);
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const summary = section('Current work', root);
  const reviewSection = section('Review subject and independent reviewer', root);
  const evidenceSection = section('Evidence and findings', root);
  const decisionSection = section('Decision and safe next step', root);
  const recoverySection = section('Guided recovery', root);
  const foot = element('p',
    'Read-only presentation. Reviewer ACCEPT is not operator approval. Decisions use canonical authority.',
    root);
  foot.style.fontSize = '0.85em';
  const controls = element('div', null, root);
  controls.style.display = 'flex';
  controls.style.flexWrap = 'wrap';
  controls.style.gap = '8px';
  const refreshButton = element('button', 'Refresh state', controls);
  refreshButton.type = 'button';
  const chooserButton = element('button', 'Open canonical decisions', controls);
  chooserButton.type = 'button';
  chooserButton.disabled = true;
  const [revision, refresh] = createSignal(0);
  let disposed = false;
  let generation = 0;
  let currentView = null;
  let currentReview = null;

  const refreshHandler = () => refresh((before) => before + 1);
  refreshButton.addEventListener('click', refreshHandler);

  const chooseHandler = () => {
    const session = props.session;
    if (!session || !isCurrentSession(ctx, session) ||
        !currentView || !currentReview ||
        currentView.kind !== 'decision_required' ||
        !currentView.decisionBinding ||
        currentReview.status !== 'COMPLETE' ||
        currentReview.subject.subjectBinding !== 'matched' ||
        currentReview.subject.digest !== currentView.decisionBinding.subjectDigest) {
      toast(ctx, 'The review binding is missing, incomplete or stale. Refresh before deciding.', 'error');
      return;
    }
    // Reuse exactly the installed chooser; this panel never executes a decision.
    void choose(ctx, session);
  };
  chooserButton.addEventListener('click', chooseHandler);

  function resetForLoad() {
    currentView = null;
    currentReview = null;
    chooserButton.disabled = true;
    summary.replaceChildren();
    reviewSection.replaceChildren();
    evidenceSection.replaceChildren();
    decisionSection.replaceChildren();
    recoverySection.replaceChildren();
  }

  function line(parent, label, value) {
    element('p', label + ': ' + (value === null || value === undefined ? 'NOT_VERIFIED' : value), parent);
  }

  function display(next, review) {
    resetForLoad();
    currentView = next;
    currentReview = review;
    status.textContent = next ? probeSummary(next) : 'FlowGuard state NOT_VERIFIED';
    if (!next) {
      line(summary, 'Status', 'No canonical Next Action projection');
      return;
    }
    line(summary, 'Session', next.sessionID);
    line(summary, 'Phase', next.phase);
    line(summary, 'Next', next.actions && next.actions.length ?
      next.actions.map((action) => action.invocation).join(', ') : 'None');
    if (review) {
      const subject = review.subject;
      line(reviewSection, 'Subject', subject.label);
      line(reviewSection, 'Kind / revision', subject.kind + ' / ' + (subject.revision || 'NOT_VERIFIED'));
      line(reviewSection, 'Digest', subject.digest);
      line(reviewSection, 'Content verification', subject.contentVerified);
      line(reviewSection, 'Review binding', subject.subjectBinding);
      line(reviewSection, 'Reviewer verdict (not approval)', subject.reviewerVerdict);
      line(reviewSection, 'Review status', review.status);
      if (subject.unboundReviewReason || subject.historicalReview) {
        element('p', 'Historical or unbound reviewer evidence must not be used as current approval.', reviewSection);
      }
      line(evidenceSection, 'Findings', subject.findingsTotal +
        (subject.findingsTruncated ? ' (partial)' : ''));
      for (const finding of subject.findings) {
        line(evidenceSection, finding.severity + ' / ' + finding.category, finding.message);
      }
      line(evidenceSection, 'Missing verification', subject.missingVerification.length +
        (subject.missingVerificationTruncated ? '+' : ''));
      for (const missing of subject.missingVerification) element('p', missing, evidenceSection);
      line(evidenceSection, 'ProofGraph claims', review.proof.claimsTotal +
        (review.proof.claimsTruncated ? ' (partial)' : ''));
      for (const claim of review.proof.claims) {
        line(evidenceSection, claim.critical ? 'Critical claim' : 'Claim',
          claim.statement + ' [' + (claim.verificationState || 'NOT_VERIFIED') +
          '; evidence ' + claim.evidenceCount + ']');
      }
      line(evidenceSection, 'Coverage gaps', review.proof.coverageGapCount);
      if (review.warningCodes.length || review.warningsTruncated) {
        line(evidenceSection, 'Diagnostic warnings', review.warningCodes.join(', ') +
          (review.warningsTruncated ? ' (partial)' : ''));
      }
    } else {
      line(reviewSection, 'Review', 'NOT_VERIFIED - read-only review RPC unavailable');
      line(evidenceSection, 'Evidence', 'NOT_VERIFIED');
    }

    if (next.kind === 'decision_required') {
      const binding = next.decisionBinding;
      const matches = review && binding &&
        review.status === 'COMPLETE' &&
        review.subject.subjectBinding === 'matched' &&
        review.subject.digest === binding.subjectDigest &&
        review.subject.reviewedSubjectDigest === binding.subjectDigest;
      chooserButton.disabled = !matches;
      element('p', matches
        ? 'Decision available only through the existing revision-bound native chooser.'
        : 'Decision unavailable: reviewer evidence or subject revision is not verified.',
      decisionSection);
    } else {
      element('p', next.actions && next.actions.length ?
        'Next action: ' + next.actions.map((item) => item.invocation).join(', ') +
        '. Use the existing native chooser or canonical command.' :
        'No operator decision requested by the canonical directive.', decisionSection);
    }
    if (next.blocker) {
      line(recoverySection, 'Cause', next.blocker.message);
      line(recoverySection, 'Code', next.blocker.code);
      line(recoverySection, 'Canonical recovery', next.blocker.recovery);
    } else {
      element('p', 'No active recovery instruction. Unverified state is not a successful clearance.', recoverySection);
    }
  }

  createEffect(() => {
    const session = props.session;
    revision();
    const request = ++generation;
    const key = probeSessionKey(session);
    resetForLoad();
    status.textContent = key ? 'Loading review for session ' + session.id + '...' : 'No active session';
    if (!key) return;
    void Promise.allSettled([
      getView(session),
      call(session, 'GetWorkbenchReview', { sessionID: session.id }),
    ]).then((results) => {
      if (disposed || request !== generation || probeSessionKey(props.session) !== key) return;
      const next = results[0].status === 'fulfilled' ? results[0].value : null;
      const review = results[1].status === 'fulfilled' ? results[1].value : null;
      if (next && review && (next.sessionID !== session.id || review.sessionID !== session.id ||
          (next.phase !== review.phase && review.phase !== null))) {
        display(next, null);
        return;
      }
      display(next, review);
    });
  });

  onCleanup(() => {
    disposed = true;
    generation += 1;
    refreshButton.removeEventListener('click', refreshHandler);
    chooserButton.removeEventListener('click', chooseHandler);
  });
  return root;
}

module.exports = Plugin.define({
  setup(ctx) {
    const probeTab = {
      id: 'workbench-probe',
      title: 'FlowGuard Workbench',
      closable: 'compact',
      fallback: true,
      tabbable: true,
    };
    let panelRegistered = false;
    if (Panel) {
      try {
        ctx.add(Panel, {
          id: 'workbench-probe',
          region: 'side',
          list: (input) => input.open.includes('workbench-probe') ? [probeTab] : [],
          render: (props) => renderWorkbench(ctx, props),
        });
        panelRegistered = true;
      } catch (error) {
        console.warn('[FlowGuard] Optional Desktop panel probe unavailable.', error);
      }
    }
    let headerRegistered = false;
    ctx.add(Command, {
      id: 'ui-probe',
      title: 'FlowGuard: open native Workbench (experimental)',
      description: 'Open a read-only review, evidence, and recovery workbench with the session-header status.',
      group: 'FlowGuard',
      slash: { name: 'flowguard-ui-probe' },
      run: () => {
        const session = ctx.sessions.current();
        if (!session) {
          toast(ctx, 'Open a session before inspecting FlowGuard UI.', 'default');
          return;
        }
        if (!panelRegistered || !Slot || !ctx.layout || typeof ctx.layout.open !== 'function') {
          toast(ctx, 'This Desktop build does not support the FlowGuard Panel/Slot probe.', 'error');
          return;
        }
        try {
          if (!headerRegistered) {
            ctx.add(Slot, {
              at: 'session.header',
              order: 90,
              render: (input) => renderProbe(ctx, input, true),
            });
            headerRegistered = true;
          }
          ctx.layout.open(ctx.id + ':workbench-probe', session, { tab: 'select' });
        } catch (error) {
          console.warn('[FlowGuard] Desktop Panel/Slot probe could not be opened.', error);
          toast(ctx, 'Native FlowGuard probe unavailable in this Desktop build.', 'error');
        }
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
