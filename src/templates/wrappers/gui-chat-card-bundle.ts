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
    if (!identity || !isCurrentSession(ctx, session)) return;
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
`;
