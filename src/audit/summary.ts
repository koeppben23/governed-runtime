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

import type { AuditEvent } from '../state/evidence.js';
import {
  sessionEvents,
  countByKind,
  countByPhase,
  timeSpan,
  filterEvents,
  byKind,
} from './query.js';
import type { ChainVerification } from './integrity.js';
import { isTerminalPhase } from '../machine/topology.js';

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
export function generateTimeline(events: AuditEvent[], sessionId: string): SessionTimeline {
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
    timestamp: event.occurredAt,
    kind: event.event.split(':')[0] || 'unknown',
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
  const transitions = filterEvents(filtered, byKind('transition'));

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
  const hasCreation = filtered.some((e) => e.event === 'lifecycle:session_created');
  return {
    name: 'session_created',
    passed: hasCreation,
    detail: hasCreation
      ? 'Session was properly initialized'
      : 'No session creation event found (may be a legacy session)',
  };
}

/** Check 2: Session reached terminal state. */
function checkSessionTerminated(filtered: AuditEvent[]): ComplianceCheck {
  const terminalLifecycle = filtered.find(
    (e) => e.event === 'lifecycle:session_completed' || e.event === 'lifecycle:session_aborted',
  );
  const lastEvent = filtered[filtered.length - 1];
  const lastPhase = lastEvent === undefined ? 'unknown' : lastEvent.phase;
  return {
    name: 'session_terminated',
    passed: terminalLifecycle !== undefined || isTerminalPhase(lastPhase),
    detail:
      terminalLifecycle !== undefined
        ? `Session terminated (${terminalLifecycle.event})`
        : isTerminalPhase(lastPhase)
          ? `Session reached terminal phase ${lastPhase}`
          : `Session is in phase ${lastPhase} (not terminated)`,
  };
}

/** Check 3: No unresolved errors at session end. */
function checkNoUnresolvedErrors(filtered: AuditEvent[]): ComplianceCheck {
  const errors = filterEvents(filtered, byKind('error'));
  const lastError = errors[errors.length - 1] ?? null;
  const lastEvent = filtered[filtered.length - 1];
  const lastPhase = lastEvent === undefined ? 'unknown' : lastEvent.phase;
  const hasUnresolvedError = lastError !== null && !isTerminalPhase(lastPhase);
  return {
    name: 'no_unresolved_errors',
    passed: !hasUnresolvedError,
    detail:
      hasUnresolvedError && lastError !== null
        ? `Unresolved error: ${lastError.event} in phase ${lastError.phase}`
        : errors.length === 0
          ? 'No errors recorded'
          : `${errors.length} error(s) recorded; session reached terminal phase ${lastPhase}`,
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
  const passedPlanReview = transitions.some((e) => e.detail?.from === 'PLAN_REVIEW');
  const passedEvidenceReview = transitions.some((e) => e.detail?.from === 'EVIDENCE_REVIEW');
  const reachedValidation = filtered.some((e) => e.phase === 'VALIDATION');
  const reachedComplete = filtered.some((e) => e.phase === 'COMPLETE');

  return [
    {
      name: 'plan_review_honored',
      passed: passedPlanReview || !reachedValidation,
      detail: passedPlanReview
        ? 'Plan was reviewed by a human before validation'
        : reachedValidation
          ? 'WARNING: Reached VALIDATION without plan review transition record'
          : 'Session did not reach VALIDATION (plan review not applicable)',
    },
    {
      name: 'evidence_review_honored',
      passed: passedEvidenceReview || !reachedComplete,
      detail: passedEvidenceReview
        ? 'Evidence was reviewed by a human before completion'
        : reachedComplete
          ? 'WARNING: Reached COMPLETE without evidence review transition record'
          : 'Session did not reach COMPLETE (evidence review not applicable)',
    },
  ];
}

const VALIDATION_PHASES: ReadonlySet<string> = new Set(['VALIDATION', 'IMPL_VALIDATION']);
const VALIDATION_OUTCOME_EVENTS: ReadonlySet<string> = new Set([
  'ALL_PASSED',
  'CHECK_FAILED',
  'CHECK_ERRORED',
]);

function isValidationPhase(value: unknown): value is string {
  return typeof value === 'string' && VALIDATION_PHASES.has(value);
}

/**
 * Automatic validation executes the canonical run-check path in-process. It
 * cannot emit a host `tool_call:flowguard_run_check` event, but it does emit the
 * machine's validation-outcome transition. Counting that transition is sound:
 * the guards only fire after the phase's canonical validation evidence is
 * satisfied (or after an executed check failed/errored).
 */
function isValidationOutcomeTransition(event: AuditEvent): boolean {
  if (!event.event.startsWith('transition:')) return false;
  if (!isValidationPhase(event.detail?.from)) return false;
  return VALIDATION_OUTCOME_EVENTS.has(event.event.slice('transition:'.length));
}

/** Check 5: Validation phase has explicit or automatic execution evidence. */
function checkValidationExecuted(filtered: AuditEvent[]): ComplianceCheck {
  const reachedValidation = filtered.some((e) => isValidationPhase(e.phase));
  const explicitChecks = filtered.filter(
    (e) => isValidationPhase(e.phase) && e.event.startsWith('tool_call:flowguard_run_check'),
  );
  const automaticOutcomes = filtered.filter(isValidationOutcomeTransition);
  const evidenceCount = explicitChecks.length + automaticOutcomes.length;
  return {
    name: 'validation_executed',
    passed: evidenceCount > 0 || !reachedValidation,
    detail:
      evidenceCount > 0
        ? `${explicitChecks.length} explicit validation check(s) and ${automaticOutcomes.length} automatic validation outcome(s) recorded`
        : reachedValidation
          ? 'WARNING: Reached a validation phase but no validation execution evidence recorded'
          : 'Session did not reach VALIDATION (validation not applicable)',
  };
}

/** Check 6: Chain integrity verification. */
function checkChainIntegrity(chainVerification: ChainVerification): ComplianceCheck {
  if (chainVerification.valid) {
    return {
      name: 'chain_integrity',
      passed: true,
      detail: `Chain verified: ${chainVerification.verifiedCount} events`,
    };
  }

  // Failure — use typed reason for explicit detail.
  const { reason, firstBreak } = chainVerification;

  if (reason === 'AUDIT_ENVELOPE_INVALID') {
    return {
      name: 'chain_integrity',
      passed: false,
      detail: `${firstBreak?.reason ?? 'Audit envelope violations are unsupported'} at event #${firstBreak?.index ?? '?'}`,
    };
  }

  // CHAIN_BREAK or unknown — use firstBreak details.
  return {
    name: 'chain_integrity',
    passed: false,
    detail: `Chain BROKEN at event #${firstBreak?.index ?? '?'}: ${firstBreak?.reason ?? 'unknown'}`,
  };
}

// ─── Internal ─────────────────────────────────────────────────────────────────

/**
 * Generate a human-readable one-line description for an audit event.
 */
const EVENT_DESCRIBERS: Record<string, (event: AuditEvent, detail: string) => string> = {
  transition: (event, detail) =>
    `State transition: ${event.detail?.from ?? '?'} → ${event.detail?.to ?? '?'} via ${detail}`,
  tool_call: (event, detail) =>
    `Tool call: ${detail} (${event.detail?.success ? 'success' : 'failed'})`,
  error: (event, detail) =>
    `Error: ${event.detail?.code ?? detail} — ${event.detail?.message ?? 'no message'}`,
  lifecycle: (_event, detail) => `Lifecycle: ${detail.replace(/_/g, ' ')}`,
};

function describeEvent(event: AuditEvent): string {
  const parts = event.event.split(':');
  const kind = parts[0];
  if (kind === undefined) return event.event;
  const detail = parts.slice(1).join(':');
  return EVENT_DESCRIBERS[kind]?.(event, detail) ?? event.event;
}
