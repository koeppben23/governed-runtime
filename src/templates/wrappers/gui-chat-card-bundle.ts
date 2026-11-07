/** Read-only inline chat cards. Only official CodeBlock surface; no decision authority. */
export const GUI_CHAT_CARD_BUNDLE = `
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
        const review = await call(session, 'GetWorkbenchReview', { sessionID: session.id });
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
function registerFlowGuardChatContributions(ctx, Command, CodeBlock) {
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
}
`;
