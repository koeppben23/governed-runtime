/**
 * @module audit/timestamp-verification
 * @description Timestamp evidence verification functions.
 *
 * Provides:
 * - verifyTimestampMonotonicity: checks event timestamps are non-decreasing
 * - verifyTimestampEvidence: checks TSA message imprint against canonical digest
 * - verifyTimestampEvidencePresence: checks critical events have required evidence
 *
 * Used by verifyChain() when strictTimestamps is enabled.
 *
 * @version v1
 */

import type { AuditEvent } from '../state/evidence.js';

/**
 * Convert a hex string to Uint8Array.
 * Fail-closed: throws on non-hex input or odd-length strings.
 */
export function canonicalDigestToUint8Array(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`canonicalDigestToUint8Array: odd hex length ${hex.length}`);
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`canonicalDigestToUint8Array: invalid hex input`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export interface TimestampMonotonicityResult {
  readonly valid: boolean;
  readonly firstBreak: number | null;
  readonly message: string | null;
}

/**
 * Verify that audit event timestamps are monotonically non-decreasing.
 *
 * @param events - Audit events in chronological order.
 */
export function verifyTimestampMonotonicity(
  events: readonly AuditEvent[],
): TimestampMonotonicityResult {
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.timestamp < events[i - 1]!.timestamp) {
      return {
        valid: false,
        firstBreak: i,
        message: `Timestamp non-monotonic at index ${i}: "${events[i]!.timestamp}" < "${events[i - 1]!.timestamp}"`,
      };
    }
  }
  return { valid: true, firstBreak: null, message: null };
}

export interface TimestampEvidenceCheck {
  readonly valid: boolean;
  readonly reason: string | null;
}

/**
 * Verify TSA message imprint matches the canonical event digest.
 *
 * Only checks events that have both canonicalEventDigest and tsa evidence.
 * Events without TSA evidence pass (backward compat — legacy events).
 *
 * @param event - Audit event with optional timestampEvidence.
 */
export function verifyTsaMessageImprint(event: AuditEvent): TimestampEvidenceCheck {
  const evidence = (event as Record<string, unknown>).timestampEvidence as
    | Record<string, unknown>
    | undefined;
  const canonicalDigest = (event as Record<string, unknown>).canonicalEventDigest as
    | string
    | undefined;

  if (!evidence || !canonicalDigest) {
    return { valid: true, reason: null };
  }

  const tsa = evidence.tsa as Record<string, unknown> | undefined;
  const status = evidence.status as string | undefined;

  if (!tsa || status === 'local' || status === 'ntp_checked') {
    return { valid: true, reason: null };
  }

  if (status === 'tsa_failed') {
    return { valid: true, reason: null };
  }

  const imprint = tsa.messageImprint as string | undefined;
  if (!imprint) {
    return { valid: false, reason: 'TSA evidence missing messageImprint' };
  }

  if (imprint !== canonicalDigest) {
    return {
      valid: false,
      reason: `TSA messageImprint "${imprint}" does not match canonicalEventDigest "${canonicalDigest}"`,
    };
  }

  return { valid: true, reason: null };
}

export interface EvidencePresenceCheck {
  readonly valid: boolean;
  readonly missingCriticalEvents: number[];
}

/**
 * Verify critical events have timestamp evidence present.
 * In non-strict mode, this is advisory (events are still valid).
 *
 * @param events - Audit events in chronological order.
 * @param criticalKinds - Event kinds that require evidence (e.g., ['decision', 'lifecycle']).
 */
export function verifyTimestampEvidencePresence(
  events: readonly AuditEvent[],
  criticalKinds: readonly string[],
): EvidencePresenceCheck {
  const missingCriticalEvents: number[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const evidence = (event as Record<string, unknown>).timestampEvidence as
      | Record<string, unknown>
      | undefined;

    const eventKind = extractEventKind(event.event);

    if (criticalKinds.includes(eventKind) && (!evidence || evidence.status === 'local')) {
      missingCriticalEvents.push(i);
    }
  }

  return {
    valid: missingCriticalEvents.length === 0,
    missingCriticalEvents,
  };
}

function extractEventKind(eventString: string): string {
  if (eventString.startsWith('decision:')) return 'decision';
  if (eventString.startsWith('lifecycle:')) return 'lifecycle';
  if (eventString.startsWith('transition:')) return 'transition';
  if (eventString.startsWith('tool_call:')) return 'tool_call';
  if (eventString.startsWith('error:')) return 'error';
  return eventString;
}
