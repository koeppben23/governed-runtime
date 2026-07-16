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

import { z } from 'zod';
import { compareActorIdentity } from '../identity/actor-info.js';
import type { ActorIdentityComparison } from '../identity/actor-info.js';
import { evaluateValidationEvidence } from '../machine/validation-evidence.js';
import type { SessionState, Phase } from '../state/schema.js';

// ─── Zod Schemas for ReviewReport ────────────────────────────────────

export const EvidenceSlotStatusSchema = z.object({
  slot: z.string(),
  label: z.string(),
  required: z.boolean(),
  present: z.boolean(),
  status: z.enum(['complete', 'missing', 'not_yet_required', 'failed']),
  detail: z.string().optional(),
  artifactKind: z.string().optional(),
});

export const FourEyesStatusSchema = z.object({
  required: z.boolean(),
  satisfied: z.boolean(),
  initiatedBy: z.string(),
  decidedBy: z.string().nullable(),
  detail: z.string(),
});

export const CompletenessSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  complete: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  notYetRequired: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const CompletenessReportSchema = z.object({
  sessionId: z.string().uuid(),
  phase: z.string(),
  policyMode: z.string(),
  overallComplete: z.boolean(),
  slots: z.array(EvidenceSlotStatusSchema),
  fourEyes: FourEyesStatusSchema,
  summary: CompletenessSummarySchema,
});

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
  /** Canonical artifact kind for this slot, when applicable. */
  readonly artifactKind?: string;
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
  readonly slots: EvidenceSlotStatus[];
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
  IMPL_VALIDATION: 5,
  IMPL_REVIEW: 6,
  EVIDENCE_REVIEW: 7,
  COMPLETE: 8,
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
  implementation: 5, // IMPL_VALIDATION
  implValidation: 6, // IMPL_REVIEW
  implReview: 7, // EVIDENCE_REVIEW
  evidenceReviewDecision: 8, // COMPLETE
};

/** All evidence slots in evidence-chain order. */
const ALL_SLOTS = [
  'ticket',
  'plan',
  'selfReview',
  'planReviewDecision',
  'validation',
  'implementation',
  'implValidation',
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
  implValidation: 'Post-Implementation Validation',
  implReview: 'Implementation Review',
  evidenceReviewDecision: 'Evidence Review Decision',
};

/** Canonical artifact kind mapping per slot (single authority for projections). */
const SLOT_ARTIFACT_KIND: Readonly<Record<string, string>> = {
  ticket: 'ticket_evidence',
  plan: 'plan_record',
  selfReview: 'self_review_loop',
  planReviewDecision: 'review_decision',
  validation: 'validation_results',
  implementation: 'implementation_evidence',
  implValidation: 'implementation_validation_results',
  implReview: 'implementation_review',
  evidenceReviewDecision: 'review_decision',
  architecture: 'architecture_decision',
  archReviewDecision: 'review_decision',
};

// ─── Slot Evaluation ──────────────────────────────────────────────────────────

/**
 * Whether validation-like evidence is complete for a set of results.
 *
 * For zero active checks, the validation-evidence authority decides whether
 * vacuous advancement is admissible. This keeps audit completeness aligned
 * with machine guards without reimplementing policy semantics.
 */
function checksComplete(
  state: SessionState,
  results: ReadonlyArray<{ checkId: string; passed: boolean }>,
): boolean {
  if (state.activeChecks.length === 0) {
    return !evaluateValidationEvidence(state).blocked;
  }
  return state.activeChecks.every((id) => results.some((v) => v.checkId === id && v.passed));
}

/**
 * Check if an evidence slot has valid data present in state.
 *
 * Special cases:
 * - planReviewDecision: verified by topology invariant (phase >= VALIDATION)
 * - validation: checksComplete - policy-admissible zero checks, or all active checks passed
 * - implValidation: checksComplete - same semantics, separate post-implementation slot
 * - evidenceReviewDecision: COMPLETE phase with no error
 */
const SLOT_PRESENT_CHECKS: Record<string, (state: SessionState, phaseOrd: number) => boolean> = {
  ticket: (s) => s.ticket !== null,
  architecture: (s) => s.architecture !== null,
  plan: (s) => s.plan !== null,
  selfReview: (s) => s.selfReview !== null,
  planReviewDecision: (_s, phaseOrd) => phaseOrd >= PHASE_ORDER['VALIDATION'],
  validation: (s) => checksComplete(s, s.validation),
  implementation: (s) => s.implementation !== null,
  implValidation: (s) => checksComplete(s, s.implValidation),
  implReview: (s) => s.implReview !== null,
  evidenceReviewDecision: (s) => s.phase === 'COMPLETE' && s.error === null,
  archReviewDecision: (s) => s.phase === 'ARCH_COMPLETE' && s.error === null,
};

function isSlotPresent(state: SessionState, slot: string): boolean {
  const phaseOrd = PHASE_ORDER[state.phase];
  const fn = SLOT_PRESENT_CHECKS[slot];
  return fn ? fn(state, phaseOrd) : false;
}

/**
 * Check if an evidence slot has failed (present but invalid).
 * Currently only applies to validation (some checks failed).
 */
function isSlotFailed(state: SessionState, slot: string): boolean {
  if (slot === 'validation') {
    return state.validation.length > 0 && state.validation.some((v) => !v.passed);
  }
  if (slot === 'implValidation') {
    return state.implValidation.length > 0 && state.implValidation.some((v) => !v.passed);
  }
  return false;
}

const SLOT_DETAIL_FNS: Record<
  string,
  (state: SessionState, phaseOrd: number) => string | undefined
> = {
  ticket: (s) =>
    s.ticket ? `source: ${s.ticket.source}, digest: ${s.ticket.digest.slice(0, 12)}...` : undefined,
  architecture: (s) =>
    s.architecture
      ? `${s.architecture.id}: ${s.architecture.title}, status: ${s.architecture.status}`
      : undefined,
  plan: (s) =>
    s.plan
      ? `v${s.plan.history.length + 1}, digest: ${s.plan.current.digest.slice(0, 12)}...`
      : undefined,
  selfReview: (s) =>
    s.selfReview
      ? `iteration ${s.selfReview.iteration}/${s.selfReview.maxIterations}, verdict: ${s.selfReview.verdict}`
      : undefined,
  planReviewDecision: (_s, phaseOrd) =>
    phaseOrd >= PHASE_ORDER['VALIDATION'] ? 'Approved (verified by topology invariant)' : undefined,
  validation: (s) => {
    if (s.validation.length === 0) return undefined;
    const passed = s.validation.filter((v) => v.passed).length;
    const total = s.validation.length;
    const failedIds = s.validation.filter((v) => !v.passed).map((v) => v.checkId);
    return failedIds.length > 0
      ? `${passed}/${total} passed, failed: ${failedIds.join(', ')}`
      : `${passed}/${total} passed`;
  },
  implValidation: (s) => {
    if (s.implValidation.length === 0) return undefined;
    const passed = s.implValidation.filter((v) => v.passed).length;
    const total = s.implValidation.length;
    const failedIds = s.implValidation.filter((v) => !v.passed).map((v) => v.checkId);
    return failedIds.length > 0
      ? `post-impl ${passed}/${total} passed, failed: ${failedIds.join(', ')}`
      : `post-impl ${passed}/${total} passed`;
  },
  implementation: (s) =>
    s.implementation
      ? `${s.implementation.changedFiles.length} files changed, digest: ${s.implementation.digest.slice(0, 12)}...`
      : undefined,
  implReview: (s) =>
    s.implReview
      ? `iteration ${s.implReview.iteration}/${s.implReview.maxIterations}, verdict: ${s.implReview.verdict}`
      : undefined,
  evidenceReviewDecision: (s) =>
    s.phase === 'COMPLETE' && s.error === null
      ? 'Approved (verified by topology invariant)'
      : s.error
        ? `Session has error: ${s.error.code}`
        : undefined,
  archReviewDecision: (s) =>
    s.phase === 'ARCH_COMPLETE' && s.error === null
      ? 'Approved (verified by topology invariant)'
      : undefined,
};

/** Get a human-readable detail string for a slot. */
function getSlotDetail(state: SessionState, slot: string): string | undefined {
  const phaseOrd = PHASE_ORDER[state.phase];
  const fn = SLOT_DETAIL_FNS[slot];
  return fn ? fn(state, phaseOrd) : undefined;
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
function determineSlotStatus(
  isRequired: boolean,
  failed: boolean,
  present: boolean,
): EvidenceSlotStatus['status'] {
  if (!isRequired) return 'not_yet_required';
  if (failed) return 'failed';
  if (present) return 'complete';
  return 'missing';
}

function buildSlotEntry(
  state: SessionState,
  slot: string,
  isRequired: boolean,
  label: string,
): EvidenceSlotStatus {
  return {
    slot,
    label,
    required: isRequired,
    present: isSlotPresent(state, slot),
    status: determineSlotStatus(isRequired, isSlotFailed(state, slot), isSlotPresent(state, slot)),
    detail: getSlotDetail(state, slot),
    artifactKind: SLOT_ARTIFACT_KIND[slot],
  };
}

function compareReviewActors(
  state: SessionState,
  decidedBy: string | null,
): ActorIdentityComparison {
  if (decidedBy === null) return 'uncomparable';
  const initiatorIdentity = state.initiatedByIdentity ?? { actorId: state.initiatedBy };
  const reviewerIdentity =
    state.reviewDecision?.decisionIdentity ?? (decidedBy !== null ? { actorId: decidedBy } : null);
  return compareActorIdentity(initiatorIdentity, reviewerIdentity);
}

function getFourEyesDetail(
  state: SessionState,
  decidedBy: string | null,
  actorComparison: ActorIdentityComparison,
  fourEyesRequired: boolean,
): string {
  if (!fourEyesRequired) return 'Four-eyes not required by policy';
  if (decidedBy === null) return 'Four-eyes pending: no review decision recorded yet';
  if (actorComparison === 'different')
    return `Four-eyes satisfied: initiator=${state.initiatedBy}, reviewer=${decidedBy}`;
  if (actorComparison === 'uncomparable')
    return 'Four-eyes pending: initiator and reviewer identities are not comparable';
  return `Four-eyes VIOLATED: initiator and reviewer are the same person (${state.initiatedBy})`;
}

function evaluateFourEyes(state: SessionState): FourEyesStatus {
  const fourEyesRequired = state.policySnapshot?.allowSelfApproval === false;
  const decidedBy = state.reviewDecision?.decidedBy ?? null;
  const actorComparison = compareReviewActors(state, decidedBy);
  const fourEyesSatisfied = !fourEyesRequired || actorComparison === 'different';
  return {
    required: fourEyesRequired,
    satisfied: fourEyesSatisfied,
    initiatedBy: state.initiatedBy,
    decidedBy,
    detail: getFourEyesDetail(state, decidedBy, actorComparison, fourEyesRequired),
  };
}

export function evaluateCompleteness(state: SessionState): CompletenessReport {
  const isArchFlow = ARCHITECTURE_FLOW_PHASES.has(state.phase);
  const isReviewFlow = REVIEW_FLOW_PHASES.has(state.phase);
  let slots: EvidenceSlotStatus[];

  if (isArchFlow) {
    const currentOrd = ARCH_PHASE_ORDER[state.phase] ?? -1;
    slots = ARCH_SLOTS.map((slot) =>
      buildSlotEntry(
        state,
        slot,
        currentOrd >= (ARCH_SLOT_REQUIRED_FROM[slot] ?? 99),
        ARCH_SLOT_LABELS[slot] ?? slot,
      ),
    );
  } else if (isReviewFlow) {
    slots = [];
  } else {
    const currentPhaseOrd = PHASE_ORDER[state.phase];
    slots = ALL_SLOTS.map((slot) =>
      buildSlotEntry(
        state,
        slot,
        currentPhaseOrd >= (SLOT_REQUIRED_FROM[slot] ?? 99),
        SLOT_LABELS[slot] ?? slot,
      ),
    );
  }

  const fourEyes = evaluateFourEyes(state);
  const complete = slots.filter((s) => s.status === 'complete').length;
  const missing = slots.filter((s) => s.status === 'missing').length;
  const notYetRequired = slots.filter((s) => s.status === 'not_yet_required').length;
  const failed = slots.filter((s) => s.status === 'failed').length;
  const overallComplete =
    missing === 0 && failed === 0 && fourEyes.satisfied && state.phase !== 'READY';

  return {
    sessionId: state.id,
    phase: state.phase,
    policyMode: state.policySnapshot?.mode ?? 'unknown',
    overallComplete,
    slots,
    fourEyes,
    summary: { total: ALL_SLOTS.length, complete, missing, notYetRequired, failed },
  };
}
