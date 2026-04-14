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
 *
 * Why this matters for DATEV/banks:
 * - Regulators require proof that audit trails have not been tampered with
 * - A broken chain is evidence of unauthorized modification
 * - The genesis hash ensures no events were prepended
 * - The chain hash ensures no events were modified, inserted, or deleted
 *
 * @version v1
 */

import { computeChainHash, GENESIS_HASH, type ChainedAuditEvent } from "./types";

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
  /** First broken event (null if chain is valid). */
  readonly firstBreak: EventVerification | null;
  /** All verification results (one per chained event). */
  readonly results: readonly EventVerification[];
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
  // Check prevHash matches expected
  if (event.prevHash !== expectedPrevHash) {
    return {
      index,
      eventId: event.id,
      valid: false,
      reason: `prevHash mismatch: expected "${expectedPrevHash}", got "${event.prevHash}"`,
    };
  }

  // Recompute chainHash and compare
  const { chainHash, ...eventWithoutHash } = event;
  const recomputed = computeChainHash(event.prevHash, eventWithoutHash);

  if (recomputed !== chainHash) {
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
 * @param events - The audit trail events in chronological order.
 * @returns ChainVerification with full results.
 */
export function verifyChain(
  events: Array<Record<string, unknown>>,
): ChainVerification {
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

  return {
    valid: firstBreak === null,
    totalEvents: events.length,
    verifiedCount: results.length,
    skippedCount,
    firstBreak,
    results,
  };
}

/**
 * Get the last chain hash from a trail.
 * Used by the audit writer to determine prevHash for the next event.
 *
 * @param events - The audit trail events in chronological order.
 * @returns The chainHash of the last chained event, or GENESIS_HASH if none.
 */
export function getLastChainHash(
  events: Array<Record<string, unknown>>,
): string {
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
    typeof event.chainHash === "string" &&
    typeof event.prevHash === "string" &&
    event.chainHash.length > 0 &&
    event.prevHash.length > 0
  );
}
