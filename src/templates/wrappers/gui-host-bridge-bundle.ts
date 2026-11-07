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
`;
