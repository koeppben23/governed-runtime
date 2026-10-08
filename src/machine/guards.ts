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
 * - Terminal phases (COMPLETE, ARCH_COMPLETE, PEER_REVIEW_COMPLETE) are NOT in this table.
 * - READY is NOT in this table — it is command-driven (no auto-advance).
 *
 * @version v2
 */

import type { LoopVerdict } from '../state/evidence.js';
import type { SessionState, Phase, Event } from '../state/schema.js';
import { isTechnicalValidationBlock, type ValidationResult } from '../state/evidence-validation.js';
import {
  hasOutstandingReviewObligation,
  hasUnresolvedIntegrityIncident,
} from '../state/review-dispatch.js';
import {
  resolveEffectiveTaskClass,
  ticketRiskDeclarationFloor,
  verifyTicketRiskDeclarationIntegrity,
  type TicketRiskDeclaration,
} from '../state/risk-declaration.js';
import { assessMinimumTaskClass, reducedCeremonyEligible } from '../state/risk-path-classifier.js';
import { evaluateValidationEvidence } from './validation-evidence.js';
import { evaluateImplValidationEvidence } from './impl-validation-evidence.js';

function isTechnicalValidationResult(result: ValidationResult): boolean {
  return isTechnicalValidationBlock({
    passed: result.passed,
    outcome: result.outcome,
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    ...(result.assertionExtraction !== undefined
      ? { assertionExtraction: result.assertionExtraction }
      : {}),
  });
}

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
 *   OR (revisionDelta === "none" AND verdict === "accept") (stable approval)
 *
 * Special case (P1.3 — third LoopVerdict):
 *   verdict === "unable_to_review" returns false UNCONDITIONALLY.
 *
 * The 'unable_to_review' verdict is a tool-failure signal from the reviewer
 * subagent (see src/templates/mandates.ts validity-conditions whitelist).
 * It MUST NOT count as convergence on either disjunct:
 *
 * 1. The "stable approval" disjunct does not apply (verdict !== "accept").
 * 2. The "iteration >= maxIterations" force-convergence disjunct WOULD
 *    otherwise force-converge an unreviewable submission, which is
 *    exactly the failure mode this slice prevents. A reviewer that has
 *    declared the input unreviewable must not have its verdict silently
 *    upgraded to "converged" by exhausting the iteration budget — the
 *    runtime must instead route to BLOCKED (slice 4c) so the user submits
 *    a fresh /plan or /implement.
 *
 * Implementation: explicit early-return BEFORE the existing condition,
 * so the maxIterations branch cannot fire when the verdict is
 * 'unable_to_review'. The order matters; do not reorder these.
 *
 * Structural interface — works with SelfReviewLoop, ImplReviewResult,
 * or any object with the required shape.
 */
export function isConverged(review: {
  readonly iteration: number;
  readonly maxIterations: number;
  readonly revisionDelta: string;
  readonly verdict: LoopVerdict;
}): boolean {
  // P1.3 slice 4a: unable_to_review never converges, even on the
  // iteration >= maxIterations disjunct. Routed to BLOCKED in slice 4c.
  if (review.verdict === 'unable_to_review') return false;
  return (
    review.iteration >= review.maxIterations ||
    (review.revisionDelta === 'none' && review.verdict === 'accept')
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
 *
 * Vacuous truth: if activeChecks is empty (no verificationCandidates
 * discovered), all checks are trivially satisfied → returns true. This allows
 * low-risk sessions without discoverable commands to skip VALIDATION cleanly.
 *
 * Policy gate (#400): under policy-gated validation-evidence enforcement
 * ('required' without the explicit `allowNoCommands` exception), an empty
 * active-check list MUST NOT pass vacuously. The single authority
 * `evaluateValidationEvidence` decides admissibility; when it reports `blocked`,
 * this guard returns false so VALIDATION cannot silently auto-advance. The
 * blocked session lands in EvalPending and the explicit reason is surfaced by the
 * consuming rails/tools — guards stay pure booleans and do not fabricate evidence.
 *
 * Uses Set-based lookup for O(n + m) instead of O(n * m) nested iteration.
 */
export const allValidationsPassed: GuardFn = (s) => {
  if (s.activeChecks.length === 0) {
    // Fail-closed under policy: a vacuous pass is not permitted when the
    // validation-evidence authority blocks progression without evidence.
    return !evaluateValidationEvidence(s).blocked;
  }
  const passedIds = new Set<string>();
  for (const v of s.validation) {
    if (v.passed) passedIds.add(v.checkId);
  }
  return s.activeChecks.every((checkId) => passedIds.has(checkId));
};

/** At least one validation check has an explicit failure (passed: false). */
export const checkFailed: GuardFn = (s) => s.validation.some((v) => !v.passed);

/**
 * At least one validation check ERRORED during execution (timeout / command
 * not-found) rather than failing a verdict. Fires CHECK_ERRORED, which keeps the
 * session in VALIDATION for a retry and preserves plan approval — unlike
 * CHECK_FAILED, which routes to PLAN. Evaluated BEFORE checkFailed so a transient
 * execution error is never misread as a deficient plan.
 */
export const checkErrored: GuardFn = (s) => s.validation.some(isTechnicalValidationResult);

/**
 * Post-implementation validation passed (IMPL_VALIDATION phase). Mirrors
 * {@link allValidationsPassed} but reads `implValidation` — the re-run of the
 * active checks against the IMPLEMENTED code. Empty active-check lists defer to the
 * same validation-evidence authority (a detected stack with zero checks is blocked
 * at the pre-impl VALIDATION gate, so IMPL_VALIDATION is reached only when the empty
 * list is a genuine repo property).
 */
export const implValidationPassed: GuardFn = (s) => {
  if (s.activeChecks.length === 0) {
    return !evaluateValidationEvidence(s).blocked;
  }
  return evaluateImplValidationEvidence(s).satisfied;
};

/**
 * A post-implementation check FAILED a verdict (IMPL_VALIDATION). Routes back to
 * IMPLEMENTATION — the delivered code is wrong, not the plan.
 */
export const implCheckFailed: GuardFn = (s) => s.implValidation.some((v) => !v.passed);

/**
 * A post-implementation check ERRORED (timeout / command-not-found). Keeps the
 * session in IMPL_VALIDATION for a retry, mirroring {@link checkErrored}.
 */
export const implCheckErrored: GuardFn = (s) => s.implValidation.some(isTechnicalValidationResult);

/** Implementation evidence is present. */
export const implComplete: GuardFn = (s) => s.implementation !== null;

function decisionBindsFrozenPolicy(
  s: SessionState,
  decision: NonNullable<SessionState['reducedCeremony']>,
): boolean {
  if (s.policySnapshot.allowReducedCeremony !== true) return false;
  if (s.policySnapshot.requireHumanGates !== true) return false;
  return decision.policyDigest === s.policySnapshot.hash;
}

/**
 * Digest-bound ticket declaration of the current session, or null when the
 * ticket is missing, manipulated, contradictory or invalid.
 */
function boundTicketDeclaration(s: SessionState): TicketRiskDeclaration | null {
  const ticket = s.ticket;
  if (ticket === null) return { kind: 'absent' };
  if (!verifyTicketRiskDeclarationIntegrity(ticket)) return null;
  const declaration = ticket.riskDeclaration;
  if (declaration.kind === 'conflict' || declaration.kind === 'invalid') return null;
  return declaration;
}

/**
 * Exact set equality over the unique members. Comparing raw lengths plus
 * membership would accept duplicate substitution (e.g. `['a','a']` against
 * `['a','b']`), which would let a manipulated assessment or decision drop a
 * real surface while keeping the array length.
 */
function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== rightSet.size) return false;
  return [...leftSet].every((entry) => rightSet.has(entry));
}

/**
 * The persisted risk assessment and the decision must both describe the exact
 * frozen implementation. The guard reclassifies `implementation.changedFiles`
 * itself and compares the result with the stored facts, so a schema-valid but
 * manipulated assessment/decision pair cannot waive a HIGH-RISK file list.
 */
type RecomputedRisk = ReturnType<typeof assessMinimumTaskClass>;

/**
 * The persisted assessment must be bound to the SAME verified ticket evidence
 * as the decision: digest, declaration kind and declared floor. A stale
 * assessment from a previous ticket can otherwise authorize a waiver.
 */
function assessmentBindsTicketDeclaration(
  s: SessionState,
  assessment: NonNullable<SessionState['implementationRiskAssessment']>,
  declaration: TicketRiskDeclaration,
): boolean {
  if (assessment.ticketDigest !== (s.ticket?.digest ?? null)) return false;
  if (assessment.declarationKind !== declaration.kind) return false;
  return assessment.declaredTaskClass === ticketRiskDeclarationFloor(declaration);
}

/**
 * Both stored artifacts must describe the same frozen implementation.
 *
 * The caller (`decisionBindsRiskAuthority`) has already established the
 * canonical assessment presence and digest binding; duplicating either check
 * here would be unreachable decision space, not additional protection.
 */
function assessmentMatchesImplementation(
  s: SessionState,
  assessment: NonNullable<SessionState['implementationRiskAssessment']>,
  decision: NonNullable<SessionState['reducedCeremony']>,
  implementation: NonNullable<SessionState['implementation']>,
): boolean {
  if (assessment.assessedFileCount !== implementation.changedFiles.length) return false;
  if (assessment.escalatedTaskClass !== s.claimedTaskClass) return false;
  return decision.escalatedTaskClass === s.claimedTaskClass;
}

function declaredDecisionMatches(
  decision: NonNullable<SessionState['reducedCeremony']>,
  declaration: TicketRiskDeclaration,
  recomputed: RecomputedRisk,
  effective: string,
): boolean {
  return (
    decision.declaredTaskClass === ticketRiskDeclarationFloor(declaration) &&
    decision.computedMinimumTaskClass === recomputed.minimumTaskClass &&
    decision.effectiveTaskClass === effective
  );
}

function decisionMatchesRiskFacts(
  s: SessionState,
  assessment: NonNullable<SessionState['implementationRiskAssessment']>,
  decision: NonNullable<SessionState['reducedCeremony']>,
  declaration: TicketRiskDeclaration,
  implementation: NonNullable<SessionState['implementation']>,
): boolean {
  if (!assessmentMatchesImplementation(s, assessment, decision, implementation)) return false;
  if (!assessmentBindsTicketDeclaration(s, assessment, declaration)) return false;

  const recomputed = assessMinimumTaskClass(implementation.changedFiles);
  if (recomputed.minimumTaskClass !== assessment.computedMinimumTaskClass) return false;
  if (!samePathSet(assessment.touchedSurfaces, recomputed.touchedSurfaces)) return false;
  if (!samePathSet(decision.touchedSurfaces, recomputed.touchedSurfaces)) return false;

  const effective = resolveEffectiveTaskClass({
    computed: recomputed.minimumTaskClass,
    declaration,
    escalated: s.claimedTaskClass,
  });
  if (assessment.effectiveTaskClass !== effective || effective !== 'TRIVIAL') return false;
  if (!reducedCeremonyEligible(implementation.changedFiles)) return false;
  return declaredDecisionMatches(decision, declaration, recomputed, effective);
}

function decisionBindsRiskAuthority(
  s: SessionState,
  decision: NonNullable<SessionState['reducedCeremony']>,
  implementation: NonNullable<SessionState['implementation']>,
): boolean {
  // Canonical assessment presence and digest binding: this is the single
  // authority for these two facts in the guard chain.
  const assessment = s.implementationRiskAssessment;
  if (assessment === null) return false;
  if (assessment.implementationDigest !== implementation.digest) return false;

  const declaration = boundTicketDeclaration(s);
  if (declaration === null) return false;
  if (decision.declarationKind !== declaration.kind) return false;
  if (decision.ticketDigest !== (s.ticket?.digest ?? null)) return false;
  if (!decisionMatchesRiskFacts(s, assessment, decision, declaration, implementation)) {
    return false;
  }
  return s.riskGate?.status !== 'blocked';
}

function ceremonyBindingMatches(
  s: SessionState,
  decision: NonNullable<SessionState['reducedCeremony']>,
): boolean {
  const implementation = s.implementation;
  if (implementation === null) return false;
  if (decision.implementationId !== implementation.implementationId) return false;
  if (decision.implementationDigest !== implementation.digest) return false;
  if (!decisionBindsFrozenPolicy(s, decision)) return false;
  if (!decisionBindsRiskAuthority(s, decision, implementation)) return false;
  return (
    !hasOutstandingReviewObligation(s.reviewAssurance) &&
    !hasUnresolvedIntegrityIncident(s.reviewAssurance)
  );
}

function ceremonyBasisMatches(
  decision: NonNullable<SessionState['reducedCeremony']>,
  evidence: ReturnType<typeof evaluateImplValidationEvidence>,
): boolean {
  const decidedCheckIds = [...decision.verificationBasis.checkIds].sort();
  const activeCheckIds = [...evidence.activeChecks].sort();
  if (decidedCheckIds.length !== activeCheckIds.length) return false;
  if (decidedCheckIds.some((checkId, index) => checkId !== activeCheckIds[index])) return false;

  // Full binding equality: check, attempt id AND the recorded execution time.
  const decidedAttempts = decision.verificationBasis.attempts
    .map((entry) => `${entry.checkId}:${entry.attemptId}:${entry.executedAt}`)
    .sort();
  const currentAttempts = evidence.basis
    .map((entry) => `${entry.checkId}:${entry.attemptId}:${entry.executedAt}`)
    .sort();
  if (decidedAttempts.length !== currentAttempts.length) return false;
  return decidedAttempts.every((entry, index) => entry === currentAttempts[index]);
}

/**
 * Implementation evidence has a reduced-ceremony decision that is fully bound
 * to the current implementation generation, the frozen policy and the canonical
 * post-implementation evidence. A decision by itself is never transition
 * authority.
 */
export const reducedCeremonyReady: GuardFn = (s) => {
  const decision = s.reducedCeremony;
  if (decision === null || !ceremonyBindingMatches(s, decision)) return false;
  const evidence = evaluateImplValidationEvidence(s);
  if (!evidence.satisfied) return false;
  // Surface equality between decision and assessment is implied by
  // `decisionMatchesRiskFacts`, which binds both arrays to the same
  // freshly recomputed surface set; no separate comparison is needed.
  return ceremonyBasisMatches(decision, evidence);
};

export const implReviewMet: GuardFn = (s) => {
  if (s.implReview === null) return false;
  return isConverged(s.implReview);
};

/** Implementation review loop still iterating. */
export const implReviewPending: GuardFn = (s) => s.implReview !== null && !implReviewMet(s);

/** Review report has been generated (review flow completion). */
export const reviewDone: GuardFn = (s) => s.reviewReportPath !== null;

// ─── Guard Table ──────────────────────────────────────────────────────────────

/**
 * For each guard-based phase: an ordered list of guard entries.
 *
 * Evaluation algorithm:
 *   for (entry of GUARDS.get(phase))
 *     if (entry.guard(state)) → fire entry.event
 *   // no match → a normal pending state (no guard fired)
 *
 * ERROR is always first — fail-closed by design.
 * A fired guard whose event has no topology edge becomes `{ kind: 'pending' }`
 * with a TOPOLOGY_GAP diagnostic. A guard list without a match is likewise a
 * normal pending state — there is no implicit fallback guard.
 *
 * Phases NOT in this table:
 * - READY: command-driven (no guards)
 * - PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW: user gates
 * - COMPLETE, ARCH_COMPLETE, PEER_REVIEW_COMPLETE, REJECTED, ABORTED: terminal
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
      { event: 'CHECK_ERRORED', guard: checkErrored },
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
    'IMPL_VALIDATION',
    [
      { event: 'ERROR', guard: hasError },
      { event: 'CHECK_ERRORED', guard: implCheckErrored },
      { event: 'REDUCED_CEREMONY', guard: reducedCeremonyReady },
      { event: 'ALL_PASSED', guard: implValidationPassed },
      { event: 'CHECK_FAILED', guard: implCheckFailed },
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

  // PEER_REVIEW: auto-advances to PEER_REVIEW_COMPLETE after report generation.
  // The reviewDone guard fires immediately (the rail sets phase to PEER_REVIEW
  // after generating the report, then autoAdvance fires this guard).
  [
    'PEER_REVIEW',
    [
      { event: 'ERROR', guard: hasError },
      { event: 'PEER_REVIEW_DONE', guard: reviewDone },
    ],
  ],
]);
