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

import type { AuditEvent } from "../state/evidence";
import type { AuditEventKind } from "./types";

/** Structured decision receipt derived from decision audit events. */
export interface DecisionReceipt {
  readonly decisionId: string;
  readonly decisionSequence: number;
  readonly gatePhase: string;
  readonly verdict: "approve" | "changes_requested" | "reject";
  readonly rationale: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly fromPhase: string;
  readonly toPhase: string;
  readonly transitionEvent: string;
  readonly policyMode: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly timestamp: string;
}

// ─── Filter Predicate ─────────────────────────────────────────────────────────

/** A predicate function for filtering audit events. */
export type AuditFilter = (event: AuditEvent) => boolean;

// ─── Basic Filters ────────────────────────────────────────────────────────────

/** Filter events by session ID. */
export function bySession(sessionId: string): AuditFilter {
  return (event) => event.sessionId === sessionId;
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
 * Filter events by event kind.
 * Matches against the `event` field prefix (e.g., "transition:" for kind "transition").
 */
export function byKind(kind: AuditEventKind): AuditFilter {
  const prefix = `${kind}:`;
  return (event) => event.event.startsWith(prefix);
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
    if (from !== null && event.timestamp < from) return false;
    if (to !== null && event.timestamp > to) return false;
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
 * Get all events for a specific session, ordered chronologically.
 */
export function sessionEvents(events: AuditEvent[], sessionId: string): AuditEvent[] {
  return filterEvents(events, bySession(sessionId));
}

/**
 * Get all transition events from the trail.
 */
export function transitionEvents(events: AuditEvent[]): AuditEvent[] {
  return filterEvents(events, byKind("transition"));
}

/**
 * Get all tool call events from the trail.
 */
export function toolCallEvents(events: AuditEvent[]): AuditEvent[] {
  return filterEvents(events, byKind("tool_call"));
}

/**
 * Get all error events from the trail.
 */
export function errorEvents(events: AuditEvent[]): AuditEvent[] {
  return filterEvents(events, byKind("error"));
}

/** Get all decision events from the trail. */
export function decisionEvents(events: AuditEvent[]): AuditEvent[] {
  return filterEvents(events, byKind("decision"));
}

/**
 * Extract structured decision receipts from decision events.
 * Invalid/malformed decision event payloads are skipped.
 */
export function decisionReceipts(events: AuditEvent[]): DecisionReceipt[] {
  const receipts: DecisionReceipt[] = [];
  for (const event of decisionEvents(events)) {
    const detail = event.detail as Record<string, unknown>;
    const verdict = detail.verdict;
    const validVerdict = verdict === "approve" || verdict === "changes_requested" || verdict === "reject";
    if (!validVerdict) continue;

    const decisionId = detail.decisionId;
    const decisionSequence = detail.decisionSequence;
    const gatePhase = detail.gatePhase;
    const rationale = detail.rationale;
    const decidedBy = detail.decidedBy;
    const decidedAt = detail.decidedAt;
    const fromPhase = detail.fromPhase;
    const toPhase = detail.toPhase;
    const transitionEvent = detail.transitionEvent;
    const policyMode = detail.policyMode;

    if (
      typeof decisionId !== "string"
      || typeof decisionSequence !== "number"
      || typeof gatePhase !== "string"
      || typeof rationale !== "string"
      || typeof decidedBy !== "string"
      || typeof decidedAt !== "string"
      || typeof fromPhase !== "string"
      || typeof toPhase !== "string"
      || typeof transitionEvent !== "string"
      || typeof policyMode !== "string"
    ) {
      continue;
    }

    receipts.push({
      decisionId,
      decisionSequence,
      gatePhase,
      verdict,
      rationale,
      decidedBy,
      decidedAt,
      fromPhase,
      toPhase,
      transitionEvent,
      policyMode,
      eventId: event.id,
      sessionId: event.sessionId,
      timestamp: event.timestamp,
    });
  }
  return receipts;
}

/**
 * Get distinct session IDs from the trail.
 */
export function distinctSessions(events: AuditEvent[]): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    seen.add(event.sessionId);
  }
  return Array.from(seen);
}

/**
 * Count events by kind for a summary view.
 */
export function countByKind(events: AuditEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    // Extract kind from "kind:detail" format
    const kind = event.event.split(":")[0] || "unknown";
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
 * Get the first and last timestamp from a set of events.
 * Returns null if the events array is empty.
 */
export function timeSpan(
  events: AuditEvent[],
): { first: string; last: string; durationMs: number } | null {
  if (events.length === 0) return null;
  const first = events[0]!.timestamp;
  const last = events[events.length - 1]!.timestamp;
  const durationMs = new Date(last).getTime() - new Date(first).getTime();
  return { first, last, durationMs };
}
