/**
 * @module audit/integrity
 * @description Hash chain verification for the FlowGuard audit trail.
 *
 * Every audit event includes:
 * - `prevHash`: hash of the previous event (or "genesis" for the first)
 * - `chainHash`: SHA-256(prevHash + canonical JSON of this event)
 *
 * This creates a tamper-evident chain: modifying, inserting, or deleting
 * any event breaks the chain from that point forward.
 *
 * Verification modes:
 * 1. Full chain verification — walks entire trail, reports first break
 * 2. Single event verification — checks one event against its predecessor
 * 3. Mixed trail support — events without hash fields (pre-chain) are skipped
 *    with a warning (backward-compatible with legacy trails)
 * 4. Strict mode — events without hash fields are treated as integrity failures.
 *    Regulated verification paths must use strict mode to ensure no unchained
 *    events are silently tolerated in new sessions.
 *
 * Why this matters for DATEV/banks:
 * - Regulators require proof that audit trails have not been tampered with
 * - A broken chain is evidence of unauthorized modification
 * - The genesis hash ensures no events were prepended
 * - The chain hash ensures no events were modified, inserted, or deleted
 *
 * @version v1
 */

import { timingSafeEqual } from 'node:crypto';
import { computeChainHash, GENESIS_HASH, type ChainedAuditEvent } from './types.js';
import {
  verifyTimestampMonotonicity,
  verifyTsaMessageImprint,
  verifyTimestampEvidencePresence,
} from './timestamp-verification.js';
import type { AuditEvent } from '../state/evidence.js';

/**
 * Constant-time string comparison for security-sensitive hash validation.
 * Compares buffer byte lengths first (not string lengths) to avoid
 * throwing when equal-length strings have different UTF-8 byte lengths.
 */
function safeHashEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// ─── Verification Options ─────────────────────────────────────────────────────

/**
 * Options for chain verification.
 *
 * - `strict: false` (default): legacy events without chain fields are skipped
 *   and counted in `skippedCount`. The chain remains valid. Use for migration
 *   and diagnostic workflows with mixed legacy/chained trails.
 *
 * - `strict: true`: legacy events without chain fields are treated as integrity
 *   failures. `skippedCount > 0` makes the chain invalid. Regulated verification
 *   paths must use strict mode.
 *
 * - `strictTimestamps: false` (default): timestamp evidence is not checked.
 *   Timestamp monotonicity, TSA message imprint matching, and required evidence
 *   presence are only verified when this is enabled.
 *
 * - `strictTimestamps: true`: enables timestamp monotonicity checks, TSA message
 *   imprint verification against canonicalEventDigest, and required evidence
 *   presence for critical events. Additional reasons may be reported.
 */
export interface ChainVerifyOptions {
  readonly strict?: boolean;
  readonly strictTimestamps?: boolean;
}

/**
 * Typed failure reason for chain verification.
 *
 * - `CHAIN_BREAK`: hash chain integrity failure (tampered, inserted, or deleted event).
 * - `LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE`: strict mode rejects unchained events.
 * - `TIMESTAMP_NON_MONOTONIC`: event timestamps are not strictly non-decreasing.
 * - `TIMESTAMP_EVIDENCE_MISSING`: critical event lacks required timestamp evidence.
 * - `TSA_MESSAGE_IMPRINT_MISMATCH`: TSA messageImprint does not match canonicalEventDigest.
 */
export type ChainVerificationReason =
  | 'CHAIN_BREAK'
  | 'LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE'
  | 'TIMESTAMP_NON_MONOTONIC'
  | 'TIMESTAMP_EVIDENCE_MISSING'
  | 'TSA_MESSAGE_IMPRINT_MISMATCH';

// ─── Verification Result ──────────────────────────────────────────────────────

/** Result of a single event verification. */
export interface EventVerification {
  /** Event index in the trail (0-based). */
  readonly index: number;
  /** Event ID. */
  readonly eventId: string;
  /** Whether this event passed verification. */
  readonly valid: boolean;
  /** Reason for failure (null if valid). */
  readonly reason: string | null;
}

/** Result of full chain verification. */
export interface ChainVerification {
  /** Whether the entire chain is valid. */
  readonly valid: boolean;
  /** Total events in the trail. */
  readonly totalEvents: number;
  /** Events verified (with hash fields). */
  readonly verifiedCount: number;
  /** Events skipped (without hash fields — legacy/pre-chain). */
  readonly skippedCount: number;
  /** First broken event (null if no hash chain break). */
  readonly firstBreak: EventVerification | null;
  /** All verification results (one per chained event). */
  readonly results: readonly EventVerification[];
  /**
   * Top-level failure classification. Null when chain is valid.
   *
   * - `CHAIN_BREAK`: hash mismatch detected (firstBreak has details).
   * - `LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE`: strict mode rejects
   *   unchained legacy events (skippedCount > 0).
   * - `TIMESTAMP_NON_MONOTONIC`: timestamps decrease between events.
   * - `TIMESTAMP_EVIDENCE_MISSING`: critical events lack timestamp evidence.
   * - `TSA_MESSAGE_IMPRINT_MISMATCH`: TSA stamp does not match canonical digest.
   *
   * Priority: CHAIN_BREAK > LEGACY > TIMESTAMP_*.
   */
  readonly reason: ChainVerificationReason | null;
  /** Timestamp monotonicity result (null if strictTimestamps not enabled). */
  readonly timestampMonotonicity: {
    readonly valid: boolean;
    readonly firstBreak: number | null;
    readonly message: string | null;
  } | null;
  /** Indices of critical events missing timestamp evidence. */
  readonly missingTimestampEvidence: readonly number[];
  /** Indices of events with TSA messageImprint mismatch. */
  readonly tsaImprintMismatches: readonly number[];
}

// ─── Verification Functions ──────────────────────────────────────────────────

/**
 * Verify a single chained audit event against its expected prevHash.
 *
 * @param event - The event to verify.
 * @param expectedPrevHash - The hash of the previous event (or GENESIS_HASH).
 * @returns EventVerification with valid/invalid status and reason.
 */
export function verifyEvent(
  event: ChainedAuditEvent,
  expectedPrevHash: string,
  index: number,
): EventVerification {
  // Check prevHash matches expected (constant-time comparison)
  if (!safeHashEqual(event.prevHash, expectedPrevHash)) {
    return {
      index,
      eventId: event.id,
      valid: false,
      reason: `prevHash mismatch: expected "${expectedPrevHash}", got "${event.prevHash}"`,
    };
  }

  // Recompute chainHash and compare (constant-time comparison)
  const { chainHash, ...eventWithoutHash } = event;
  const recomputed = computeChainHash(event.prevHash, eventWithoutHash);

  if (!safeHashEqual(recomputed, chainHash)) {
    return {
      index,
      eventId: event.id,
      valid: false,
      reason: `chainHash mismatch: expected "${recomputed}", got "${chainHash}" (event data may have been modified)`,
    };
  }

  return { index, eventId: event.id, valid: true, reason: null };
}

/**
 * Verify the entire audit trail chain.
 *
 * Walks from the first event to the last, verifying:
 * 1. First event has prevHash === GENESIS_HASH
 * 2. Each subsequent event has prevHash === previous event's chainHash
 * 3. Each event's chainHash matches recomputation
 *
 * Events without chainHash/prevHash fields are skipped (legacy support).
 * The chain continues from the last known hash after skipped events.
 *
 * In strict mode (`options.strict = true`), skipped events make the chain
 * invalid. Regulated verification paths must use strict mode.
 *
 * @param events - The audit trail events in chronological order.
 * @param options - Verification options (strict mode, etc.).
 * @returns ChainVerification with full results.
 */
export function verifyChain(
  events: Array<Record<string, unknown>>,
  options?: ChainVerifyOptions,
): ChainVerification {
  const strict = options?.strict === true;
  const strictTimestamps = options?.strictTimestamps === true;
  const results: EventVerification[] = [];
  let skippedCount = 0;
  let lastHash = GENESIS_HASH;
  let firstBreak: EventVerification | null = null;

  for (let i = 0; i < events.length; i++) {
    const raw = events[i]!;

    // Check if this event has chain fields
    if (!isChainedEvent(raw)) {
      skippedCount++;
      continue;
    }

    const event = raw as unknown as ChainedAuditEvent;
    const verification = verifyEvent(event, lastHash, i);
    results.push(verification);

    if (!verification.valid && !firstBreak) {
      firstBreak = verification;
    }

    // Advance chain hash (even if verification failed — to detect cascading breaks)
    lastHash = event.chainHash;
  }

  // Timestamp verification (if enabled)
  let timestampMonotonicity: ChainVerification['timestampMonotonicity'] = null;
    let missingTimestampEvidence: number[] = [];
    const tsaImprintMismatches: number[] = [];

  if (strictTimestamps) {
    const chainedEvents = events
      .filter(isChainedEvent)
      .map((e) => e as unknown as AuditEvent);

    const monotonicityResult = verifyTimestampMonotonicity(chainedEvents);
    timestampMonotonicity = {
      valid: monotonicityResult.valid,
      firstBreak: monotonicityResult.firstBreak,
      message: monotonicityResult.message,
    };

    const presenceCheck = verifyTimestampEvidencePresence(chainedEvents, [
      'decision',
      'lifecycle',
    ]);
    missingTimestampEvidence = presenceCheck.missingCriticalEvents;

    for (let i = 0; i < chainedEvents.length; i++) {
      const check = verifyTsaMessageImprint(chainedEvents[i]!);
      if (!check.valid) {
        tsaImprintMismatches.push(i);
      }
    }
  }

  // Determine validity and reason.
  // Priority: CHAIN_BREAK > LEGACY > TIMESTAMP_NON_MONOTONIC > IMPRINT_MISMATCH > EVIDENCE_MISSING.
  let valid: boolean;
  let reason: ChainVerificationReason | null;

  if (firstBreak !== null) {
    valid = false;
    reason = 'CHAIN_BREAK';
  } else if (strict && skippedCount > 0) {
    valid = false;
    reason = 'LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE';
  } else if (strictTimestamps && timestampMonotonicity && !timestampMonotonicity.valid) {
    valid = false;
    reason = 'TIMESTAMP_NON_MONOTONIC';
  } else if (strictTimestamps && tsaImprintMismatches.length > 0) {
    valid = false;
    reason = 'TSA_MESSAGE_IMPRINT_MISMATCH';
  } else if (strictTimestamps && missingTimestampEvidence.length > 0) {
    valid = false;
    reason = 'TIMESTAMP_EVIDENCE_MISSING';
  } else {
    valid = true;
    reason = null;
  }

  return {
    valid,
    totalEvents: events.length,
    verifiedCount: results.length,
    skippedCount,
    firstBreak,
    results,
    reason,
    timestampMonotonicity,
    missingTimestampEvidence,
    tsaImprintMismatches,
  };
}

/**
 * Get the last chain hash from a trail.
 * Used by the audit writer to determine prevHash for the next event.
 *
 * @param events - The audit trail events in chronological order.
 * @returns The chainHash of the last chained event, or GENESIS_HASH if none.
 */
export function getLastChainHash(events: Array<Record<string, unknown>>): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const raw = events[i]!;
    if (isChainedEvent(raw)) {
      return (raw as unknown as ChainedAuditEvent).chainHash;
    }
  }
  return GENESIS_HASH;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

/**
 * Type guard: does this event have chain hash fields?
 * Used to distinguish chained events from legacy events in mixed trails.
 */
function isChainedEvent(event: Record<string, unknown>): boolean {
  return (
    typeof event.chainHash === 'string' &&
    typeof event.prevHash === 'string' &&
    event.chainHash.length > 0 &&
    event.prevHash.length > 0
  );
}
