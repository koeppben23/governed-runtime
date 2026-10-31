/**
 * @module integration/plugin-events
 * @description OpenCode event hook handlers for the FlowGuard plugin.
 *
 * Implements handlers for:
 * - session.execution.failed: Logs unhandled session errors to the audit trail
 * - session.deleted: Cleans stale in-memory caches for terminated sessions
 * - session.idle: resumes interrupted
 *   canonical system work. `system_work` phases have no commands, so the
 *   runtime — not a later user command — owns the continuation.
 *
 * All handlers are fail-safe: errors are logged but never thrown.
 * This prevents event-hook failures from breaking the host runtime.
 *
 * @see https://opencode.ai/v2/docs/build/plugins/server
 * @version v2
 */

import { serializeError } from '../logging/error-serialize.js';
import { redactExtra, sanitizeDiagnosticString } from '../logging/redact.js';
import type { OpenCodeEvent } from '@opencode/client';

/**
 * Native V2 notification projection. Mutation wakeups additionally require a
 * fresh history read before any state write; notifications are not evidence.
 */
export interface PluginEvent {
  readonly type: string;
  readonly data?: Record<string, unknown>;
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
  /**
   * Resume interrupted canonical system work for an idle/active session.
   * The runtime lifecycle owns this trigger; no user command is required.
   * Fail-safe: the handler catches and logs; the implementation must never
   * throw for an unavailable/resolved-elsewhere session.
   */
  resumePendingSystemWork(sessionId: string): Promise<void>;
  observeMutationEvent(event: PluginEvent): Promise<void>;
}

/**
 * Session-relevant event types that FlowGuard handles.
 *
 * OpenCode emits many event types; we only act on a targeted subset
 * to minimize coupling and runtime overhead.
 */
const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'session.execution.failed',
  'session.deleted',
  'session.idle',
  'session.tool.failed',
] satisfies readonly OpenCodeEvent['type'][]);

/**
 * Copy host-supplied properties that are not already modelled explicitly.
 *
 * Values are host-controlled and arbitrarily shaped — `detail` is
 * `z.record(z.string(), z.unknown())`, so nested objects and arrays reach the
 * raw audit trail intact. Redaction is delegated to `redactExtra()`, the
 * existing deep-walking SSOT, which sanitizes every nested string while
 * preserving structure and is cycle-, depth-, and throw-safe.
 */
function collectSupplementaryContext(
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const KNOWN_KEYS = new Set(['sessionID', 'error']);
  const supplementary: Record<string, unknown> = {};
  if (!properties) return supplementary;
  for (const [key, value] of Object.entries(properties)) {
    if (KNOWN_KEYS.has(key)) continue;
    supplementary[key] = value;
  }
  return redactExtra(supplementary) ?? {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strOr(v: unknown, fallback: string): string {
  const s = str(v);
  return s || fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Native SessionStructuredError has type/message, not a V1 name/data envelope.
 */
function extractErrorMessage(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.message === 'string' && error.message.length > 0 ? error.message : undefined;
}

async function handleSessionError(deps: EventHandlerDeps, event: PluginEvent): Promise<void> {
  const details = buildSessionErrorDetails(event);
  deps.log.error('event', 'session error received', details.logDetail);
  await deps.emitSessionErrorAudit(details.sessionId, details.errorMessage, details.auditDetail);
}

function buildSessionErrorDetails(event: PluginEvent): {
  sessionId: string;
  errorMessage: string;
  logDetail: Record<string, unknown>;
  auditDetail: Record<string, unknown>;
} {
  const properties = event.data;
  const sessionId = strOr(properties?.sessionID, 'unknown');
  // Host-supplied error text is unstructured and reaches the raw audit trail
  // via error:SESSION_ERROR. The logger redacts centrally before its sinks;
  // the audit append does not, so redact at the source for both consumers.
  const errorMessage = sanitizeDiagnosticString(
    extractErrorMessage(properties?.error) ?? 'unspecified session error',
  );
  const optionalDetails = buildOptionalErrorDetails(properties);
  return {
    sessionId,
    errorMessage,
    logDetail: { sessionId, error: errorMessage, eventType: event.type, ...optionalDetails },
    auditDetail: { eventType: event.type, ...optionalDetails },
  };
}

function buildOptionalErrorDetails(
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  const errorType = str(isRecord(properties?.error) ? properties.error.type : undefined);
  const supplementary = collectSupplementaryContext(properties);
  if (errorType) detail.errorType = sanitizeDiagnosticString(errorType);
  if (Object.keys(supplementary).length > 0) detail.supplementary = supplementary;
  return detail;
}

async function handleSessionDelete(deps: EventHandlerDeps, event: PluginEvent): Promise<void> {
  const sessionId = extractEventSessionId(event.data);
  if (sessionId) {
    deps.cleanupSession(sessionId);
    deps.log.info('event', 'session cleanup completed', { sessionId });
  }
}

/**
 * Resolve the event session id (`data.sessionID`). Missing or non-string
 * ids are ignored fail-safe.
 */
function extractEventSessionId(
  properties: Record<string, unknown> | undefined,
): string | undefined {
  const id = properties?.sessionID;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

async function handleSessionIdle(deps: EventHandlerDeps, event: PluginEvent): Promise<void> {
  const sessionId = extractEventSessionId(event.data);
  if (!sessionId) return;
  await deps.resumePendingSystemWork(sessionId);
}

/**
 * Handle an OpenCode event.
 *
 * Fail-safe: never throws. All errors are caught and logged.
 */
export async function handleEvent(deps: EventHandlerDeps, event: PluginEvent): Promise<void> {
  if (!event || !event.type) return;
  if (!HANDLED_EVENT_TYPES.has(event.type)) return;
  try {
    if (event.type === 'session.tool.failed') await deps.observeMutationEvent(event);
    else if (event.type === 'session.execution.failed') await handleSessionError(deps, event);
    else if (event.type === 'session.deleted') await handleSessionDelete(deps, event);
    else if (event.type === 'session.idle') await handleSessionIdle(deps, event);
  } catch (err) {
    deps.log.warn('event', 'event handler failed (non-blocking)', {
      eventType: event.type,
      error: serializeError(err),
    });
  }
}
