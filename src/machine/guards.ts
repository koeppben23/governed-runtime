/**
 * @module guards
 * @description Guard functions — pure predicates over SessionState.
 *              For each guard-based phase: an ordered list of (event, guard) pairs.
 *              First match wins. Deterministic — guards are evaluated top-to-bottom.
 *
 * Design:
 * - Guards are pure functions: (state) → boolean. No side effects.
 * - ERROR guard is always first (fail-closed: if error is present, it fires first).
 * - User-gate phases (PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW) are NOT in this table —
 *   they wait for explicit human commands.
 * - Terminal phases (COMPLETE, ARCH_COMPLETE, REVIEW_COMPLETE) are NOT in this table.
 * - READY is NOT in this table — it is command-driven (no auto-advance).
 *
 * @version v2
 */

import type { SessionState, Phase, Event } from '../state/schema.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A guard is a pure function: (state) → boolean. */
export type GuardFn = (state: SessionState) => boolean;

/** Guard entry: the event to fire if the guard predicate returns true. */
export interface GuardEntry {
  readonly event: Event;
  readonly guard: GuardFn;
}

// ─── Guard Predicates ─────────────────────────────────────────────────────────

/** Error is present — triggers ERROR event (always checked first). */
export const hasError: GuardFn = (s) => s.error !== null;

/** Ticket present AND plan has a current version → ready to advance. */
export const hasPlanReady: GuardFn = (s) => s.ticket !== null && s.plan !== null;

/**
 * Convergence predicate for review loops (digest-stop).
 *
 * Converged when:
 *   iteration >= maxIterations (force-convergence)
 *   OR (revisionDelta === "none" AND verdict === "approve") (stable approval)
 *
 * Structural interface — works with SelfReviewLoop, ImplReviewResult,
 * or any object with the required shape. No type imports needed.
 */
export function isConverged(review: {
  readonly iteration: number;
  readonly maxIterations: number;
  readonly revisionDelta: string;
  readonly verdict: string;
}): boolean {
  return (
    review.iteration >= review.maxIterations ||
    (review.revisionDelta === 'none' && review.verdict === 'approve')
  );
}

/**
 * Self-review loop converged.
 * Used by both PLAN and ARCHITECTURE phases.
 */
export const selfReviewMet: GuardFn = (s) => {
  if (s.selfReview === null) return false;
  return isConverged(s.selfReview);
};

/** Self-review loop still iterating. Used by both PLAN and ARCHITECTURE phases. */
export const selfReviewPending: GuardFn = (s) => s.selfReview !== null && !selfReviewMet(s);

/**
 * All active validation checks passed.
 * Requires: at least one check exists AND every active check has a passing result.
 *
 * Uses Set-based lookup for O(n + m) instead of O(n * m) nested iteration.
 */
export const allValidationsPassed: GuardFn = (s) => {
  if (s.activeChecks.length === 0) return false;
  const passedIds = new Set<string>();
  for (const v of s.validation) {
    if (v.passed) passedIds.add(v.checkId);
  }
  return s.activeChecks.every((checkId) => passedIds.has(checkId));
};

/** At least one validation check was executed and not all passed. */
export const checkFailed: GuardFn = (s) => s.validation.length > 0 && !allValidationsPassed(s);

/** Implementation evidence is present. */
export const implComplete: GuardFn = (s) => s.implementation !== null;

/**
 * Implementation review loop converged.
 * Same convergence logic as self-review (digest-stop).
 */
export const implReviewMet: GuardFn = (s) => {
  if (s.implReview === null) return false;
  return isConverged(s.implReview);
};

/** Implementation review loop still iterating. */
export const implReviewPending: GuardFn = (s) => s.implReview !== null && !implReviewMet(s);

/** Review report has been generated (review flow completion). */
export const reviewDone: GuardFn = (s) => s.phase === 'REVIEW';

// ─── Guard Table ──────────────────────────────────────────────────────────────

/**
 * For each guard-based phase: an ordered list of guard entries.
 *
 * Evaluation algorithm:
 *   for (entry of GUARDS.get(phase))
 *     if (entry.guard(state)) → fire entry.event
 *   // no match → EvalResult.no_match (should never happen if guards are exhaustive)
 *
 * ERROR is always first — fail-closed by design.
 * The last guard in each list is the "true fallback" (always-true condition)
 * to ensure deterministic resolution.
 *
 * Phases NOT in this table:
 * - READY: command-driven (no guards)
 * - PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW: user gates
 * - COMPLETE, ARCH_COMPLETE, REVIEW_COMPLETE: terminal
 */
export const GUARDS: ReadonlyMap<Phase, readonly GuardEntry[]> = new Map<
  Phase,
  readonly GuardEntry[]
>([
  [
    'TICKET',
    [
      { event: 'ERROR', guard: hasError },
      { event: 'PLAN_READY', guard: hasPlanReady },
    ],
  ],

  [
    'PLAN',
    [
      { event: 'ERROR', guard: hasError },
      { event: 'SELF_REVIEW_MET', guard: selfReviewMet },
      { event: 'SELF_REVIEW_PENDING', guard: selfReviewPending },
    ],
  ],

  [
    'VALIDATION',
    [
      { event: 'ERROR', guard: hasError },
      { event: 'ALL_PASSED', guard: allValidationsPassed },
      { event: 'CHECK_FAILED', guard: checkFailed },
    ],
  ],

  [
    'IMPLEMENTATION',
    [
      { event: 'ERROR', guard: hasError },
      { event: 'IMPL_COMPLETE', guard: implComplete },
    ],
  ],

  [
    'IMPL_REVIEW',
    [
      { event: 'ERROR', guard: hasError },
      { event: 'REVIEW_MET', guard: implReviewMet },
      { event: 'REVIEW_PENDING', guard: implReviewPending },
    ],
  ],

  // ARCHITECTURE reuses the same self-review convergence guards as PLAN.
  [
    'ARCHITECTURE',
    [
      { event: 'ERROR', guard: hasError },
      { event: 'SELF_REVIEW_MET', guard: selfReviewMet },
      { event: 'SELF_REVIEW_PENDING', guard: selfReviewPending },
    ],
  ],

  // REVIEW: auto-advances to REVIEW_COMPLETE after report generation.
  // The reviewDone guard fires immediately (the rail sets phase to REVIEW
  // after generating the report, then autoAdvance fires this guard).
  [
    'REVIEW',
    [
      { event: 'ERROR', guard: hasError },
      { event: 'REVIEW_DONE', guard: reviewDone },
    ],
  ],
]);
