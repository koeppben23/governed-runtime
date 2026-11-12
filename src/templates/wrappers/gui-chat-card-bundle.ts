/** Read-only inline chat cards. Only official CodeBlock surface; no decision authority. */
export const GUI_CHAT_CARD_BUNDLE = `
function probeSessionKey(session) {
  return session && session.server ? session.server.id + ':' + session.id : null;
}

/** Inline FlowGuard cards are live diagnostics, never historic approvals. */
function renderFlowGuardChatCard(ctx, props) {
  const { createEffect, createSignal, onCleanup } = require('solid-js');
  const root = document.createElement('section');
  root.setAttribute('data-flowguard-chat-card', 'v1');
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'FlowGuard live status card');
  root.style.border = '1px solid currentColor';
  root.style.borderRadius = '8px';
  root.style.padding = '12px';
  root.style.minHeight = '92px';
  root.style.margin = '4px 0';
  const heading = document.createElement('strong');
  heading.textContent = 'FlowGuard · Live session state';
  const note = document.createElement('p');
  note.textContent = 'Read-only current state, not a historical decision or authorization.';
  note.style.opacity = '0.8';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  status.textContent = 'NOT_VERIFIED · Loading canonical status...';
  const reviewLine = document.createElement('p');
  reviewLine.setAttribute('aria-live', 'polite');
  reviewLine.setAttribute('aria-atomic', 'true');
  const refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.textContent = 'Refresh live status';
  root.appendChild(heading);
  root.appendChild(note);
  root.appendChild(status);
  root.appendChild(reviewLine);
  root.appendChild(refreshButton);

  let disposed = false;
  let generation = 0;
  const [revision, refresh] = createSignal(0);
  const refreshHandler = () => refresh((value) => value + 1);
  refreshButton.addEventListener('click', refreshHandler);
  function current(key) {
    return !disposed && generation === key.generation &&
      probeSessionKey(props.session) === key.session &&
      isCurrentSession(ctx, props.session);
  }
  createEffect(() => {
    revision();
    const session = props.session;
    const identity = probeSessionKey(session);
    const request = { generation: ++generation, session: identity };
    status.textContent = identity ? 'NOT_VERIFIED · Loading canonical status...' : 'NOT_VERIFIED · No mounted session';
    reviewLine.textContent = '';
    if (!identity) return;
    if (!isCurrentSession(ctx, session)) {
      status.textContent = 'NOT_VERIFIED · This chat session is not current. Open it to inspect live state.';
      return;
    }
    void getView(session).then(async (next) => {
      if (!current(request)) return;
      if (!next || next.sessionID !== session.id || next.stateDigest === null) {
        status.textContent = 'NOT_VERIFIED · Canonical state is unavailable. Use /status.';
        return;
      }
      status.textContent = (next.phase || 'NOT_VERIFIED') + ' · ' + next.title;
      if (next.kind === 'blocked') {
        const blocker = next.blocker;
        reviewLine.textContent = 'BLOCKED · ' + (blocker && blocker.code ? blocker.code : 'NOT_VERIFIED') +
          (blocker && blocker.recovery ? ' · Recovery: ' + blocker.recovery : '');
        return;
      }
      if (next.kind !== 'decision_required') {
        const actions = Array.isArray(next.actions) ? next.actions.slice(0, 3) : [];
        reviewLine.textContent = actions.length ?
          'Available commands: ' + actions.map((action) => action.invocation).join(', ') :
          'No operator action requested.';
        return;
      }
      reviewLine.textContent = 'Reviewer evidence NOT_VERIFIED · operator approval not recorded here.';
      try {
        const review = await flowguardGuiRpcClient(session).getWorkbenchReview();
        if (!current(request)) return;
        const subject = review && review.subject;
        const binding = next.decisionBinding;
        const valid = review && review.sessionID === session.id && review.phase === next.phase &&
          review.status === REVIEW_STATUS_COMPLETE && binding && subject &&
          subject.subjectBinding === 'matched' &&
          subject.digest === binding.subjectDigest &&
          subject.reviewedSubjectDigest === binding.subjectDigest;
        if (!valid) return;
        // Prevent two individually valid RPC responses from spanning a phase or
        // evidence/state revision change. This renderer never authorizes a decision.
        const fresh = await getView(session);
        if (!current(request)) return;
        if (!fresh || fresh.sessionID !== session.id ||
            fresh.kind !== next.kind || fresh.phase !== next.phase ||
            fresh.stateDigest !== next.stateDigest ||
            fresh.policyDigest !== next.policyDigest ||
            !sameBinding(fresh.decisionBinding, next.decisionBinding)) {
          status.textContent = 'STALE · FlowGuard changed during the read. Refresh this card.';
          reviewLine.textContent = 'Reviewer evidence NOT_VERIFIED for the current revision.';
          return;
        }
        reviewLine.textContent = 'Independent reviewer: ' + subject.reviewerVerdict +
          ' · Findings: ' + subject.findingsTotal +
          ' · Missing verification: ' + subject.missingVerification.length +
          ' · Operator decision still required; open the canonical chooser.';
      } catch (_) {
        if (current(request)) reviewLine.textContent = 'Reviewer evidence NOT_VERIFIED · use /status.';
      }
    }, () => {
      if (current(request)) status.textContent = 'NOT_VERIFIED · Read-only RPC unavailable. Use /status.';
    });
  });
  onCleanup(() => {
    disposed = true;
    generation++;
    refreshButton.removeEventListener('click', refreshHandler);
  });
  return root;
}
function registerFlowGuardChatContributions(ctx, Command, CodeBlock, ComposerPill) {
  // A dedicated code language enables future explicitly authored chat content.
  // This hook only transforms existing messages; it never inserts a model turn.
  if (CodeBlock) {
    try {
      ctx.add(CodeBlock, {
        languages: ['flowguard-live'],
        render: (props) => props.code.trim() === 'v1' && props.session ?
          renderFlowGuardChatCard(ctx, props) : undefined,
      });
    } catch (error) {
      console.warn('[FlowGuard] Inline chat renderer unavailable.', error);
    }
  }

  // The official ComposerPill surface is part of the chat screen but not
  // the conversation transcript. No agent/model content is created.
  if (!ComposerPill) return;
  const { createSignal, onCleanup } = require('solid-js');
  const [snapshot, setSnapshot] = createSignal(null);
  const [presentation, setPresentation] = createSignal(null);
  const [latestReport, setLatestReport] = createSignal(null);
  function openChoice(session) {
    if (disposed || !isCurrentSession(ctx, session)) return;
    void choose(ctx, session, () => !disposed).catch(() => {
      if (!disposed && isCurrentSession(ctx, session))
        toast(ctx, 'FlowGuard action could not be confirmed. Read /status before retrying.', 'error');
    });
  }
  async function openReport(session) {
    try {
      const next = await getView(session);
      if (disposed || !isCurrentSession(ctx, session) || !next || next.sessionID !== session.id) return;
      const report = latestReport();
      const reportText = report && report.sessionID === session.id ? report.message : null;
      await ctx.dialogs.alert({ title: 'FlowGuard session and report',
        description: [next.summary, reportText].filter(Boolean).join('\\n\\n') ||
          'Canonical FlowGuard status is unavailable. Use /status for recovery.' });
    } catch (_) {
      if (!disposed && isCurrentSession(ctx, session))
        toast(ctx, 'FlowGuard report unavailable. Use /status.', 'error');
    }
  }
  let announcedPresentation = null;
  function announceCurrentPresentation(session, next) {
    const event = presentation();
    if (!event || event.sessionID !== session.id || event.kind === 'report' ||
        event.phase !== next.phase || event.id === announcedPresentation) return;
    announcedPresentation = event.id;
    toast(ctx, event.message, event.kind === 'decision' ? 'success' : 'default');
    // An explicit Start notice can open the chooser, never choose a workflow.
    if (event.kind === 'notice' && next.kind === 'choose_flow' && !ctx.dialogs.active())
      openChoice(session);
  }
  const presentationWatcher = createFlowGuardPresentationWatcher(ctx,
    (session, after) => flowguardGuiRpcClient(session).getPresentation(after),
    (event) => {
      const current = ctx.sessions.current();
      if (!current || event.sessionID !== current.id) return;
      setPresentation(event);
      void inspect(current);
      if (event.kind === 'report') {
        setLatestReport(event);
        toast(ctx, 'FlowGuard report ready. Open the FlowGuard status pill to read it.', 'default');
        return;
      }
      // A cached phase can lag a legitimate new event. Announce only after
      // reconciliation, rather than rejecting new progress against that cache.
    });
  onCleanup(() => presentationWatcher.stop());
  let readGeneration = 0;
  let reading = false;
  let queuedSession = null;
  let disposed = false;
  let inspectedSession = null;
  function inspect(session) {
    if (disposed) return;
    if (reading) {
      // Collapse multiple host events/timer ticks into one later canonical read.
      queuedSession = session;
      return;
    }
    reading = true;
    void inspectOnce(session).finally(() => {
      reading = false;
      const next = queuedSession;
      queuedSession = null;
      if (next && isCurrentSession(ctx, next)) inspect(next);
    });
  }
  const reconciler = createFlowGuardStatusReconciler(ctx, (session) => { void inspect(session); });
  onCleanup(() => {
    disposed = true;
    readGeneration += 1;
    queuedSession = null;
    reconciler.stop();
  });

  async function inspectOnce(session) {
    const key = probeSessionKey(session);
    if (!key || !isCurrentSession(ctx, session)) return;
    const generation = ++readGeneration;
    const currentRead = () => !disposed && generation === readGeneration &&
      isCurrentSession(ctx, session) && probeSessionKey(ctx.sessions.current()) === key;
    setSnapshot({ key: key, status: 'loading', label: 'FlowGuard · reading', note: 'Read-only query' });
    try {
      const next = await getView(session);
      if (!currentRead()) return;
      if (!next || next.sessionID !== session.id || !next.stateDigest) {
        setSnapshot({ key: key, status: 'not_verified', label: 'FlowGuard · NOT_VERIFIED',
          note: 'Canonical state unavailable. Use /status.' });
        return;
      }
      announceCurrentPresentation(session, next);
      const base = { key: key, phase: next.phase, summary: next.summary,
        status: next.kind, label: 'FlowGuard · ' + (next.phase || 'NOT_VERIFIED'),
        implementationAction: next.kind === 'next_action' && next.phase === 'IMPLEMENTATION' &&
          Array.isArray(next.actions) ? next.actions.find((action) => action.invocation === '/implement') : null };
      if (next.kind === 'blocked') {
        const blocker = next.blocker;
        setSnapshot({ ...base, status: 'blocked', note: blocker && blocker.code ?
          blocker.code + ' · ' + (blocker.recovery || 'See /why') : 'BLOCKED · See /why' });
        return;
      }
      if (next.kind !== 'decision_required') {
        const actions = Array.isArray(next.actions) ? next.actions.slice(0, 3) : [];
        setSnapshot({ ...base, note: next.title,
          actionHint: actions.map((action) => action.invocation).join(', ') });
        return;
      }
      // A review gate is NEVER an approval: cross-RPC binding and a repeat
      // canonical read must agree before displaying independent reviewer info.
      const notVerified = { ...base, status: 'not_verified',
        note: 'Reviewer evidence NOT_VERIFIED · operator decision not recorded.' };
      setSnapshot(notVerified);
      const review = await flowguardGuiRpcClient(session).getWorkbenchReview();
      if (!currentRead()) return;
      const subject = review && review.subject;
      const binding = next.decisionBinding;
      const matches = review && review.sessionID === session.id && review.phase === next.phase &&
        review.status === REVIEW_STATUS_COMPLETE && binding && subject &&
        subject.subjectBinding === 'matched' && subject.digest === binding.subjectDigest &&
        subject.reviewedSubjectDigest === binding.subjectDigest;
      if (!matches) return;
      const fresh = await getView(session);
      if (!currentRead()) return;
      if (!fresh || fresh.sessionID !== next.sessionID || fresh.kind !== next.kind ||
          fresh.phase !== next.phase || fresh.stateDigest !== next.stateDigest ||
          fresh.policyDigest !== next.policyDigest ||
          !sameBinding(fresh.decisionBinding, next.decisionBinding)) {
        setSnapshot({ ...base, status: 'stale',
          note: 'STALE · state changed during diagnostic read; refresh.' });
        return;
      }
      setSnapshot({ ...base, status: 'decision_required',
        note: 'Independent review: ' + subject.reviewerVerdict +
          ' · Findings: ' + subject.findingsTotal +
          ' · Operator decision still required (not approved).' });
    } catch (error) {
      if (currentRead()) {
        setSnapshot({ key: key, status: 'not_verified', label: 'FlowGuard · NOT_VERIFIED',
          note: 'Read-only status unavailable; use /status.' });
      }
    }
  }

  subscribeFlowGuardSessionCompletion(ctx, (session) => { void inspect(session); });

  try {
    ctx.add(ComposerPill, {
      id: 'flowguard-chat-status',
      order: 80,
      show: (input) => {
        const key = probeSessionKey(input.session);
        if (!key || !isCurrentSession(ctx, input.session)) return undefined;
        reconciler.begin();
        // Start only when the pill is actually mounted; a hidden/unmounted
        // surface must not poll the server.
        presentationWatcher.start();
        if (inspectedSession !== key) {
          inspectedSession = key;
          void inspect(input.session);
        }
        const state = snapshot();
        const matched = state && state.key === key;
        const latest = presentation();
        const latestForSession = latest && latest.sessionID === input.session.id &&
          matched && state.status !== 'loading' && latest.phase === state.phase ? latest : null;
        const label = matched && state.status !== 'loading' ? state.label : latestForSession
          ? 'FlowGuard · ' + latestForSession.kind + (latestForSession.phase ? ' · ' + latestForSession.phase : '')
          : matched ? state.label + ' · last read' : 'FlowGuard · inspect';
        const rows = [{
          id: 'refresh',
          label: matched ? 'Refresh canonical status' : 'Inspect canonical status',
          detail: 'Read-only; no agent prompt or governance mutation',
          run: () => void inspect(input.session),
        }];
        if (matched && (state.status === 'choose_flow' || state.status === 'next_action' ||
            state.status === 'decision_required')) {
          rows.unshift({ id: 'choose',
            label: state.status === 'choose_flow' ? 'Choose workflow' : 'Open next action or decision',
            detail: state.actionHint || 'Re-read canonical state before any action',
            run: () => openChoice(input.session) });
        }
        const report = latestReport();
        if ((matched && state.summary) || (report && report.sessionID === input.session.id)) {
          rows.push({ id: 'report', label: 'Read Start, approval and check results',
            detail: 'Read-only canonical session report',
            run: () => void openReport(input.session) });
        }
        if (latestForSession) {
          rows.unshift({ id: 'presentation', label: latestForSession.message,
            detail: latestForSession.kind + ' · ' + latestForSession.occurredAt });
        }
        if (matched && state.note) {
          rows.unshift({ id: 'status', label: state.note,
            detail: state.actionHint || 'Last read only; refresh for current state' });
        }
        const presentationTone = latestForSession && latestForSession.kind === 'decision'
          ? 'success' : latestForSession && latestForSession.kind === 'validation' ? 'warning' : undefined;
        return {
          label: label,
          title: 'FlowGuard · chat status (read-only)',
          icon: 'shield',
          tone: presentationTone ?? (matched && (state.status === 'blocked' || state.status === 'not_verified' ||
            state.status === 'stale') ? 'warning' : undefined),
          rows: rows,
        };
      },
    });
    // Keep progress/status separate from the explicit operator action. A
    // completed baseline must expose /implement without opening a status menu.
    ctx.add(ComposerPill, {
      id: 'flowguard-implement-action',
      order: 81,
      show: (input) => {
        const key = probeSessionKey(input.session);
        const state = snapshot();
        if (disposed || !key || !isCurrentSession(ctx, input.session) || !state ||
            state.key !== key || state.status !== 'next_action' || !state.implementationAction) return undefined;
        return {
          label: state.implementationAction.invocation,
          title: state.implementationAction.description,
          icon: 'shield',
          run: () => openChoice(input.session),
        };
      },
    });
  } catch (error) {
    console.warn('[FlowGuard] Composer status pill unavailable.', error);
    return;
  }

  ctx.add(Command, {
    id: 'show-chat-card',
    title: 'FlowGuard: inspect status beside chat (experimental)',
    description: 'Refresh the read-only composer status; never inserts a chat message.',
    group: 'FlowGuard',
    slash: { name: 'flowguard-inline' },
    run: () => {
      const session = ctx.sessions.current();
      if (!session) {
        toast(ctx, 'Open a session before inspecting FlowGuard.', 'default');
        return;
      }
      void inspect(session);
    },
  });
}
`;
