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
  status.textContent = 'NOT_VERIFIED · Loading canonical status...';
  const reviewLine = document.createElement('p');
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
  const { createSignal } = require('solid-js');
  const [snapshot, setSnapshot] = createSignal(null);
  let readGeneration = 0;

  async function inspect(session) {
    const key = probeSessionKey(session);
    if (!key || !isCurrentSession(ctx, session)) return;
    const generation = ++readGeneration;
    const currentRead = () => generation === readGeneration &&
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
      const base = { key: key, status: next.kind, label: 'FlowGuard · ' + (next.phase || 'NOT_VERIFIED') };
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
        const state = snapshot();
        const matched = state && state.key === key;
        const label = matched ? state.label + ' · last read' : 'FlowGuard · inspect';
        const rows = [{
          id: 'refresh',
          label: matched ? 'Refresh canonical status' : 'Inspect canonical status',
          detail: 'Read-only; no agent prompt or governance mutation',
          run: () => void inspect(input.session),
        }];
        if (matched && state.note) {
          rows.unshift({ id: 'status', label: state.note,
            detail: state.actionHint || 'Last read only; refresh for current state' });
        }
        return {
          label: label,
          title: 'FlowGuard · chat status (read-only)',
          icon: 'shield',
          tone: matched && (state.status === 'blocked' || state.status === 'not_verified' ||
            state.status === 'stale') ? 'warning' : undefined,
          rows: rows,
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
