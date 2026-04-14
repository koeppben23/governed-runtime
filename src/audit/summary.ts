/**
 * @module audit/summary
 * @description Session timeline and compliance summary generation from the audit trail.
 *
 * Generates structured summaries from raw audit events:
 * - SessionTimeline: ordered view of a single session's lifecycle
 * - ComplianceSummary: high-level pass/fail status for audit review
 *
 * These are read-only reports derived from the audit trail.
 * Useful for:
 * - Compliance officers reviewing a session
 * - Automated compliance checks (CI/CD gates)
 * - Human-readable export for external auditors
 *
 * @version v1
 */

import type { AuditEvent } from "../state/evidence";
import {
  sessionEvents,
  countByKind,
  countByPhase,
  timeSpan,
  transitionEvents,
  errorEvents,
  bySession,
  filterEvents,
  byKind,
} from "./query";
import type { ChainVerification } from "./integrity";

// ─── Timeline Types ───────────────────────────────────────────────────────────

/** A single entry in the session timeline. */
export interface TimelineEntry {
  /** ISO-8601 timestamp. */
  readonly timestamp: string;
  /** Event kind prefix (transition, tool_call, error, lifecycle). */
  readonly kind: string;
  /** Full event name (e.g., "transition:PLAN_READY"). */
  readonly event: string;
  /** Phase at this point. */
  readonly phase: string;
  /** Actor (machine, human, system). */
  readonly actor: string;
  /** One-line human-readable description. */
  readonly description: string;
}

/** Complete session timeline. */
export interface SessionTimeline {
  sessionId: string;
  /** Total events in this session. */
  eventCount: number;
  /** Time span of the session. */
  timeSpan: { first: string; last: string; durationMs: number } | null;
  /** Phase progression (ordered list of phases visited). */
  phaseProgression: string[];
  /** Ordered timeline entries. */
  entries: TimelineEntry[];
}

// ─── Compliance Summary Types ─────────────────────────────────────────────────

/** Compliance check result. */
export interface ComplianceCheck {
  /** Check name. */
  readonly name: string;
  /** Whether this check passed. */
  readonly passed: boolean;
  /** Explanation. */
  readonly detail: string;
}

/** High-level compliance summary for a session. */
export interface ComplianceSummary {
  sessionId: string;
  /** Overall pass/fail. */
  compliant: boolean;
  /** Individual checks. */
  checks: ComplianceCheck[];
  /** Event statistics. */
  stats: {
    totalEvents: number;
    byKind: Record<string, number>;
    byPhase: Record<string, number>;
  };
  /** Chain integrity result (if verified). */
  chainIntegrity: ChainVerification | null;
  /** Generated at timestamp. */
  generatedAt: string;
}

// ─── Timeline Generator ──────────────────────────────────────────────────────

/**
 * Generate a session timeline from the audit trail.
 *
 * @param events - All audit events (multi-session OK — will be filtered).
 * @param sessionId - The session to generate a timeline for.
 * @returns SessionTimeline with ordered entries.
 */
export function generateTimeline(
  events: AuditEvent[],
  sessionId: string,
): SessionTimeline {
  const filtered = sessionEvents(events, sessionId);
  const span = timeSpan(filtered);

  // Track phase progression (deduped, ordered)
  const phaseProgression: string[] = [];
  for (const event of filtered) {
    const lastPhase = phaseProgression[phaseProgression.length - 1];
    if (event.phase !== lastPhase) {
      phaseProgression.push(event.phase);
    }
  }

  // Build timeline entries
  const entries: TimelineEntry[] = filtered.map((event) => ({
    timestamp: event.timestamp,
    kind: event.event.split(":")[0] || "unknown",
    event: event.event,
    phase: event.phase,
    actor: event.actor,
    description: describeEvent(event),
  }));

  return {
    sessionId,
    eventCount: filtered.length,
    timeSpan: span,
    phaseProgression,
    entries,
  };
}

// ─── Compliance Summary Generator ─────────────────────────────────────────────

/**
 * Generate a compliance summary for a session.
 *
 * Checks:
 * 1. Session has lifecycle:session_created event
 * 2. Session reached COMPLETE phase (or was explicitly aborted)
 * 3. No unresolved errors
 * 4. Human review gates were honored (PLAN_REVIEW, EVIDENCE_REVIEW)
 * 5. Validation phase was executed
 * 6. Chain integrity (if verification provided)
 *
 * @param events - All audit events (multi-session OK).
 * @param sessionId - The session to check.
 * @param chainVerification - Optional chain verification result.
 * @param now - Current timestamp for the report.
 */
export function generateComplianceSummary(
  events: AuditEvent[],
  sessionId: string,
  chainVerification: ChainVerification | null,
  now: string,
): ComplianceSummary {
  const filtered = sessionEvents(events, sessionId);
  const transitions = filterEvents(filtered, byKind("transition"));

  const checks: ComplianceCheck[] = [
    checkSessionCreated(filtered),
    checkSessionTerminated(filtered),
    checkNoUnresolvedErrors(filtered),
    ...checkReviewGatesHonored(filtered, transitions),
    checkValidationExecuted(filtered),
  ];

  if (chainVerification) {
    checks.push(checkChainIntegrity(chainVerification));
  }

  const compliant = checks.every((c) => c.passed);

  return {
    sessionId,
    compliant,
    checks,
    stats: {
      totalEvents: filtered.length,
      byKind: countByKind(filtered),
      byPhase: countByPhase(filtered),
    },
    chainIntegrity: chainVerification,
    generatedAt: now,
  };
}

// ─── Individual Compliance Checks ─────────────────────────────────────────────

/** Check 1: Session was properly created. */
function checkSessionCreated(filtered: AuditEvent[]): ComplianceCheck {
  const hasCreation = filtered.some(
    (e) => e.event === "lifecycle:session_created",
  );
  return {
    name: "session_created",
    passed: hasCreation,
    detail: hasCreation
      ? "Session was properly initialized"
      : "No session creation event found (may be a legacy session)",
  };
}

/** Check 2: Session reached terminal state. */
function checkSessionTerminated(filtered: AuditEvent[]): ComplianceCheck {
  const hasCompletion = filtered.some(
    (e) =>
      e.event === "lifecycle:session_completed" ||
      e.event === "lifecycle:session_aborted",
  );
  const lastPhase = filtered.length > 0 ? filtered[filtered.length - 1]!.phase : "unknown";
  return {
    name: "session_terminated",
    passed: hasCompletion || lastPhase === "COMPLETE",
    detail: hasCompletion
      ? `Session terminated (${filtered.find((e) => e.event.startsWith("lifecycle:session_"))?.event ?? "unknown"})`
      : lastPhase === "COMPLETE"
        ? "Session reached COMPLETE phase"
        : `Session is in phase ${lastPhase} (not terminated)`,
  };
}

/** Check 3: No unresolved errors at session end. */
function checkNoUnresolvedErrors(filtered: AuditEvent[]): ComplianceCheck {
  const errors = filterEvents(filtered, byKind("error"));
  const lastError = errors.length > 0 ? errors[errors.length - 1] : null;
  const lastPhase = filtered.length > 0 ? filtered[filtered.length - 1]!.phase : "unknown";
  const hasUnresolvedError = lastError !== null && lastPhase !== "COMPLETE";
  return {
    name: "no_unresolved_errors",
    passed: !hasUnresolvedError,
    detail: hasUnresolvedError
      ? `Unresolved error: ${lastError!.event} in phase ${lastError!.phase}`
      : errors.length === 0
        ? "No errors recorded"
        : `${errors.length} error(s) recorded, all resolved`,
  };
}

/**
 * Check 4: Human review gates were honored (PLAN_REVIEW + EVIDENCE_REVIEW).
 * Returns two ComplianceCheck entries — one per gate.
 */
function checkReviewGatesHonored(
  filtered: AuditEvent[],
  transitions: AuditEvent[],
): readonly [ComplianceCheck, ComplianceCheck] {
  const passedPlanReview = transitions.some(
    (e) => e.detail?.from === "PLAN_REVIEW",
  );
  const passedEvidenceReview = transitions.some(
    (e) => e.detail?.from === "EVIDENCE_REVIEW",
  );
  const reachedValidation = filtered.some((e) => e.phase === "VALIDATION");
  const reachedComplete = filtered.some((e) => e.phase === "COMPLETE");

  return [
    {
      name: "plan_review_honored",
      passed: passedPlanReview || !reachedValidation,
      detail: passedPlanReview
        ? "Plan was reviewed by a human before validation"
        : reachedValidation
          ? "WARNING: Reached VALIDATION without plan review transition record"
          : "Session did not reach VALIDATION (plan review not applicable)",
    },
    {
      name: "evidence_review_honored",
      passed: passedEvidenceReview || !reachedComplete,
      detail: passedEvidenceReview
        ? "Evidence was reviewed by a human before completion"
        : reachedComplete
          ? "WARNING: Reached COMPLETE without evidence review transition record"
          : "Session did not reach COMPLETE (evidence review not applicable)",
    },
  ];
}

/** Check 5: Validation phase was executed with tool calls. */
function checkValidationExecuted(filtered: AuditEvent[]): ComplianceCheck {
  const reachedValidation = filtered.some((e) => e.phase === "VALIDATION");
  const validationEvents = filtered.filter(
    (e) => e.phase === "VALIDATION" && e.event.startsWith("tool_call:flowguard_validate"),
  );
  return {
    name: "validation_executed",
    passed: validationEvents.length > 0 || !reachedValidation,
    detail: validationEvents.length > 0
      ? `${validationEvents.length} validation check(s) recorded`
      : reachedValidation
        ? "WARNING: Reached VALIDATION but no validation tool calls recorded"
        : "Session did not reach VALIDATION (validation not applicable)",
  };
}

/** Check 6: Chain integrity verification. */
function checkChainIntegrity(chainVerification: ChainVerification): ComplianceCheck {
  return {
    name: "chain_integrity",
    passed: chainVerification.valid,
    detail: chainVerification.valid
      ? `Chain verified: ${chainVerification.verifiedCount} events, ${chainVerification.skippedCount} legacy`
      : `Chain BROKEN at event #${chainVerification.firstBreak?.index ?? "?"}: ${chainVerification.firstBreak?.reason ?? "unknown"}`,
  };
}

// ─── Internal ─────────────────────────────────────────────────────────────────

/**
 * Generate a human-readable one-line description for an audit event.
 */
function describeEvent(event: AuditEvent): string {
  const parts = event.event.split(":");
  const kind = parts[0];
  const detail = parts.slice(1).join(":");

  switch (kind) {
    case "transition":
      return `State transition: ${event.detail?.from ?? "?"} → ${event.detail?.to ?? "?"} via ${detail}`;
    case "tool_call":
      return `Tool call: ${detail} (${event.detail?.success ? "success" : "failed"})`;
    case "error":
      return `Error: ${event.detail?.code ?? detail} — ${event.detail?.message ?? "no message"}`;
    case "lifecycle":
      return `Lifecycle: ${detail.replace(/_/g, " ")}`;
    default:
      return event.event;
  }
}
