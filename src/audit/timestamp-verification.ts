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
  // Covered by the direct unit tests (odd length, invalid hex, round-trip).
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
 * Parse an audit timestamp into a numeric UTC instant (AC11). Unparseable
 * values are NEVER sortable — no lexical fallback, no best effort.
 */
function epochOf(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Verify that audit event RECORD timestamps are monotonically
 * non-decreasing, comparing PARSED UTC instants — never lexical strings
 * (offset formats such as `+02:00` vs `Z` must not yield ordering artifacts).
 * An unparseable timestamp makes the trail invalid, not ignorable.
 *
 * The chain-order authority is `recordedAt` (stamped by the append authority
 * under the audit write lock), NOT `occurredAt`: the durable audit outbox
 * reconciles older operations after newer direct appends, so an event whose
 * `occurredAt` predates its successor's is a legitimate deferred record —
 * only a RECORD order regression is a clock anomaly.
 *
 * @param events - Audit events in chronological order.
 */
export function verifyTimestampMonotonicity(
  events: readonly AuditEvent[],
): TimestampMonotonicityResult {
  for (let i = 1; i < events.length; i++) {
    const current = epochOf(events[i]!.recordedAt);
    if (current === null) {
      return {
        valid: false,
        firstBreak: i,
        message: `Record timestamp at index ${i} is not a parseable UTC instant: "${events[i]!.recordedAt}"`,
      };
    }
    const previous = epochOf(events[i - 1]!.recordedAt);
    if (previous === null) {
      return {
        valid: false,
        firstBreak: i - 1,
        message: `Record timestamp at index ${i - 1} is not a parseable UTC instant: "${events[i - 1]!.recordedAt}"`,
      };
    }
    if (current < previous) {
      return {
        valid: false,
        firstBreak: i,
        message: `Record timestamp non-monotonic at index ${i}: "${events[i]!.recordedAt}" < "${events[i - 1]!.recordedAt}"`,
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
  /**
   * When true, stronger TSA evidence payload exists but the recorded status was
   * downgraded (AC2): a degraded status must never silently weaken assurance.
   */
  readonly downgraded: boolean;
}

/** AC2: the status values that must never weaken present TSA evidence. */
function isDegradedStatus(status: string | undefined): boolean {
  // Covered exhaustively by the AC2 matrix test (all three statuses).
  return status === 'local' || status === 'ntp_checked' || status === 'tsa_failed';
}

/**
 * Verify TSA message imprint against recomputed canonical event digest.
 *
 * Only checks events that have TSA evidence. Events without TSA evidence pass
 * (backward compat — legacy events). Stored canonicalEventDigest is cross-check
 * evidence only; it is not the digest authority during verification.
 *
 * Trust model:
 * - AC2: the downgrade decision comes FIRST — a degraded status must never
 *   weaken assurance when STRONGER evidence payload exists, whether that is a
 *   token, an imprint, or both.
 * - When tokenDerBase64 is present with a coherent status: mutable
 *   timestampEvidence.tsa.messageImprint cannot be trusted. Returns
 *   needsTokenVerification=true to signal that async cryptographic token
 *   verification is required.
 * - When tokenDerBase64 is absent (mock/internal TSA): messageImprint is the
 *   trusted internal imprint and is compared against the recomputed canonical digest.
 *
 * @param event - Audit event with optional timestampEvidence.
 */
export function verifyTsaMessageImprint(event: AuditEvent): TimestampEvidenceCheck {
  const evidence = (event as Record<string, unknown>).timestampEvidence as
    Record<string, unknown> | undefined;

  if (!evidence) {
    return { valid: true, reason: null, needsTokenVerification: false, downgraded: false };
  }

  const tsa = evidence.tsa as Record<string, unknown> | undefined;
  const status = evidence.status as string | undefined;

  if (!tsa) {
    return { valid: true, reason: null, needsTokenVerification: false, downgraded: false };
  }

  const imprint = tsa.messageImprint as string | undefined;
  const tokenDerBase64 = tsa.tokenDerBase64 as string | undefined;

  // Covered by the AC2 matrix test (token / imprint / token+imprint).
  const hasStrongerEvidence = typeof tokenDerBase64 === 'string' || typeof imprint === 'string';
  if (hasStrongerEvidence && isDegradedStatus(status)) {
    return {
      valid: false,
      reason: `TSA evidence present but status downgraded to ${status} — a degraded status must never weaken timestamp assurance`,
      needsTokenVerification: false,
      downgraded: true,
    };
  }

  // Covered by the token-required and matrix tests.
  if (tokenDerBase64) {
    return {
      valid: false,
      reason: 'TSA token verification required — cannot trust mutable cached messageImprint',
      needsTokenVerification: true,
      downgraded: false,
    };
  }

  // Covered by the missing-imprint tests.
  if (!imprint) {
    return {
      valid: false,
      reason: 'TSA evidence missing messageImprint',
      needsTokenVerification: false,
      downgraded: false,
    };
  }

  const recomputedDigest = computeCanonicalEventDigest(event);

  // Covered by the stored-digest cross-check tests.
  const storedSemanticDigest = (event as Record<string, unknown>).semanticEventDigest as
    string | undefined;
  if (storedSemanticDigest && storedSemanticDigest !== recomputedDigest) {
    return {
      valid: false,
      reason: 'stored semanticEventDigest does not match recomputed canonical event digest',
      needsTokenVerification: false,
      downgraded: false,
    };
  }

  // Covered by the imprint-mismatch tests.
  if (imprint !== recomputedDigest) {
    return {
      valid: false,
      reason: 'TSA messageImprint does not match recomputed canonical event digest',
      needsTokenVerification: false,
      downgraded: false,
    };
  }

  return { valid: true, reason: null, needsTokenVerification: false, downgraded: false };
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
      Record<string, unknown> | undefined;

    const eventKind = extractEventKind(event.event);

    if (criticalKinds.includes(eventKind)) {
      // Covered by the presence tests (critical/decision/lifecycle).
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
  // Covered by the presence tests across decision/lifecycle/other kinds.
  if (eventString.startsWith('decision:')) return 'decision';
  if (eventString.startsWith('lifecycle:')) return 'lifecycle';
  if (eventString.startsWith('transition:')) return 'transition';
  if (eventString.startsWith('tool_call:')) return 'tool_call';
  if (eventString.startsWith('error:')) return 'error';
  return eventString;
}
