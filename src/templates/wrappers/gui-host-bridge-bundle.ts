/** OpenCode Desktop host-capability compatibility boundary; no governance authority. */
export const GUI_HOST_BRIDGE_BUNDLE = `
function subscribeFlowGuardSessionCompletion(ctx, callback) {
  // Desktop 2.2.6 exposes servers; newer SDK types expose serverEndpoints.
  const endpoints = ctx.serverEndpoints && typeof ctx.serverEndpoints.get === 'function'
    ? ctx.serverEndpoints : ctx.servers;
  if (!endpoints || typeof endpoints.get !== 'function') return false;
  try {
    const { createKeyed } = require('@opencode/plugin/gui');
    if (typeof createKeyed !== 'function') return false;
    const { onCleanup } = require('solid-js');
    createKeyed(
      () => endpoints.get('sidecar')?.data,
      (data) => {
        if (!data || typeof data.on !== 'function') return;
        const unsubscribe = data.on('session.execution.succeeded', (event) => {
          const session = ctx.sessions.current();
          if (!session || !session.server || session.server.id !== 'sidecar' ||
              !event || !event.data || event.data.sessionID !== session.id) return;
          callback(session);
        });
        if (typeof unsubscribe === 'function') onCleanup(unsubscribe);
      },
    );
    return true;
  } catch (error) {
    console.warn('[FlowGuard] Optional chat status event refresh unavailable.', error);
    return false;
  }
}
/**
 * Bounded reconciliation for transitions that do not emit a host completion
 * event. A live event is an optimization, not an authoritative audit feed.
 * Nothing is fetched at registration or on the first pill render.
 */
/**
 * Read-only presentation polling. This is not a governance or evidence feed:
 * every failure is ignored and the canonical Next Action read remains the
 * authoritative status source. Only the newest baseline event is announced.
 */
function createFlowGuardPresentationWatcher(ctx, getPresentation, notify) {
  let timer = null;
  let disposed = false;
  let reading = false;
  let sessionKey = null;
  let cursor = null;
  let baseline = true;
  const seen = new Set();

  const reset = () => {
    sessionKey = null;
    cursor = null;
    baseline = true;
    seen.clear();
  };

  const tick = async () => {
    if (disposed || reading) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const session = ctx.sessions.current();
    if (!session || !session.server || session.server.id !== 'sidecar') {
      reset();
      return;
    }
    const key = session.server.id + ':' + session.id;
    if (key !== sessionKey) {
      sessionKey = key;
      cursor = null;
      baseline = true;
      seen.clear();
    }
    reading = true;
    try {
      const page = await getPresentation(session, cursor);
      if (disposed || key !== sessionKey) return;
      // Re-read the routed session: a switch during the read must not show
      // session A's notice in session B.
      const latest = ctx.sessions.current();
      if (!latest || !latest.server || latest.server.id !== 'sidecar' ||
          latest.server.id + ':' + latest.id !== key) return;
      const events = page && Array.isArray(page.events) ? page.events : [];
      for (let index = 0; index < events.length; index++) {
        const event = events[index];
        if (!event || typeof event.id !== 'string' || seen.has(event.id)) continue;
        seen.add(event.id);
        if (!baseline || index === events.length - 1) notify(event);
      }
      cursor = page && page.cursor ? page.cursor : cursor;
      baseline = false;
      if (seen.size > 512) {
        const keep = [...seen].slice(-256);
        seen.clear();
        for (const id of keep) seen.add(id);
      }
    } catch {
      // Presentation is an optional convenience channel, never an authority check.
    } finally {
      reading = false;
    }
  };

  return {
    start: () => {
      if (timer !== null || disposed) return;
      timer = setInterval(() => void tick().catch(() => {}), 1000);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop: () => {
      disposed = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      reset();
    },
    tick,
  };
}

function createFlowGuardStatusReconciler(ctx, callback) {
  const intervalMs = 5000;
  let timer = null;
  let disposed = false;
  const tick = () => {
    if (disposed) return;
    // Hidden windows must not poll; an active session is the only scope.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const session = ctx.sessions.current();
    if (!session || !session.server || session.server.id !== 'sidecar') return;
    callback(session);
  };
  return {
    begin: () => {
      if (disposed || timer !== null) return;
      timer = setInterval(tick, intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop: () => {
      disposed = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

`;
