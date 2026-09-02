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
 * 3. Assurance epoch: every record must be an audit-chain.v3 record.
 *    Legacy records are never skipped, migrated, or interpreted — they fail
 *    closed with LEGACY_ASSURANCE_FORMAT_UNSUPPORTED.
 * 4. Timestamp verification — monotonicity (CLOCK_ANOMALY) is always checked;
 *    optional strictTimestamps adds TSA imprint binding and evidence presence.
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
import {
  computeChainHash,
  CURRENT_AUDIT_FORMAT_VERSION,
  GENESIS_HASH,
  type ChainedAuditEvent,
} from './types.js';
import { computeCanonicalEventDigest } from './canonical-digest.js';
import {
  verifyTimestampMonotonicity,
  verifyTsaMessageImprint,
  verifyTimestampEvidencePresence,
} from './timestamp-verification.js';
import { AuditEvent } from '../state/evidence.js';

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
 * There is deliberately no `strict` flag. Legacy tolerance was removed for the
 * Assurance epoch — every non-v3 record is an integrity failure in every mode —
 * so a `strict` option could only ever be a no-op that reads like a hardening
 * switch. It was one, and two production call sites passed `{ strict: true }`
 * believing they had enabled something.
 *
 * - `strictTimestamps: false` (default): TSA timestamp evidence is not checked.
 *   Clock monotonicity is still verified — it needs no evidence and no policy,
 *   so CLOCK_ANOMALY is reportable in every mode.
 *
 * - `strictTimestamps: true`: additionally enables TSA message
 *   imprint verification against recomputed canonical event content digest, and required evidence
 *   presence for critical events. Additional reasons may be reported.
 */
export interface ChainVerifyOptions {
  readonly strictTimestamps?: boolean;
  /** Expected state-owned FlowGuard session identity, when available. */
  readonly expectedFlowguardSessionId?: string;
}

/**
 * Typed failure reason for chain verification.
 *
 * - `CHAIN_BREAK`: hash chain integrity failure (tampered, inserted, or deleted event).
 * - `LEGACY_ASSURANCE_FORMAT_UNSUPPORTED`: record is not an audit-chain.v3
 *   record (missing/legacy format, or no chain fields). Legacy artifacts are
 *   never interpreted — they fail closed.
 * - `CLOCK_ANOMALY`: event timestamps are not strictly non-decreasing.
 * - `TIMESTAMP_EVIDENCE_MISSING`: critical event lacks required timestamp evidence.
 * - `TSA_MESSAGE_IMPRINT_MISMATCH`: TSA messageImprint does not match recomputed canonical content digest.
 *   Returned when no tokenDerBase64 exists (internal-imprint model) and the cached imprint
 *   fails comparison.
 * - `TOKEN_VERIFICATION_REQUIRED`: event has tokenDerBase64 and is TSA-stamped but token has not
 *   been cryptographically verified. Strict timestamp verification cannot trust mutable
 *   timestampEvidence.tsa.messageImprint. Deferred to async token verification.
 * - `TSA_EVIDENCE_DOWNGRADED`: stronger TSA evidence payload is present but the recorded
 *   status was downgraded (local/ntp_checked/tsa_failed) — a degraded status must never
 *   silently weaken timestamp assurance.
 */
export type ChainVerificationReason =
  | 'CHAIN_BREAK'
  | 'LEGACY_ASSURANCE_FORMAT_UNSUPPORTED'
  | 'CLOCK_ANOMALY'
  | 'TIMESTAMP_EVIDENCE_MISSING'
  | 'TSA_MESSAGE_IMPRINT_MISMATCH'
  | 'TOKEN_VERIFICATION_REQUIRED'
  | 'TSA_EVIDENCE_DOWNGRADED';

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
  /** Machine-readable failure classification. */
  readonly reasonCode: ChainVerificationReason | null;
  /** Recomputed hash when a v2 chainHash mismatch is detected. */
  readonly expectedChainHash?: string;
  /** Stored hash when a v2 chainHash mismatch is detected. */
  readonly actualChainHash?: string;
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
   * - `LEGACY_ASSURANCE_FORMAT_UNSUPPORTED`: a record is not a chained
   *   audit-chain.v3 record. Legacy artifacts fail closed everywhere.
   * - `CLOCK_ANOMALY`: timestamps decrease between events.
   * - `TIMESTAMP_EVIDENCE_MISSING`: critical events lack timestamp evidence.
   * - `TSA_MESSAGE_IMPRINT_MISMATCH`: TSA stamp does not match canonical digest.
   * - `TOKEN_VERIFICATION_REQUIRED`: TSA-stamped event has tokenDerBase64 that must be
   *   cryptographically verified before imprint can be trusted.
   *
   * Priority: CHAIN_BREAK > legacy format > timestamp_*.
   */
  readonly reason: ChainVerificationReason | null;
  /** Timestamp monotonicity result. Always present — never gated by options. */
  readonly timestampMonotonicity: {
    readonly valid: boolean;
    readonly firstBreak: number | null;
    readonly message: string | null;
  } | null;
  /** Indices of critical events missing timestamp evidence. */
  readonly missingTimestampEvidence: readonly number[];
  /** Indices of events with TSA messageImprint mismatch. */
  readonly tsaImprintMismatches: readonly number[];
  /** Indices of TSA-stamped events with tokenDerBase64 that require token verification. */
  readonly tokenVerificationRequired: readonly number[];
  /** Indices of events whose stronger TSA evidence was downgraded in status (AC2). */
  readonly tsaEvidenceDowngraded: readonly number[];
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
  const formatVersion = (event as unknown as Record<string, unknown>).auditFormatVersion;
  if (formatVersion !== CURRENT_AUDIT_FORMAT_VERSION) {
    return {
      index,
      eventId: event.id,
      valid: false,
      reason: `legacy or unsupported audit chain format: ${String(formatVersion)}`,
      reasonCode: 'LEGACY_ASSURANCE_FORMAT_UNSUPPORTED',
    };
  }

  // Check prevHash matches expected (constant-time comparison)
  if (!safeHashEqual(event.prevHash, expectedPrevHash)) {
    return {
      index,
      eventId: event.id,
      valid: false,
      reason: `prevHash mismatch: expected "${expectedPrevHash}", got "${event.prevHash}"`,
      reasonCode: 'CHAIN_BREAK',
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
      reasonCode: 'CHAIN_BREAK',
      expectedChainHash: recomputed,
      actualChainHash: chainHash,
    };
  }

  // Sequence authority: the append lock stamps auditSequence as the 1-based
  // chain position. Any other value means the record was re-stamped outside
  // the append authority — e.g. a trail carrying 1, 7, 7.
  if (!Number.isInteger(event.auditSequence) || event.auditSequence !== index + 1) {
    return {
      index,
      eventId: event.id,
      valid: false,
      reason: `auditSequence mismatch: expected ${index + 1}, got ${String(event.auditSequence)}`,
      reasonCode: 'CHAIN_BREAK',
    };
  }

  // Semantic digest authority: semanticEventDigest must equal the recomputed
  // canonical content digest of the record. A re-sealed trail whose stamped
  // digest was not recomputed over the actual content is invalid even when
  // every chainHash is internally consistent.
  const recomputedSemanticDigest = computeCanonicalEventDigest(
    event as unknown as Record<string, unknown>,
  );
  if (!safeHashEqual(recomputedSemanticDigest, event.semanticEventDigest)) {
    return {
      index,
      eventId: event.id,
      valid: false,
      reason:
        `semanticEventDigest mismatch: expected "${recomputedSemanticDigest}", ` +
        `got "${event.semanticEventDigest}"`,
      reasonCode: 'CHAIN_BREAK',
      expectedChainHash: recomputedSemanticDigest,
      actualChainHash: event.semanticEventDigest,
    };
  }

  return { index, eventId: event.id, valid: true, reason: null, reasonCode: null };
}

/**
 * Verify the entire audit trail chain.
 *
 * Walks from the first event to the last, verifying:
 * 1. First event has prevHash === GENESIS_HASH
 * 2. Each subsequent event has prevHash === previous event's chainHash
 * 3. Each event's chainHash matches recomputation
 *
 * Every record must be an audit-chain.v3 record. Records without chain
 * fields or with a legacy format fail closed with
 * LEGACY_ASSURANCE_FORMAT_UNSUPPORTED — no skipping, no migration.
 *
 * @param events - The audit trail events in chronological order.
 * @param options - Verification options (strictTimestamps).
 * @returns ChainVerification with full results.
 */
export function verifyChain(
  events: Record<string, unknown>[],
  options?: ChainVerifyOptions,
): ChainVerification {
  const strictTimestamps = options?.strictTimestamps === true;
  const results: EventVerification[] = [];
  const failures: FirstVerificationFailures = {};
  let lastHash = GENESIS_HASH;
  let trailFlowguardSessionId = options?.expectedFlowguardSessionId;

  for (let i = 0; i < events.length; i++) {
    const raw = events[i]!;

    const parsed = AuditEvent.safeParse(raw);
    if (!parsed.success) {
      const verification: EventVerification = {
        index: i,
        eventId: typeof raw.id === 'string' ? raw.id : 'unknown',
        valid: false,
        reason: 'record is not a valid audit-chain.v3 event envelope',
        reasonCode: 'LEGACY_ASSURANCE_FORMAT_UNSUPPORTED',
      };
      results.push(verification);
      trackVerificationFailure(failures, verification);
      continue;
    }

    const event = parsed.data as ChainedAuditEvent;
    const eventVerification = verifyEvent(event, lastHash, i);
    if (!trailFlowguardSessionId) trailFlowguardSessionId = event.flowguardSessionId;
    const verification =
      event.flowguardSessionId === trailFlowguardSessionId
        ? eventVerification
        : {
            index: i,
            eventId: event.id,
            valid: false,
            reason: `flowguardSessionId mismatch: expected "${trailFlowguardSessionId}", got "${event.flowguardSessionId}"`,
            reasonCode: 'CHAIN_BREAK' as const,
          };
    results.push(verification);
    trackVerificationFailure(failures, verification);

    // Advance chain hash (even if verification failed — to detect cascading breaks)
    lastHash = event.chainHash;
  }

  const timestampChecks = verifyTimestampChecks(events, strictTimestamps);
  const reason = resolveChainReason(failures, strictTimestamps, timestampChecks);

  return {
    valid: reason === null,
    totalEvents: events.length,
    verifiedCount: results.length,
    skippedCount: 0,
    firstBreak: failures.firstBreak ?? null,
    results,
    reason,
    timestampMonotonicity: timestampChecks.timestampMonotonicity,
    missingTimestampEvidence: timestampChecks.missingTimestampEvidence,
    tsaImprintMismatches: timestampChecks.tsaImprintMismatches,
    tokenVerificationRequired: timestampChecks.tokenVerificationRequired,
    tsaEvidenceDowngraded: timestampChecks.tsaEvidenceDowngraded,
  };
}

interface FirstVerificationFailures {
  firstBreak?: EventVerification;
  firstChainBreak?: EventVerification;
  firstLegacyFormat?: EventVerification;
}

interface TimestampChecks {
  readonly timestampMonotonicity: ChainVerification['timestampMonotonicity'];
  readonly missingTimestampEvidence: readonly number[];
  readonly tsaImprintMismatches: readonly number[];
  readonly tokenVerificationRequired: readonly number[];
  readonly tsaEvidenceDowngraded: readonly number[];
}

function trackVerificationFailure(
  failures: FirstVerificationFailures,
  verification: EventVerification,
): void {
  if (verification.valid) return;

  failures.firstBreak ??= verification;
  if (verification.reasonCode === 'CHAIN_BREAK') failures.firstChainBreak ??= verification;
  if (verification.reasonCode === 'LEGACY_ASSURANCE_FORMAT_UNSUPPORTED') {
    failures.firstLegacyFormat ??= verification;
  }
}

function verifyTimestampChecks(
  events: Record<string, unknown>[],
  strictTimestamps: boolean,
): TimestampChecks {
  const chainedEvents = events.filter(isChainedEvent).map((e) => e as unknown as AuditEvent);
  // Clock monotonicity is a property of the trail itself: it needs no TSA
  // evidence, no timestamp policy and no configuration, so it is ALWAYS
  // verified. Gating it behind `strictTimestamps` bundled it with the TSA
  // evidence-presence requirement and left callers only two bad options —
  // never detect a clock anomaly, or demand TSA evidence from sessions that
  // never enabled timestamp assurance and fail them all.
  const monotonicityResult = verifyTimestampMonotonicity(chainedEvents);
  const timestampMonotonicity = {
    valid: monotonicityResult.valid,
    firstBreak: monotonicityResult.firstBreak,
    message: monotonicityResult.message,
  };

  if (!strictTimestamps) {
    return {
      timestampMonotonicity,
      missingTimestampEvidence: [],
      tsaImprintMismatches: [],
      tokenVerificationRequired: [],
      tsaEvidenceDowngraded: [],
    };
  }

  const missingTimestampEvidence = verifyTimestampEvidencePresence(chainedEvents, [
    'decision',
    'lifecycle',
  ]).missingCriticalEvents;

  const tsaImprintMismatches: number[] = [];
  const tokenVerificationRequired: number[] = [];
  const tsaEvidenceDowngraded: number[] = [];

  for (let i = 0; i < chainedEvents.length; i++) {
    const check = verifyTsaMessageImprint(chainedEvents[i]!);
    if (check.valid) continue;
    if (check.downgraded) {
      tsaEvidenceDowngraded.push(i);
    } else if (check.needsTokenVerification) {
      tokenVerificationRequired.push(i);
    } else {
      tsaImprintMismatches.push(i);
    }
  }

  return {
    timestampMonotonicity,
    missingTimestampEvidence,
    tsaImprintMismatches,
    tokenVerificationRequired,
    tsaEvidenceDowngraded,
  };
}

function resolveChainReason(
  failures: FirstVerificationFailures,
  strictTimestamps: boolean,
  timestampChecks: TimestampChecks,
): ChainVerificationReason | null {
  const structuralReason = resolveStructuralChainReason(failures);
  if (structuralReason) return structuralReason;
  // Always authoritative: a non-monotonic trail is an integrity failure
  // regardless of whether TSA timestamp assurance was ever enabled.
  if (timestampChecks.timestampMonotonicity?.valid === false) return 'CLOCK_ANOMALY';
  if (!strictTimestamps) return null;

  return resolveTimestampReason(timestampChecks);
}

function resolveStructuralChainReason(
  failures: FirstVerificationFailures,
): ChainVerificationReason | null {
  if (failures.firstChainBreak) return 'CHAIN_BREAK';
  if (failures.firstLegacyFormat) return 'LEGACY_ASSURANCE_FORMAT_UNSUPPORTED';
  return null;
}

function resolveTimestampReason(timestampChecks: TimestampChecks): ChainVerificationReason | null {
  if (timestampChecks.timestampMonotonicity?.valid === false) {
    return 'CLOCK_ANOMALY';
  }
  if (timestampChecks.tokenVerificationRequired.length > 0) {
    return 'TOKEN_VERIFICATION_REQUIRED';
  }
  if (timestampChecks.tsaEvidenceDowngraded.length > 0) {
    return 'TSA_EVIDENCE_DOWNGRADED';
  }
  if (timestampChecks.tsaImprintMismatches.length > 0) {
    return 'TSA_MESSAGE_IMPRINT_MISMATCH';
  }
  if (timestampChecks.missingTimestampEvidence.length > 0) {
    return 'TIMESTAMP_EVIDENCE_MISSING';
  }
  return null;
}

/**
 * Get the last chain hash from a trail.
 * Used by the audit writer to determine prevHash for the next event.
 *
 * @param events - The audit trail events in chronological order.
 * @returns The chainHash of the last chained event, or GENESIS_HASH if none.
 */
export function getLastChainHash(events: Record<string, unknown>[]): string {
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
 * Every audit-chain.v3 record is chained; non-chained input is legacy.
 */
function isChainedEvent(event: Record<string, unknown>): boolean {
  return (
    typeof event.chainHash === 'string' &&
    typeof event.prevHash === 'string' &&
    event.chainHash.length > 0 &&
    event.prevHash.length > 0
  );
}
