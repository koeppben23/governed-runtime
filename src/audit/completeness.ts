/**
 * @module audit/completeness
 * @description Evidence Completeness Matrix — automated compliance check.
 *
 * Evaluates the completeness of a FlowGuard session's evidence chain.
 * For each evidence slot: is it present, missing, failed, or not yet required?
 *
 * Also evaluates the four-eyes principle:
 * - Is it required by policy?
 * - Is it satisfied (initiator ≠ reviewer)?
 *
 * The completeness report is the core deliverable for auditors:
 * "Is the evidence chain complete for this AI-assisted change?"
 *
 * Three flows have different completeness requirements:
 *
 * Ticket flow (full lifecycle):
 * | Slot                    | Required from phase    | How to verify             |
 * |-------------------------|------------------------|---------------------------|
 * | ticket                  | TICKET (always)        | state.ticket !== null     |
 * | plan                    | PLAN                   | state.plan !== null       |
 * | selfReview              | PLAN_REVIEW            | state.selfReview !== null |
 * | planReviewDecision      | VALIDATION             | topology guarantee        |
 * | validation              | IMPLEMENTATION         | all checks passed         |
 * | implementation          | IMPL_REVIEW            | state.impl !== null       |
 * | implReview              | EVIDENCE_REVIEW        | state.implReview !== null |
 * | evidenceReviewDecision  | COMPLETE               | COMPLETE + no error       |
 *
 * Architecture flow:
 * | Slot                    | Required from phase    | How to verify             |
 * |-------------------------|------------------------|---------------------------|
 * | architecture            | ARCHITECTURE           | state.architecture != null|
 * | selfReview              | ARCH_REVIEW            | state.selfReview !== null |
 * | archReviewDecision      | ARCH_COMPLETE          | topology guarantee        |
 *
 * Review flow:
 * No evidence slots required — the review report is a standalone artifact.
 *
 * @version v2
 */

import type { SessionState, Phase } from '../state/schema.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Status of a single evidence slot. */
export interface EvidenceSlotStatus {
  /** Slot identifier (e.g., "ticket", "plan", "validation"). */
  readonly slot: string;
  /** Human-readable label. */
  readonly label: string;
  /** Whether this slot is required at the current phase. */
  readonly required: boolean;
  /** Whether evidence is present in the state. */
  readonly present: boolean;
  /** Evaluated status. */
  readonly status: 'complete' | 'missing' | 'not_yet_required' | 'failed';
  /** Optional detail (digest, iteration count, etc.). */
  readonly detail?: string;
}

/** Four-eyes principle compliance status. */
export interface FourEyesStatus {
  /** Whether four-eyes is required by the session's policy. */
  readonly required: boolean;
  /** Whether four-eyes is satisfied (initiator ≠ reviewer). */
  readonly satisfied: boolean;
  /** Identity of the session initiator (author). */
  readonly initiatedBy: string;
  /** Identity of the reviewer, if a review decision exists. */
  readonly decidedBy: string | null;
  /** Human-readable explanation. */
  readonly detail: string;
}

/** Summary counts for the completeness report. */
export interface CompletenessSummary {
  readonly total: number;
  readonly complete: number;
  readonly missing: number;
  readonly notYetRequired: number;
  readonly failed: number;
}

/** Full evidence completeness report. */
export interface CompletenessReport {
  readonly sessionId: string;
  readonly phase: Phase;
  readonly policyMode: string;
  /**
   * Overall completeness: true only if all required slots are complete,
   * no slots have failed, and four-eyes is satisfied (if required).
   */
  readonly overallComplete: boolean;
  readonly slots: readonly EvidenceSlotStatus[];
  readonly fourEyes: FourEyesStatus;
  readonly summary: CompletenessSummary;
}

// ─── Phase Ordering ───────────────────────────────────────────────────────────

/**
 * Ordinal position of each phase within its flow.
 * Used to determine which evidence slots are required at a given phase.
 *
 * Three flows with independent ordinal sequences:
 * - Ticket flow: READY(0) → TICKET(1) → PLAN(2) → ... → COMPLETE(9)
 * - Architecture flow: READY(0) → ARCHITECTURE(1) → ARCH_REVIEW(2) → ARCH_COMPLETE(3)
 * - Review flow: READY(0) → REVIEW(1) → REVIEW_COMPLETE(2)
 *
 * Ticket flow ordinals are used as the primary sequence (backward-compatible).
 * Architecture and review flow phases use negative ordinals (-1) for ticket-flow
 * slot requirements — they are never "required" for those flows.
 */
const PHASE_ORDER: Readonly<Record<Phase, number>> = {
  READY: -1,
  TICKET: 0,
  PLAN: 1,
  PLAN_REVIEW: 2,
  VALIDATION: 3,
  IMPLEMENTATION: 4,
  IMPL_REVIEW: 5,
  EVIDENCE_REVIEW: 6,
  COMPLETE: 7,
  ARCHITECTURE: -1,
  ARCH_REVIEW: -1,
  ARCH_COMPLETE: -1,
  REVIEW: -1,
  REVIEW_COMPLETE: -1,
};

/**
 * Phase ordinal at which each evidence slot becomes required.
 * A slot is "required" if the current phase ordinal >= this value.
 * Below this ordinal, the slot is "not_yet_required".
 */
const SLOT_REQUIRED_FROM: Readonly<Record<string, number>> = {
  ticket: 0, // TICKET (always required)
  plan: 1, // PLAN
  selfReview: 2, // PLAN_REVIEW
  planReviewDecision: 3, // VALIDATION
  validation: 4, // IMPLEMENTATION
  implementation: 5, // IMPL_REVIEW
  implReview: 6, // EVIDENCE_REVIEW
  evidenceReviewDecision: 7, // COMPLETE
};

/** All evidence slots in evidence-chain order. */
const ALL_SLOTS = [
  'ticket',
  'plan',
  'selfReview',
  'planReviewDecision',
  'validation',
  'implementation',
  'implReview',
  'evidenceReviewDecision',
] as const;

/** Human-readable labels for each slot. */
const SLOT_LABELS: Readonly<Record<string, string>> = {
  ticket: 'Ticket Evidence',
  plan: 'Plan Evidence',
  selfReview: 'Plan Self-Review',
  planReviewDecision: 'Plan Review Decision',
  validation: 'Validation Results',
  implementation: 'Implementation Evidence',
  implReview: 'Implementation Review',
  evidenceReviewDecision: 'Evidence Review Decision',
};

// ─── Slot Evaluation ──────────────────────────────────────────────────────────

/**
 * Check if an evidence slot has valid data present in state.
 *
 * Special cases:
 * - planReviewDecision: verified by topology invariant (phase >= VALIDATION)
 * - validation: all active checks must pass (not just "some results exist")
 * - evidenceReviewDecision: COMPLETE phase with no error
 */
function isSlotPresent(state: SessionState, slot: string): boolean {
  const phaseOrd = PHASE_ORDER[state.phase];

  switch (slot) {
    case 'ticket':
      return state.ticket !== null;
    case 'architecture':
      return state.architecture !== null;
    case 'plan':
      return state.plan !== null;
    case 'selfReview':
      return state.selfReview !== null;
    case 'planReviewDecision':
      // Topology invariant: if we reached VALIDATION or beyond,
      // PLAN_REVIEW was passed with APPROVE. No other path exists.
      return phaseOrd >= PHASE_ORDER['VALIDATION'];
    case 'validation':
      return (
        state.validation.length > 0 &&
        state.activeChecks.length > 0 &&
        state.activeChecks.every((id) => state.validation.some((v) => v.checkId === id && v.passed))
      );
    case 'implementation':
      return state.implementation !== null;
    case 'implReview':
      return state.implReview !== null;
    case 'evidenceReviewDecision':
      // Topology invariant: COMPLETE with no error means EVIDENCE_REVIEW → APPROVE.
      return state.phase === 'COMPLETE' && state.error === null;
    case 'archReviewDecision':
      // Topology invariant: ARCH_COMPLETE means ARCH_REVIEW → APPROVE.
      return state.phase === 'ARCH_COMPLETE' && state.error === null;
    default:
      return false;
  }
}

/**
 * Check if an evidence slot has failed (present but invalid).
 * Currently only applies to validation (some checks failed).
 */
function isSlotFailed(state: SessionState, slot: string): boolean {
  if (slot === 'validation') {
    return state.validation.length > 0 && state.validation.some((v) => !v.passed);
  }
  return false;
}

/** Get a human-readable detail string for a slot. */
function getSlotDetail(state: SessionState, slot: string): string | undefined {
  switch (slot) {
    case 'ticket':
      return state.ticket
        ? `source: ${state.ticket.source}, digest: ${state.ticket.digest.slice(0, 12)}...`
        : undefined;
    case 'architecture':
      return state.architecture
        ? `${state.architecture.id}: ${state.architecture.title}, status: ${state.architecture.status}`
        : undefined;
    case 'plan':
      return state.plan
        ? `v${state.plan.history.length + 1}, digest: ${state.plan.current.digest.slice(0, 12)}...`
        : undefined;
    case 'selfReview':
      return state.selfReview
        ? `iteration ${state.selfReview.iteration}/${state.selfReview.maxIterations}, verdict: ${state.selfReview.verdict}`
        : undefined;
    case 'planReviewDecision': {
      const phaseOrd = PHASE_ORDER[state.phase];
      return phaseOrd >= PHASE_ORDER['VALIDATION']
        ? 'Approved (verified by topology invariant)'
        : undefined;
    }
    case 'validation': {
      if (state.validation.length === 0) return undefined;
      const passed = state.validation.filter((v) => v.passed).length;
      const total = state.validation.length;
      const failedIds = state.validation.filter((v) => !v.passed).map((v) => v.checkId);
      return failedIds.length > 0
        ? `${passed}/${total} passed, failed: ${failedIds.join(', ')}`
        : `${passed}/${total} passed`;
    }
    case 'implementation':
      return state.implementation
        ? `${state.implementation.changedFiles.length} files changed, digest: ${state.implementation.digest.slice(0, 12)}...`
        : undefined;
    case 'implReview':
      return state.implReview
        ? `iteration ${state.implReview.iteration}/${state.implReview.maxIterations}, verdict: ${state.implReview.verdict}`
        : undefined;
    case 'evidenceReviewDecision':
      return state.phase === 'COMPLETE' && state.error === null
        ? 'Approved (verified by topology invariant)'
        : state.error
          ? `Session has error: ${state.error.code}`
          : undefined;
    case 'archReviewDecision':
      return state.phase === 'ARCH_COMPLETE' && state.error === null
        ? 'Approved (verified by topology invariant)'
        : undefined;
    default:
      return undefined;
  }
}

// ─── Flow Detection ───────────────────────────────────────────────────────────

/** Architecture flow phases. */
const ARCHITECTURE_FLOW_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'ARCHITECTURE',
  'ARCH_REVIEW',
  'ARCH_COMPLETE',
]);

/** Review flow phases. */
const REVIEW_FLOW_PHASES: ReadonlySet<Phase> = new Set<Phase>(['REVIEW', 'REVIEW_COMPLETE']);

/** Architecture flow ordinals (independent from ticket flow). */
const ARCH_PHASE_ORDER: Readonly<Record<string, number>> = {
  ARCHITECTURE: 0,
  ARCH_REVIEW: 1,
  ARCH_COMPLETE: 2,
};

/** Architecture flow evidence slots. */
const ARCH_SLOTS = ['architecture', 'selfReview', 'archReviewDecision'] as const;

const ARCH_SLOT_REQUIRED_FROM: Readonly<Record<string, number>> = {
  architecture: 0, // ARCHITECTURE
  selfReview: 1, // ARCH_REVIEW
  archReviewDecision: 2, // ARCH_COMPLETE
};

const ARCH_SLOT_LABELS: Readonly<Record<string, string>> = {
  architecture: 'Architecture Decision Record',
  selfReview: 'ADR Self-Review',
  archReviewDecision: 'Architecture Review Decision',
};

// ─── Evaluator ────────────────────────────────────────────────────────────────

/**
 * Evaluate evidence completeness for a FlowGuard session.
 *
 * Returns a structured report showing:
 * - Per-slot status (complete / missing / not_yet_required / failed)
 * - Four-eyes principle compliance
 * - Overall completeness assessment
 * - Summary counts
 *
 * Flow-aware: evaluates different slots depending on the active flow
 * (ticket, architecture, or review).
 *
 * @param state - Current session state.
 * @returns Structured completeness report.
 */
export function evaluateCompleteness(state: SessionState): CompletenessReport {
  // Determine which flow we're in and get appropriate slots
  const isArchFlow = ARCHITECTURE_FLOW_PHASES.has(state.phase);
  const isReviewFlow = REVIEW_FLOW_PHASES.has(state.phase);

  let slots: EvidenceSlotStatus[];

  if (isArchFlow) {
    // Architecture flow: evaluate architecture-specific slots
    const currentOrd = ARCH_PHASE_ORDER[state.phase] ?? -1;
    slots = ARCH_SLOTS.map((slot) => {
      const requiredFromOrd = ARCH_SLOT_REQUIRED_FROM[slot] ?? 99;
      const isRequired = currentOrd >= requiredFromOrd;
      const present = isSlotPresent(state, slot);
      const failed = isSlotFailed(state, slot);

      let status: EvidenceSlotStatus['status'];
      if (!isRequired) {
        status = 'not_yet_required';
      } else if (failed) {
        status = 'failed';
      } else if (present) {
        status = 'complete';
      } else {
        status = 'missing';
      }

      return {
        slot,
        label: ARCH_SLOT_LABELS[slot] ?? slot,
        required: isRequired,
        present,
        status,
        detail: getSlotDetail(state, slot),
      };
    });
  } else if (isReviewFlow) {
    // Review flow: no evidence slots required (report is standalone artifact)
    slots = [];
  } else {
    // Ticket flow (including READY): evaluate standard slots
    const currentPhaseOrd = PHASE_ORDER[state.phase];
    slots = ALL_SLOTS.map((slot) => {
      const requiredFromOrd = SLOT_REQUIRED_FROM[slot] ?? 99;
      const isRequired = currentPhaseOrd >= requiredFromOrd;
      const present = isSlotPresent(state, slot);
      const failed = isSlotFailed(state, slot);

      let status: EvidenceSlotStatus['status'];
      if (!isRequired) {
        status = 'not_yet_required';
      } else if (failed) {
        status = 'failed';
      } else if (present) {
        status = 'complete';
      } else {
        status = 'missing';
      }

      return {
        slot,
        label: SLOT_LABELS[slot] ?? slot,
        required: isRequired,
        present,
        status,
        detail: getSlotDetail(state, slot),
      };
    });
  }

  // ── Evaluate four-eyes principle ───────────────────────────
  const fourEyesRequired = state.policySnapshot?.allowSelfApproval === false;
  const decidedBy = state.reviewDecision?.decidedBy ?? null;
  const fourEyesSatisfied =
    !fourEyesRequired || (decidedBy !== null && decidedBy !== state.initiatedBy);

  let fourEyesDetail: string;
  if (!fourEyesRequired) {
    fourEyesDetail = 'Four-eyes not required by policy';
  } else if (decidedBy === null) {
    fourEyesDetail = 'Four-eyes pending: no review decision recorded yet';
  } else if (fourEyesSatisfied) {
    fourEyesDetail = `Four-eyes satisfied: initiator=${state.initiatedBy}, reviewer=${decidedBy}`;
  } else {
    fourEyesDetail = `Four-eyes VIOLATED: initiator and reviewer are the same person (${state.initiatedBy})`;
  }

  const fourEyes: FourEyesStatus = {
    required: fourEyesRequired,
    satisfied: fourEyesSatisfied,
    initiatedBy: state.initiatedBy,
    decidedBy,
    detail: fourEyesDetail,
  };

  // ── Summary counts ─────────────────────────────────────────
  const complete = slots.filter((s) => s.status === 'complete').length;
  const missing = slots.filter((s) => s.status === 'missing').length;
  const notYetRequired = slots.filter((s) => s.status === 'not_yet_required').length;
  const failed = slots.filter((s) => s.status === 'failed').length;

  const overallComplete =
    missing === 0 &&
    failed === 0 &&
    fourEyesSatisfied &&
    // READY is the routing phase — no flow selected, so never "complete"
    state.phase !== 'READY';

  return {
    sessionId: state.id,
    phase: state.phase,
    policyMode: state.policySnapshot?.mode ?? 'unknown',
    overallComplete,
    slots,
    fourEyes,
    summary: {
      total: ALL_SLOTS.length,
      complete,
      missing,
      notYetRequired,
      failed,
    },
  };
}
