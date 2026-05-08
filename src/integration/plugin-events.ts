/**
 * @module integration/plugin-events
 * @description OpenCode event hook handlers for the FlowGuard plugin.
 *
 * Implements handlers for:
 * - session.error: Logs unhandled session errors to the audit trail
 * - session.idle: Cleans stale in-memory caches for terminated sessions
 *
 * All handlers are fail-safe: errors are logged but never thrown.
 * This prevents event-hook failures from breaking the host runtime.
 *
 * @see https://opencode.ai/docs/plugins (Hooks > event)
 * @version v1
 */

/**
 * OpenCode Event shape (from @opencode-ai/sdk, used by plugin event hooks).
 *
 * We define this locally because @opencode-ai/plugin imports but does not
 * re-export the Event type from @opencode-ai/sdk.
 */
export interface PluginEvent {
  readonly type: string;
  readonly properties?: Record<string, unknown>;
}

/**
 * Dependencies injected from the plugin composition root.
 */
export interface EventHandlerDeps {
  log: {
    info(service: string, message: string, extra?: Record<string, unknown>): void;
    warn(service: string, message: string, extra?: Record<string, unknown>): void;
    error(service: string, message: string, extra?: Record<string, unknown>): void;
  };
  /**
   * Remove stale enforcement/chain state for a specific session.
   * Called on session termination events to prevent memory leaks.
   */
  cleanupSession(sessionId: string): void;
}

/**
 * Session-relevant event types that FlowGuard handles.
 *
 * OpenCode emits many event types; we only act on a targeted subset
 * to minimize coupling and runtime overhead.
 */
const HANDLED_EVENT_TYPES = new Set(['session.error', 'session.delete']);

/**
 * Handle an OpenCode event.
 *
 * Fail-safe: never throws. All errors are caught and logged.
 */
export async function handleEvent(deps: EventHandlerDeps, event: PluginEvent): Promise<void> {
  if (!event || !event.type) return;
  if (!HANDLED_EVENT_TYPES.has(event.type)) return;

  try {
    switch (event.type) {
      case 'session.error': {
        const properties = event.properties;
        const sessionId =
          typeof properties?.sessionID === 'string' ? properties.sessionID : 'unknown';
        const errorMessage =
          typeof properties?.error === 'string'
            ? properties.error
            : typeof properties?.message === 'string'
              ? properties.message
              : 'unspecified session error';

        deps.log.error('event', 'session error received', {
          sessionId,
          error: errorMessage,
          eventType: event.type,
        });
        break;
      }

      case 'session.delete': {
        const properties = event.properties;
        const sessionId =
          typeof properties?.sessionID === 'string' ? properties.sessionID : undefined;
        if (sessionId) {
          deps.cleanupSession(sessionId);
          deps.log.info('event', 'session cleanup completed', { sessionId });
        }
        break;
      }
    }
  } catch (err) {
    deps.log.warn('event', 'event handler failed (non-blocking)', {
      eventType: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
