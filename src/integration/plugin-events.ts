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
function collectSupplementaryContext(
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const KNOWN_KEYS = new Set(['sessionID', 'error', 'message', 'code', 'stack']);
  const supplementary: Record<string, unknown> = {};
  if (!properties) return supplementary;
  for (const [key, value] of Object.entries(properties)) {
    if (!KNOWN_KEYS.has(key)) supplementary[key] = value;
  }
  return supplementary;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strOr(v: unknown, fallback: string): string {
  const s = str(v);
  return s || fallback;
}

async function handleSessionError(deps: EventHandlerDeps, event: PluginEvent): Promise<void> {
  const p = event.properties;
  const sessionId = strOr(p?.sessionID, 'unknown');
  const errorMessage = strOr(p?.error, strOr(p?.message, 'unspecified session error'));
  const errorCode = str(p?.code) || undefined;
  const errorStack = str(p?.stack) || undefined;
  const supplementary = collectSupplementaryContext(p);
  deps.log.error('event', 'session error received', {
    sessionId,
    error: errorMessage,
    eventType: event.type,
    ...(errorCode ? { errorCode } : {}),
    ...(errorStack ? { errorStack } : {}),
    ...(Object.keys(supplementary).length > 0 ? { supplementary } : {}),
  });
  await deps.emitSessionErrorAudit(sessionId, errorMessage, {
    eventType: event.type,
    ...(errorCode ? { errorCode } : {}),
    ...(errorStack ? { errorStack } : {}),
    ...(Object.keys(supplementary).length > 0 ? { supplementary } : {}),
  });
}

async function handleSessionDelete(deps: EventHandlerDeps, event: PluginEvent): Promise<void> {
  const sessionId =
    typeof event.properties?.sessionID === 'string' ? event.properties.sessionID : undefined;
  if (sessionId) {
    deps.cleanupSession(sessionId);
    deps.log.info('event', 'session cleanup completed', { sessionId });
  }
}

export async function handleEvent(deps: EventHandlerDeps, event: PluginEvent): Promise<void> {
  if (!event || !event.type) return;
  if (!HANDLED_EVENT_TYPES.has(event.type)) return;
  try {
    if (event.type === 'session.error') await handleSessionError(deps, event);
    else if (event.type === 'session.delete') await handleSessionDelete(deps, event);
  } catch (err) {
    deps.log.warn('event', 'event handler failed (non-blocking)', {
      eventType: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
