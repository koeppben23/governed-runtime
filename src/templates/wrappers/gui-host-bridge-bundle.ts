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
 * A progress event only invalidates a read-only snapshot. No polling, model
 * prompt or state mutation. Read the current generation before displaying it.
 */
function createFlowGuardPresentationWatcher(ctx, getPresentation, notify) {
  let disposed = false;
  let reading = false;
  let queued = false;
  let sessionKey = null;
  let mounted = false;
  let generation = 0;
  const routedKey = (session) => session && session.server && session.location ?
    session.server.id + ':' + session.id + ':' + session.location.directory : null;

  const tick = async () => {
    if (disposed) return;
    if (reading) { queued = true; return; }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const session = ctx.sessions.current();
    if (!session || !session.server || session.server.id !== 'sidecar') {
      return;
    }
    const key = routedKey(session);
    const readGeneration = generation;
    sessionKey = key;
    reading = true;
    try {
      const page = await getPresentation(session);
      if (disposed || readGeneration !== generation || key !== sessionKey) return;
      // Re-read the routed session: a switch during the read must not show
      // session A's notice in session B.
      const latest = ctx.sessions.current();
      if (!latest || !latest.server || latest.server.id !== 'sidecar' || routedKey(latest) !== key) return;
      const events = page && page.sessionID === session.id && Array.isArray(page.events) ? page.events : [];
      const event = events[events.length - 1];
      notify(event && event.stage !== 'finished' ? event : null);
    } catch (error) {
      console.warn('[FlowGuard] Progress snapshot unavailable.', error);
      const latest = ctx.sessions.current();
      if (!disposed && readGeneration === generation && routedKey(latest) === key) notify(null);
    } finally {
      reading = false;
      if (queued && !disposed) { queued = false; void tick(); }
    }
  };

  // Own subscriptions in plugin setup, never in the reactive pill renderer.
  if (ctx.servers && typeof ctx.servers.get === 'function') {
    const { createKeyed } = require('@opencode/plugin/gui');
    const { onCleanup } = require('solid-js');
    createKeyed(() => ctx.servers.get('sidecar')?.data, (data) => {
      generation += 1;
      if (mounted) notify(null);
      if (!data || typeof data.on !== 'function') return;
      const off = data.on('rpc.flowguard-governance.PresentationUpdated', (event) => {
        const session = ctx.sessions.current();
        if (!mounted || !session || !event || !event.data || event.data.sessionID !== session.id ||
            !event.location || !session.location || event.location.directory !== session.location.directory) return;
        void tick();
      });
      onCleanup(off);
      if (mounted) void tick();
    });
  }

  return {
    start: () => {
      if (disposed) return;
      mounted = true;
      const session = ctx.sessions.current();
      const key = routedKey(session);
      if (key !== sessionKey) { generation += 1; notify(null); void tick(); }
    },
    stop: () => {
      disposed = true;
      generation += 1;
      mounted = false;
      sessionKey = null;
      queued = false;
    },
    tick,
  };
}

/**
 * Bounded reconciliation for transitions that do not emit a host completion
 * event. A live event is an optimization, not an authoritative audit feed.
 * Nothing is fetched at registration or on the first pill render.
 */
function createFlowGuardStatusReconciler(ctx, callback) {
  const intervalMs = 30000;
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
