/**
 * @module audit/timestamp-verification
 * @description Timestamp evidence verification functions.
 *
 * Provides:
 * - verifyTimestampMonotonicity: checks event timestamps are non-decreasing
 * - verifyTimestampEvidence: checks cached trusted TSA imprint against recomputed canonical content digest
 * - verifyTimestampEvidencePresence: checks critical events have required evidence
 *
 * Used by verifyChain() when strictTimestamps is enabled.
 *
 * @version v1
 */

import type { AuditEvent } from '../state/evidence.js';
import { computeCanonicalEventDigest } from './canonical-digest.js';
import { TsaError } from './errors.js';

/**
 * Convert a hex string to Uint8Array.
 * Fail-closed: throws on non-hex input or odd-length strings.
 */
export function canonicalDigestToUint8Array(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new TsaError(
      'TSA_HEX_ODD_LENGTH',
      `canonicalDigestToUint8Array: odd hex length ${hex.length}`,
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new TsaError('TSA_HEX_INVALID', `canonicalDigestToUint8Array: invalid hex input`);
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
  /** When true, the event has tokenDerBase64 and must be cryptographically verified before the imprint can be trusted. */
  readonly needsTokenVerification: boolean;
}

/**
 * Verify TSA message imprint against recomputed canonical event digest.
 *
 * Only checks events that have TSA evidence. Events without TSA evidence pass
 * (backward compat — legacy events). Stored canonicalEventDigest is cross-check
 * evidence only; it is not the digest authority during verification.
 *
 * Trust model:
 * - When tokenDerBase64 is present: mutable timestampEvidence.tsa.messageImprint
 *   cannot be trusted. Returns needsTokenVerification=true to signal that async
 *   cryptographic token verification is required.
 * - When tokenDerBase64 is absent (mock/internal TSA): messageImprint is the
 *   trusted internal imprint and is compared against the recomputed canonical digest.
 *
 * @param event - Audit event with optional timestampEvidence.
 */
export function verifyTsaMessageImprint(event: AuditEvent): TimestampEvidenceCheck {
  const evidence = (event as Record<string, unknown>).timestampEvidence as
    | Record<string, unknown>
    | undefined;
  const storedCanonicalDigest = (event as Record<string, unknown>).canonicalEventDigest as
    | string
    | undefined;

  if (!evidence) {
    return { valid: true, reason: null, needsTokenVerification: false };
  }

  const tsa = evidence.tsa as Record<string, unknown> | undefined;
  const status = evidence.status as string | undefined;

  if (!tsa || status === 'local' || status === 'ntp_checked') {
    return { valid: true, reason: null, needsTokenVerification: false };
  }

  if (status === 'tsa_failed') {
    return { valid: true, reason: null, needsTokenVerification: false };
  }

  const imprint = tsa.messageImprint as string | undefined;
  const tokenDerBase64 = tsa.tokenDerBase64 as string | undefined;

  if (tokenDerBase64) {
    return {
      valid: false,
      reason: 'TSA token verification required — cannot trust mutable cached messageImprint',
      needsTokenVerification: true,
    };
  }

  if (!imprint) {
    return {
      valid: false,
      reason: 'TSA evidence missing messageImprint',
      needsTokenVerification: false,
    };
  }

  const recomputedDigest = computeCanonicalEventDigest(event);

  if (storedCanonicalDigest && storedCanonicalDigest !== recomputedDigest) {
    return {
      valid: false,
      reason: 'stored canonicalEventDigest does not match recomputed canonical event digest',
      needsTokenVerification: false,
    };
  }

  if (imprint !== recomputedDigest) {
    return {
      valid: false,
      reason: 'TSA messageImprint does not match recomputed canonical event digest',
      needsTokenVerification: false,
    };
  }

  return { valid: true, reason: null, needsTokenVerification: false };
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

    if (criticalKinds.includes(eventKind)) {
      const isMissing =
        !evidence || evidence.status === 'local' || evidence.status === 'tsa_failed';
      if (isMissing) {
        missingCriticalEvents.push(i);
      }
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
