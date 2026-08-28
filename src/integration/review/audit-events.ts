/**
 * @module integration/review/audit-events
 * @description Review audit event emission.
 *
 * Wraps appendAuditEvent from the persistence adapter with standard
 * audit event fields (machine actor, timestamp, random UUID id).
 * Used by the plugin orchestration layer for review audit trail.
 *
 * NOTE: This module depends on adapters/persistence for audit trail I/O.
 * This is an intentional architectural decision — audit event append is
 * a core review capability, and adapters/ is the canonical persistence
 * abstraction (not a business-logic layer).
 *
 * @version v1
 */

import * as crypto from 'node:crypto';
import { appendAuditEvent } from '../../adapters/persistence-audit.js';
import { readState } from '../../adapters/persistence.js';
import type { SessionState } from '../../state/schema.js';

/**
 * Append a review-related audit event to the session trail.
 *
 * All review audit events use `actor: 'machine'` because they are
 * generated deterministically by the plugin, not by a human operator.
 * The audit identity pair is explicit: `flowguardSessionId` comes from the
 * resolved session state (the FlowGuard UUID), `hostSessionId` is bound from
 * the caller-provided host session id.
 *
 * @param sessDir - Session directory path
 * @param hostSessionId - Host (OpenCode) session identifier
 * @param phase - Current workflow phase
 * @param event - Audit event name (e.g. 'review:obligation_created')
 * @param detail - Event detail payload
 */
export async function appendReviewAuditEvent(
  sessDir: string,
  hostSessionId: string,
  phase: string,
  event: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const state = await readState(sessDir);
  if (!state) {
    throw new Error('Cannot append review audit event without session state');
  }
  await appendAuditEvent(sessDir, {
    id: crypto.randomUUID(),
    flowguardSessionId: state.flowguardSessionId,
    hostSessionId,
    phase,
    event,
    occurredAt: new Date().toISOString(),
    actor: 'machine',
    detail,
  });
}

/**
 * Append a review audit event from one already-resolved state snapshot. This
 * prevents an event envelope from disagreeing with the state used to identify
 * its FlowGuard session.
 */
export async function appendReviewAuditEventForState(
  sessDir: string,
  hostSessionId: string,
  state: Pick<SessionState, 'flowguardSessionId' | 'phase'>,
  event: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await appendAuditEvent(sessDir, {
    id: crypto.randomUUID(),
    flowguardSessionId: state.flowguardSessionId,
    hostSessionId,
    phase: state.phase,
    event,
    occurredAt: new Date().toISOString(),
    actor: 'machine',
    detail,
  });
}
