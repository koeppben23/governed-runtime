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
 * | implementation          | IMPL_VALIDATION        | state.impl !== null       |
 * | implValidation          | IMPL_REVIEW            | post-fix checks passed    |
 * | implReview              | EVIDENCE_REVIEW        | state.implReview !== null |
 * | evidenceReviewDecision  | EXPORT_READY           | EXPORT_READY/COMPLETE + no error |
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
 * Completeness is nevertheless false until the flow reaches PEER_REVIEW_COMPLETE.
 *
 * @version v2
 */

import { z } from 'zod';
import { compareActorIdentity } from '../identity/actor-info.js';
import type { ActorIdentityComparison } from '../identity/actor-info.js';
import {
  FLOW_PHASES,
  isFlowPhase,
  isFlowPhaseAtOrAfter,
  isTerminalPhase,
} from '../machine/topology.js';
import { evaluateValidationEvidence } from '../machine/validation-evidence.js';
import type { SessionState, Phase } from '../state/schema.js';
import { DecisionIdentity } from '../state/evidence-identity.js';

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
  decisionIdentity: DecisionIdentity.nullable(),
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

export interface EvidenceSlotStatus {
  readonly slot: string;
  readonly label: string;
  readonly required: boolean;
  readonly present: boolean;
  readonly status: 'complete' | 'missing' | 'not_yet_required' | 'failed';
  readonly detail?: string;
  readonly artifactKind?: string;
}

export interface FourEyesStatus {
  readonly required: boolean;
  readonly satisfied: boolean;
  readonly initiatedBy: string;
  readonly decisionIdentity: DecisionIdentity | null;
  readonly detail: string;
}

export interface CompletenessSummary {
  readonly total: number;
  readonly complete: number;
  readonly missing: number;
  readonly notYetRequired: number;
  readonly failed: number;
}

export interface CompletenessReport {
  readonly sessionId: string;
  readonly phase: Phase;
  readonly policyMode: string;
  readonly overallComplete: boolean;
  readonly slots: EvidenceSlotStatus[];
  readonly fourEyes: FourEyesStatus;
  readonly summary: CompletenessSummary;
}

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

type TicketSlot = (typeof ALL_SLOTS)[number];
type TicketFlowPhase = (typeof FLOW_PHASES.ticket)[number];

/**
 * Milestone at which each ticket slot becomes required. The phase ORDER itself
 * is owned solely by `machine/topology.ts`; this map owns only the domain fact
 * "which milestone makes this slot mandatory".
 */
const SLOT_REQUIRED_FROM = {
  ticket: 'TICKET',
  plan: 'PLAN',
  selfReview: 'PLAN_REVIEW',
  planReviewDecision: 'VALIDATION',
  validation: 'IMPLEMENTATION',
  implementation: 'IMPL_VALIDATION',
  implValidation: 'IMPL_REVIEW',
  implReview: 'EVIDENCE_REVIEW',
  evidenceReviewDecision: 'EXPORT_READY',
} satisfies Record<TicketSlot, TicketFlowPhase>;

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

function checksComplete(
  state: SessionState,
  results: ReadonlyArray<{ checkId: string; passed: boolean }>,
): boolean {
  if (state.activeChecks.length === 0) return !evaluateValidationEvidence(state).blocked;
  return state.activeChecks.every((id) => results.some((v) => v.checkId === id && v.passed));
}

const SLOT_PRESENT_CHECKS: Record<string, (state: SessionState, phase: Phase) => boolean> = {
  ticket: (s) => s.ticket !== null,
  architecture: (s) => s.architecture !== null,
  plan: (s) => s.plan !== null,
  selfReview: (s) => s.selfReview !== null,
  planReviewDecision: (_s, phase) => isFlowPhaseAtOrAfter('ticket', phase, 'VALIDATION'),
  validation: (s) => checksComplete(s, s.validation),
  implementation: (s) => s.implementation !== null,
  implValidation: (s) => checksComplete(s, s.implValidation),
  implReview: (s) => s.implReview !== null,
  // The final human approval is recorded when the gate transitions to
  // EXPORT_READY; completion (`/export`) adds the export evidence, not the
  // decision. The slot is required from EXPORT_READY (SLOT_REQUIRED_FROM), so
  // its presence must be recognized from EXPORT_READY too.
  evidenceReviewDecision: (s) =>
    (s.phase === 'COMPLETE' || s.phase === 'EXPORT_READY') && s.error === null,
  archReviewDecision: (s) => s.phase === 'ARCH_COMPLETE' && s.error === null,
};

function isSlotPresent(state: SessionState, slot: string): boolean {
  const fn = SLOT_PRESENT_CHECKS[slot];
  return fn ? fn(state, state.phase) : false;
}

function isSlotFailed(state: SessionState, slot: string): boolean {
  if (slot === 'validation')
    return state.validation.length > 0 && state.validation.some((v) => !v.passed);
  if (slot === 'implValidation')
    return state.implValidation.length > 0 && state.implValidation.some((v) => !v.passed);
  return false;
}

const SLOT_DETAIL_FNS: Record<string, (state: SessionState, phase: Phase) => string | undefined> = {
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
      ? `iteration ${s.selfReview.iteration}/${s.selfReview.maxIterations}, verdict: ${s.selfReview.verdict}` +
        (s.architecture ? `, completion: ${s.architecture.reviewCompletion}` : '')
      : undefined,
  planReviewDecision: (_s, phase) =>
    isFlowPhaseAtOrAfter('ticket', phase, 'VALIDATION')
      ? 'Approved (verified by topology invariant)'
      : undefined,
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
    (s.phase === 'COMPLETE' || s.phase === 'EXPORT_READY') && s.error === null
      ? 'Approved (verified by topology invariant)'
      : s.error
        ? `Session has error: ${s.error.code}`
        : undefined,
  archReviewDecision: (s) =>
    s.phase === 'ARCH_COMPLETE' && s.error === null
      ? 'Approved (verified by topology invariant)'
      : undefined,
};

function getSlotDetail(state: SessionState, slot: string): string | undefined {
  const fn = SLOT_DETAIL_FNS[slot];
  return fn ? fn(state, state.phase) : undefined;
}

const ARCH_SLOTS = ['architecture', 'selfReview', 'archReviewDecision'] as const;

type ArchitectureSlot = (typeof ARCH_SLOTS)[number];
type ArchitectureFlowPhase = (typeof FLOW_PHASES.architecture)[number];

const ARCH_SLOT_REQUIRED_FROM = {
  architecture: 'ARCHITECTURE',
  selfReview: 'ARCH_REVIEW',
  archReviewDecision: 'ARCH_COMPLETE',
} satisfies Record<ArchitectureSlot, ArchitectureFlowPhase>;
const ARCH_SLOT_LABELS: Readonly<Record<string, string>> = {
  architecture: 'Architecture Decision Record',
  selfReview: 'ADR Self-Review',
  archReviewDecision: 'Architecture Review Decision',
};

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
  const detail = getSlotDetail(state, slot);
  const artifactKind = SLOT_ARTIFACT_KIND[slot];
  return {
    slot,
    label,
    required: isRequired,
    present: isSlotPresent(state, slot),
    status: determineSlotStatus(isRequired, isSlotFailed(state, slot), isSlotPresent(state, slot)),
    ...(detail !== undefined ? { detail } : {}),
    ...(artifactKind !== undefined ? { artifactKind } : {}),
  };
}

function compareReviewActors(
  state: SessionState,
  reviewerIdentity: DecisionIdentity | null,
): ActorIdentityComparison {
  if (reviewerIdentity === null) return 'uncomparable';
  const initiatorIdentity = state.initiatedByIdentity ?? { actorId: state.initiatedBy };
  return compareActorIdentity(initiatorIdentity, reviewerIdentity);
}

function getFourEyesDetail(
  state: SessionState,
  reviewerIdentity: DecisionIdentity | null,
  actorComparison: ActorIdentityComparison,
  fourEyesRequired: boolean,
): string {
  if (!fourEyesRequired) return 'Four-eyes not required by policy';
  if (reviewerIdentity === null) return 'Four-eyes pending: no review decision recorded yet';
  if (actorComparison === 'different')
    return `Four-eyes satisfied: initiator=${state.initiatedBy}, reviewer=${reviewerIdentity.actorId}`;
  if (actorComparison === 'uncomparable')
    return 'Four-eyes pending: initiator and reviewer identities are not comparable';
  return `Four-eyes VIOLATED: initiator and reviewer are the same person (${state.initiatedBy})`;
}

function evaluateFourEyes(state: SessionState): FourEyesStatus {
  const fourEyesRequired = state.policySnapshot?.allowSelfApproval === false;
  const decisionIdentity = state.reviewDecision?.decisionIdentity ?? null;
  const actorComparison = compareReviewActors(state, decisionIdentity);
  return {
    required: fourEyesRequired,
    satisfied: !fourEyesRequired || actorComparison === 'different',
    initiatedBy: state.initiatedBy,
    decisionIdentity,
    detail: getFourEyesDetail(state, decisionIdentity, actorComparison, fourEyesRequired),
  };
}

export function evaluateCompleteness(state: SessionState): CompletenessReport {
  const isArchFlow = isFlowPhase('architecture', state.phase);
  const isReviewFlow = isFlowPhase('review', state.phase);
  let slots: EvidenceSlotStatus[];

  if (isArchFlow) {
    slots = ARCH_SLOTS.map((slot) =>
      buildSlotEntry(
        state,
        slot,
        isFlowPhaseAtOrAfter('architecture', state.phase, ARCH_SLOT_REQUIRED_FROM[slot]),
        ARCH_SLOT_LABELS[slot] ?? slot,
      ),
    );
  } else if (isReviewFlow) {
    slots = [];
  } else {
    slots = ALL_SLOTS.map((slot) =>
      buildSlotEntry(
        state,
        slot,
        isFlowPhaseAtOrAfter('ticket', state.phase, SLOT_REQUIRED_FROM[slot]),
        SLOT_LABELS[slot] ?? slot,
      ),
    );
  }

  const fourEyes = evaluateFourEyes(state);
  const complete = slots.filter((s) => s.status === 'complete').length;
  const missing = slots.filter((s) => s.status === 'missing').length;
  const notYetRequired = slots.filter((s) => s.status === 'not_yet_required').length;
  const failed = slots.filter((s) => s.status === 'failed').length;
  const terminalEnough = state.phase !== 'READY' && (!isReviewFlow || isTerminalPhase(state.phase));
  const overallComplete = missing === 0 && failed === 0 && fourEyes.satisfied && terminalEnough;

  return {
    sessionId: state.id,
    phase: state.phase,
    policyMode: state.policySnapshot?.mode ?? 'unknown',
    overallComplete,
    slots,
    fourEyes,
    summary: { total: slots.length, complete, missing, notYetRequired, failed },
  };
}
