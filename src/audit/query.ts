/**
 * @module audit/query
 * @description Query and filter utilities for the FlowGuard audit trail.
 *
 * All functions are pure — they take an array of events and return filtered/transformed arrays.
 * No I/O — the caller reads the trail via persistence.readAuditTrail() first.
 *
 * Design:
 * - Functional filter combinators — compose for complex queries
 * - Type-safe predicate builders for each filterable dimension
 * - Chronological ordering guaranteed (input must be chronological)
 * - Works with both legacy (AuditEvent) and chained (ChainedAuditEvent) events
 *
 * @version v1
 */

import type { AuditEvent } from '../state/evidence.js';
import type { AuditEventKind } from './types.js';
import { ENFORCEMENT_DENIED_EVENT_NAME, STATE_WRITE_EVENT_NAME } from './types.js';

/** Structured decision receipt derived from decision audit events. */
export interface DecisionReceipt {
  readonly decisionId: string;
  readonly decisionSequence: number;
  readonly gatePhase: string;
  readonly verdict: 'approve' | 'changes_requested' | 'reject';
  readonly rationale: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly fromPhase: string;
  readonly toPhase: string;
  readonly transitionEvent: string;
  readonly policyMode: string;
  readonly eventId: string;
  /** FlowGuard session identity (the same FlowGuard UUID on every event class). */
  readonly flowguardSessionId: string;
  /** Host session identity where bound (OpenCode session id). */
  readonly hostSessionId?: string;
  readonly timestamp: string;
}

// ─── Filter Predicate ─────────────────────────────────────────────────────────

/** A predicate function for filtering audit events. */
export type AuditFilter = (event: AuditEvent) => boolean;

// ─── Basic Filters ────────────────────────────────────────────────────────────

/**
 * Filter events by session identity. Matches either explicit identity —
 * `flowguardSessionId` (FlowGuard UUID) or `hostSessionId` (host session id).
 * Events never carry a polymorphic sessionId.
 */
export function bySession(sessionId: string): AuditFilter {
  return (event) => event.flowguardSessionId === sessionId || event.hostSessionId === sessionId;
}

/** Filter events by phase (exact match). */
export function byPhase(phase: string): AuditFilter {
  return (event) => event.phase === phase;
}

/** Filter events by multiple phases (OR). */
export function byPhases(phases: string[]): AuditFilter {
  const set = new Set(phases);
  return (event) => set.has(event.phase);
}

/** Filter events by actor (exact match). */
export function byActor(actor: string): AuditFilter {
  return (event) => event.actor === actor;
}

/**
 * Kinds whose audit-chain.v3 event name is not of the form `${kind}:...`.
 * Every other kind uses the `${kind}:` prefix form.
 */
const EXACT_EVENT_NAME_BY_KIND: Partial<Record<AuditEventKind, string>> = {
  state_write: STATE_WRITE_EVENT_NAME,
  enforcement_denied: ENFORCEMENT_DENIED_EVENT_NAME,
};

/**
 * Filter events by event kind.
 *
 * The `event` field carries the kind discriminator, but the audit-chain.v3
 * event names are not uniformly `${kind}:...`. Two current factories emit
 * non-prefix names — `state_write` (no suffix) and `enforcement:denied`
 * (whose kind is `enforcement_denied`) — so those are matched exactly.
 */
export function byKind(kind: AuditEventKind): AuditFilter {
  const exact = EXACT_EVENT_NAME_BY_KIND[kind];
  if (exact !== undefined) return (event) => event.event === exact;
  return (event) => event.event.startsWith(`${kind}:`);
}

/**
 * Filter events by exact event name.
 * E.g., "transition:PLAN_READY", "tool_call:flowguard_plan".
 */
export function byEvent(eventName: string): AuditFilter {
  return (event) => event.event === eventName;
}

/**
 * Filter events by time range (inclusive).
 * Both from and to are ISO-8601 datetime strings.
 * Either can be null to indicate an open-ended range.
 */
export function byTimeRange(from: string | null, to: string | null): AuditFilter {
  return (event) => {
    if (from !== null && event.occurredAt < from) return false;
    if (to !== null && event.occurredAt > to) return false;
    return true;
  };
}

/**
 * Filter events by a detail field value.
 * Checks `event.detail[key] === value`.
 */
export function byDetail(key: string, value: unknown): AuditFilter {
  return (event) => event.detail[key] === value;
}

// ─── Combinator Helpers ───────────────────────────────────────────────────────

/** Combine multiple filters with AND logic (all must match). */
export function allOf(...filters: AuditFilter[]): AuditFilter {
  return (event) => filters.every((f) => f(event));
}

/** Combine multiple filters with OR logic (any must match). */
export function anyOf(...filters: AuditFilter[]): AuditFilter {
  return (event) => filters.some((f) => f(event));
}

/** Negate a filter. */
export function not(filter: AuditFilter): AuditFilter {
  return (event) => !filter(event);
}

// ─── Query Functions ──────────────────────────────────────────────────────────

/**
 * Apply a filter to an event array. Returns matching events in original order.
 */
export function filterEvents(events: AuditEvent[], filter: AuditFilter): AuditEvent[] {
  return events.filter(filter);
}

/**
 * Get all events for a specific session, in trail (record) order.
 *
 * This preserves the order of the input trail, which under audit-chain.v3 is
 * `recordedAt` order — the order the append authority committed the events.
 * That is not necessarily `occurredAt` order: see {@link timeSpan}.
 */
export function sessionEvents(events: AuditEvent[], sessionId: string): AuditEvent[] {
  return filterEvents(events, bySession(sessionId));
}

/**
 * Get all transition events from the trail.
 */
export function transitionEvents(events: AuditEvent[]): AuditEvent[] {
  return filterEvents(events, byKind('transition'));
}

/**
 * Get all tool call events from the trail.
 */
export function toolCallEvents(events: AuditEvent[]): AuditEvent[] {
  return filterEvents(events, byKind('tool_call'));
}

/**
 * Get all error events from the trail.
 */
export function errorEvents(events: AuditEvent[]): AuditEvent[] {
  return filterEvents(events, byKind('error'));
}

/** Get all decision events from the trail. */
export function decisionEvents(events: AuditEvent[]): AuditEvent[] {
  return filterEvents(events, byKind('decision'));
}

/**
 * Extract structured decision receipts from decision events.
 * Invalid/malformed decision event payloads are skipped.
 */
function toDecisionReceipt(event: AuditEvent): DecisionReceipt | null {
  const detail = event.detail;
  const verdict = detail.verdict;
  if (verdict !== 'approve' && verdict !== 'changes_requested' && verdict !== 'reject') return null;

  const stringFields = [
    'decisionId',
    'gatePhase',
    'rationale',
    'decidedBy',
    'decidedAt',
    'fromPhase',
    'toPhase',
    'transitionEvent',
    'policyMode',
  ] as const;
  if (stringFields.some((f) => typeof detail[f] !== 'string')) return null;
  if (typeof detail.decisionSequence !== 'number') return null;

  return {
    decisionId: detail.decisionId as string,
    decisionSequence: detail.decisionSequence,
    gatePhase: detail.gatePhase as string,
    verdict,
    rationale: detail.rationale as string,
    decidedBy: detail.decidedBy as string,
    decidedAt: detail.decidedAt as string,
    fromPhase: detail.fromPhase as string,
    toPhase: detail.toPhase as string,
    transitionEvent: detail.transitionEvent as string,
    policyMode: detail.policyMode as string,
    eventId: event.id,
    flowguardSessionId: event.flowguardSessionId,
    ...(event.hostSessionId ? { hostSessionId: event.hostSessionId } : {}),
    timestamp: event.occurredAt,
  };
}

export function decisionReceipts(events: AuditEvent[]): DecisionReceipt[] {
  const receipts: DecisionReceipt[] = [];
  for (const event of decisionEvents(events)) {
    const receipt = toDecisionReceipt(event);
    if (receipt) receipts.push(receipt);
  }
  return receipts;
}

/**
 * Get distinct FlowGuard session IDs from the trail.
 */
export function distinctSessions(events: AuditEvent[]): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    seen.add(event.flowguardSessionId);
  }
  return Array.from(seen);
}

/**
 * Resolve the kind namespace of an event for counting.
 *
 * Unlike {@link byKind} this is not restricted to AuditEventKind: free
 * namespaces such as `review:*` are counted under their own prefix. Only
 * `enforcement:denied` needs an explicit mapping, because its prefix
 * (`enforcement`) is not its kind (`enforcement_denied`).
 */
function eventKindName(event: AuditEvent): string {
  if (event.event === ENFORCEMENT_DENIED_EVENT_NAME) return 'enforcement_denied';
  const separator = event.event.indexOf(':');
  return separator === -1 ? event.event : event.event.slice(0, separator);
}

/**
 * Count events by kind for a summary view.
 */
export function countByKind(events: AuditEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const kind = eventKindName(event) || 'unknown';
    counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

/**
 * Count events by phase for a distribution view.
 */
export function countByPhase(events: AuditEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    counts[event.phase] = (counts[event.phase] || 0) + 1;
  }
  return counts;
}

/**
 * Get the earliest and latest occurrence time from a set of events.
 *
 * Computed as min/max over `occurredAt`, not as first/last element. Under
 * audit-chain.v3 the trail is ordered by `recordedAt` (the writer's append
 * authority), and a reconciled outbox event may legitimately carry an older
 * `occurredAt` than the event recorded before it. Reading the endpoints
 * positionally would therefore report a wrong — and possibly negative — span.
 *
 * Returns null if the events array is empty.
 */
export function timeSpan(
  events: AuditEvent[],
): { first: string; last: string; durationMs: number } | null {
  if (events.length === 0) return null;
  let first = events[0]!.occurredAt;
  let last = first;
  let firstMs = Date.parse(first);
  let lastMs = firstMs;
  for (const event of events) {
    const ms = Date.parse(event.occurredAt);
    if (Number.isNaN(ms)) continue;
    if (Number.isNaN(firstMs) || ms < firstMs) {
      first = event.occurredAt;
      firstMs = ms;
    }
    if (Number.isNaN(lastMs) || ms > lastMs) {
      last = event.occurredAt;
      lastMs = ms;
    }
  }
  const durationMs = lastMs - firstMs;
  return { first, last, durationMs };
}
