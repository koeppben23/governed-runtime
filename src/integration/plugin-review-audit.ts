/**
 * @module integration/plugin-review-audit
 * @description Review audit event helper extracted from plugin.ts.
 *
 * Wraps appendAuditEvent from the persistence adapter with standard
 * audit event fields (machine actor, timestamp, random UUID id).
 * Used exclusively by the review orchestrator block in plugin.ts.
 *
 * @version v1
 */

import * as crypto from 'node:crypto';
import { appendAuditEvent } from '../adapters/persistence.js';

/**
 * Append a review-related audit event to the session trail.
 *
 * All review audit events use `actor: 'machine'` because they are
 * generated deterministically by the plugin, not by a human operator.
 *
 * @param sessDir - Session directory path
 * @param sessionId - Session identifier
 * @param phase - Current workflow phase
 * @param event - Audit event name (e.g. 'review:obligation_created')
 * @param detail - Event detail payload
 */
export async function appendReviewAuditEvent(
  sessDir: string,
  sessionId: string,
  phase: string,
  event: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await appendAuditEvent(sessDir, {
    id: crypto.randomUUID(),
    sessionId,
    phase,
    event,
    timestamp: new Date().toISOString(),
    actor: 'machine',
    detail,
  });
}
