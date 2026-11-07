import { GUI_DIAGNOSTICS_BUNDLE } from './gui-diagnostics-bundle.js';
import { GUI_CHAT_CARD_BUNDLE } from './gui-chat-card-bundle.js';

export const GUI_PLUGIN_BUNDLE = `\
/** FlowGuard optional OpenCode Desktop GUI; never a governance authority. */
const { Plugin, Command, Panel, Slot, CodeBlock } = require('@opencode/plugin/gui');

const RPC_ID = 'flowguard-governance';
// Diagnostic completion, distinct from workflow terminal-phase membership.
const REVIEW_STATUS_COMPLETE = 'COMPLETE';

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
${GUI_DIAGNOSTICS_BUNDLE}
${GUI_CHAT_CARD_BUNDLE}

function renderWorkbench(ctx, props) {
  const { createEffect, createSignal, onCleanup } = require('solid-js');
  const root = document.createElement('section');
  root.setAttribute('data-flowguard-workbench', 'review-v1');
  root.setAttribute('aria-label', 'FlowGuard Review Workbench');
  root.style.display = 'grid';
  root.style.gap = '10px';
  root.style.padding = '12px';
  root.style.color = 'inherit';
  root.style.fontFamily = 'inherit';
  root.style.maxWidth = '100%';
  root.style.minWidth = '0';

  function element(tag, value, parent) {
    const node = document.createElement(tag);
    if (value !== undefined && value !== null) node.textContent = String(value);
    if (parent) parent.appendChild(node);
    return node;
  }

  function section(title, parent) {
    // Native details/summary supplies keyboard, focus and screen-reader support.
    const card = element('details', null, parent);
    card.style.border = '1px solid color-mix(in srgb, currentColor 22%, transparent)';
    card.style.borderRadius = '12px';
    card.style.padding = '10px 14px';
    card.style.minWidth = '0';
    card.style.overflowWrap = 'anywhere';
    card.style.fontSize = '0.93em';
    const header = element('summary', title, card);
    header.style.cursor = 'pointer';
    header.style.fontWeight = '600';
    header.style.lineHeight = '1.5';
    header.style.padding = '2px 0';
    return card;
  }

  const heading = element('h2', 'FlowGuard', root);
  heading.style.margin = '0';
  heading.style.fontSize = '1.1rem';
  const status = element('p', 'Reading canonical governance state...', root);
  status.style.margin = '0';
  status.style.lineHeight = '1.5';
  status.style.fontWeight = '500';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const controls = element('div', null, root);
  controls.style.display = 'flex';
  controls.style.flexWrap = 'wrap';
  controls.style.gap = '8px';
  const chooserButton = element('button', 'Open canonical decisions', controls);
  chooserButton.type = 'button';
  chooserButton.disabled = true;
  chooserButton.style.display = 'none';
  const refreshButton = element('button', 'Refresh state', controls);
  refreshButton.type = 'button';
  const detailsButton = element('button', 'Expand all details', controls);
  detailsButton.type = 'button';

  const summary = section('Current work', root);
  const reviewSection = section('Independent review', root);
  const evidenceSection = section('Findings and evidence', root);
  const decisionSection = section('Safe decision or next action', root);
  const timelineSection = section('Review transport timeline', root);
  const sessionSection = section('Session explorer', root);
  const auditSection = section('Verified audit chronology', root);
  const recoverySection = section('Guided recovery', root);
  const cards = [summary, reviewSection, evidenceSection, decisionSection, timelineSection,
    sessionSection, auditSection, recoverySection];
  const foot = element('p',
    'Reviewer ACCEPT is not operator approval. All decisions use canonical server authority.',
    root);
  foot.style.fontSize = '0.8em';
  foot.style.opacity = '0.78';
  foot.style.margin = '2px 0';
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
        !currentView || currentView.sessionID !== session.id) {
      toast(ctx, 'The session or FlowGuard state changed. Refresh before acting.', 'error');
      return;
    }
    const isWorkflow = currentView.kind === 'choose_flow' || currentView.kind === 'next_action';
    if (isWorkflow) {
      if (currentView.stateDigest === null || !currentView.actions ||
          currentView.actions.length === 0) {
        toast(ctx, 'No canonical FlowGuard action is currently available.', 'error');
        return;
      }
    } else if (currentView.kind !== 'decision_required' || !currentReview ||
        currentReview.sessionID !== session.id ||
        !currentView.decisionBinding ||
        currentReview.status !== REVIEW_STATUS_COMPLETE ||
        currentReview.subject.subjectBinding !== 'matched' ||
        currentReview.subject.digest !== currentView.decisionBinding.subjectDigest ||
        currentReview.subject.reviewedSubjectDigest !== currentView.decisionBinding.subjectDigest) {
      toast(ctx, 'The review binding is missing, incomplete or stale. Refresh before deciding.', 'error');
      return;
    }
    void choose(ctx, session);
  };
  chooserButton.addEventListener('click', chooseHandler);

  const detailsHandler = () => {
    const expand = cards.some((card) => !card.open);
    for (const card of cards) card.open = expand;
    detailsButton.textContent = expand ? 'Collapse details' : 'Expand all details';
  };
  detailsButton.addEventListener('click', detailsHandler);

  function resetForLoad() {
    currentView = null;
    currentReview = null;
    chooserButton.disabled = true;
    chooserButton.style.display = 'none';
    for (const card of cards) {
      while (card.childNodes.length > 1) card.removeChild(card.lastChild);
    }
  }

  function line(parent, label, value) {
    element('p', label + ': ' + (value === null || value === undefined ? 'NOT_VERIFIED' : value), parent);
  }

  function display(next, review, diagnostics) {
    resetForLoad();
    currentView = next;
    currentReview = review;
    status.textContent = next ? probeSummary(next) : 'FlowGuard state NOT_VERIFIED';
    // Overview stays visible; substantive detail expands only for a live gate or blocker.
    summary.open = true;
    reviewSection.open = Boolean(next && next.kind === 'decision_required');
    evidenceSection.open = false;
    decisionSection.open = Boolean(next && next.kind === 'decision_required');
    timelineSection.open = false;
    sessionSection.open = false;
    auditSection.open = false;
      recoverySection.open = Boolean(next && next.kind === 'blocked' && next.blocker);
    detailsButton.textContent = 'Expand all details';
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
      line(reviewSection, 'Reviewer verdict (not approval)', subject.reviewerVerdict);
      line(reviewSection, 'Review status', review.status);
      const forensic = element('details', null, reviewSection);
      forensic.style.marginTop = '8px';
      const forensicSummary = element('summary', 'Technical binding details', forensic);
      forensicSummary.style.cursor = 'pointer';
      line(forensic, 'Digest', subject.digest);
      line(forensic, 'Content verification', subject.contentVerified);
      line(forensic, 'Review binding', subject.subjectBinding);
      line(forensic, 'Reviewed digest', subject.reviewedSubjectDigest);
      if (subject.unboundReviewReason || subject.historicalReview) {
        element('p', 'Historical or unbound reviewer evidence must not be used as current approval.', reviewSection);
      }
      line(evidenceSection, 'Findings', subject.findingsTotal +
        (subject.findingsTruncated ? ' (partial)' : ''));
      const needsAttention = subject.findingsTotal > 0 ||
        subject.missingVerification.length > 0 ||
        review.proof.coverageGapCount > 0 ||
        review.warningCodes.length > 0;
      evidenceSection.open = Boolean(next.kind === 'decision_required' && needsAttention);
      for (const finding of subject.findings) {
        line(evidenceSection, finding.severity + ' / ' + finding.category, finding.message);
      }
      line(evidenceSection, 'Missing verification', subject.missingVerification.length +
        (subject.missingVerificationTruncated ? '+' : ''));
      for (const missing of subject.missingVerification) element('p', missing, evidenceSection);
      line(evidenceSection, 'ProofGraph claims', review.proof.claimsTotal +
        (review.proof.claimsTruncated ? ' (partial)' : ''));
      for (const claim of review.proof.claims) {
        const claimCard = element('section', null, evidenceSection);
        claimCard.style.borderLeft = '3px solid currentColor';
        claimCard.style.paddingLeft = '10px';
        claimCard.style.margin = '10px 0';
        const claimLabel = claim.critical ? 'Critical claim' : 'Claim';
        const claimState = claim.verificationState || 'NOT_VERIFIED';
        const claimHeader = element('p', claimLabel + ' | ' + claimState, claimCard);
        claimHeader.style.fontWeight = '600';
        claimHeader.style.marginBottom = '4px';
        element('p', claim.statement, claimCard);
        line(claimCard, 'Positive evidence references', claim.evidenceCount);
        if (claim.counterexampleCount !== undefined) {
          line(claimCard, 'Counterexample references', claim.counterexampleCount);
        }
        if (claim.certificateBinding !== undefined) {
          line(claimCard, 'Certificate binding', claim.certificateBinding);
        }
      }
      line(evidenceSection, 'Coverage gaps', review.proof.coverageGapCount);
      if (review.warningCodes.length || review.warningsTruncated) {
        line(evidenceSection, 'Diagnostic warnings', review.warningCodes.join(', ') +
          (review.warningsTruncated ? ' (partial)' : ''));
      }
      const timeline = review.timeline;
      if (!timeline || timeline.status === 'not_available') {
        element('p', 'Review transport events NOT_VERIFIED - no linked review-assurance history.', timelineSection);
      } else {
        line(timelineSection, 'Source', 'Persisted review assurance (not the full workflow audit)');
        line(timelineSection, 'Events', timeline.total +
          (timeline.status === 'truncated' ? ' (partial - newest entries only)' : ''));
        const entries = element('ol', null, timelineSection);
        entries.style.paddingLeft = '20px';
        entries.style.margin = '8px 0';
        for (const event of timeline.events) {
          const item = element('li', null, entries);
          element('strong', event.label + ' | ' + event.state, item);
          const time = element('p', event.at, item);
          time.style.margin = '2px 0 8px';
          time.style.opacity = '0.75';
        }
      }
    } else {
      line(reviewSection, 'Review', 'NOT_VERIFIED - read-only review RPC unavailable');
      line(evidenceSection, 'Evidence', 'NOT_VERIFIED');
      element('p', 'Review transport timeline NOT_VERIFIED.', timelineSection);
    }

    renderDiagnosticsSections(element, line, sessionSection, auditSection, diagnostics);

    if (next.kind === 'decision_required') {
      const binding = next.decisionBinding;
      const matches = review && binding &&
        review.status === REVIEW_STATUS_COMPLETE &&
        review.subject.subjectBinding === 'matched' &&
        review.subject.digest === binding.subjectDigest &&
        review.subject.reviewedSubjectDigest === binding.subjectDigest;
      chooserButton.style.display = '';
      chooserButton.textContent = 'Review operator decisions';
      chooserButton.disabled = !matches;
      element('p', matches
        ? 'Independent review complete. Operator approval is still required.'
        : 'Decision unavailable: reviewer evidence or subject revision is not verified.',
      decisionSection);
    } else {
      const canChoose = (next.kind === 'choose_flow' || next.kind === 'next_action') &&
        next.stateDigest !== null && next.actions && next.actions.length > 0;
      chooserButton.style.display = canChoose ? '' : 'none';
      chooserButton.textContent = next.kind === 'choose_flow' ?
        'Choose workflow' : 'Open next action';
      chooserButton.disabled = !canChoose;
      element('p', next.actions && next.actions.length ?
        'Next action: ' + next.actions.map((item) => item.invocation).join(', ') +
        '. Open the canonical chooser or use the existing command.' :
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
      call(session, 'GetWorkbenchDiagnostics', { sessionID: session.id }),
    ]).then((results) => {
      if (disposed || request !== generation || probeSessionKey(props.session) !== key) return;
      const next = results[0].status === 'fulfilled' ? results[0].value : null;
      const review = results[1].status === 'fulfilled' ? results[1].value : null;
      let diagnostics = results[2].status === 'fulfilled' ? results[2].value : null;
      if (diagnostics && diagnostics.sessionID !== session.id) diagnostics = null;
      if (next && review && (next.sessionID !== session.id || review.sessionID !== session.id ||
          (next.phase !== review.phase && review.phase !== null))) {
        display(next, null, null);
        return;
      }
      display(next, review, diagnostics);
    });
  });

  onCleanup(() => {
    disposed = true;
    generation += 1;
    refreshButton.removeEventListener('click', refreshHandler);
    chooserButton.removeEventListener('click', chooseHandler);
    detailsButton.removeEventListener('click', detailsHandler);
  });
  return root;
}

module.exports = Plugin.define({
  setup(ctx) {
    // A dedicated language prevents interference with regular Markdown.
    // Invalid or incomplete cards fall back to highlighted source.
    if (CodeBlock) {
      try {
        ctx.add(CodeBlock, {
          languages: ['flowguard-live'],
          render: (props) => props.code.trim() === 'v1' && props.session ?
            renderFlowGuardChatCard(ctx, props) : undefined,
        });
      } catch (error) {
        console.warn('[FlowGuard] Inline chat cards are unavailable in this Desktop build.', error);
      }
    }
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
      id: 'show-chat-card',
      title: 'FlowGuard: show live status in chat (experimental)',
      description: 'Insert a read-only FlowGuard live status card into the current chat.',
      group: 'FlowGuard',
      slash: { name: 'flowguard-inline' },
      run: () => {
        const session = ctx.sessions.current();
        if (!session) {
          toast(ctx, 'Open a session before requesting a FlowGuard chat card.', 'default');
          return;
        }
        void session.server.client.session.command({
          sessionID: session.id,
          name: 'flowguard-card',
          text: '',
        }).catch((error) => {
          console.warn('[FlowGuard] Inline chat card command unavailable.', error);
          toast(ctx, 'Could not insert FlowGuard card; use /status instead.', 'error');
        });
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
