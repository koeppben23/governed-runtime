/**
 * @module integration/plugin-events
 * @description OpenCode event hook handlers for the FlowGuard plugin.
 *
 * Implements handlers for:
 * - session.error: Logs unhandled session errors to the audit trail
 * - session.delete: Cleans stale in-memory caches for terminated sessions
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
 * Intentionally defined here as a subset of the SDK Event type rather than
 * imported. FlowGuard only needs { type, properties } for audit logging.
 * Re-defining avoids a runtime dependency on @opencode-ai/sdk. If the SDK
 * Event gains new fields, this subset silently ignores them — safe for our
 * logging-only use case.
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
  /**
   * Persist a session error to the audit trail.
   *
   * Called after logging. Fail-safe: errors from this callback are caught
   * by the outer try/catch and logged via deps.log.warn — they never
   * propagate to the host runtime.
   *
   * Implementations that cannot resolve a sessionDir (e.g., before session
   * creation) should return silently.
   */
  emitSessionErrorAudit(
    sessionId: string,
    errorMessage: string,
    detail: Record<string, unknown>,
  ): Promise<void>;
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

        // Extract typed error context that would otherwise be silently lost.
        const errorCode = typeof properties?.code === 'string' ? properties.code : undefined;
        const errorStack = typeof properties?.stack === 'string' ? properties.stack : undefined;

        // Collect all non-standard properties as supplementary context.
        const KNOWN_KEYS = new Set(['sessionID', 'error', 'message', 'code', 'stack']);
        const supplementary: Record<string, unknown> = {};
        if (properties) {
          for (const [key, value] of Object.entries(properties)) {
            if (!KNOWN_KEYS.has(key)) {
              supplementary[key] = value;
            }
          }
        }
        const hasSupplementary = Object.keys(supplementary).length > 0;

        deps.log.error('event', 'session error received', {
          sessionId,
          error: errorMessage,
          eventType: event.type,
          ...(errorCode ? { errorCode } : {}),
          ...(errorStack ? { errorStack } : {}),
          ...(hasSupplementary ? { supplementary } : {}),
        });

        // Persist to audit trail (fail-safe: errors caught by outer try/catch).
        await deps.emitSessionErrorAudit(sessionId, errorMessage, {
          eventType: event.type,
          ...(errorCode ? { errorCode } : {}),
          ...(errorStack ? { errorStack } : {}),
          ...(hasSupplementary ? { supplementary } : {}),
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
