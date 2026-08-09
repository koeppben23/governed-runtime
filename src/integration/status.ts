/**
 * @module integration/status
 * @description Status projection — pure SSOT-aligned view of canonical runtime truth.
 *
 * Design principle (FlowGuard Agent Rule):
 *   "Status surfaces must be projections of canonical runtime truth,
 *    never an independent interpretation layer."
 *
 * This module is the ONLY place that builds the unified StatusProjection.
 * All consumers (tools, helpers, reporters) MUST use buildStatusProjection().
 * No drift — if the projection changes, only this file changes.
 *
 * Source of truth for each field:
 * - phase              → state.phase
 * - allowedCommands    → isCommandAllowed() for each known command
 * - nextAction         → resolveNextAction()
 * - blocker           → evaluate() waiting/pending reason
 * - evidenceSummary    → evaluateCompleteness()
 * - policyMode         → state.policySnapshot?.mode ?? 'unknown'
 * - actor              → state.actorInfo
 * - archiveStatus      → state.archiveStatus
 *
 * @version v1
 */

import type { SessionState } from '../state/schema.js';
import type { FlowGuardPolicy } from '../config/policy.js';
import { evaluate } from '../machine/evaluate.js';
import { resolveNextAction } from '../machine/next-action.js';
import { evaluateValidationEvidence } from '../machine/validation-evidence.js';
import {
  isCommandAllowed,
  Command,
  type Command as FlowGuardCommand,
} from '../machine/commands.js';
import { PHASE_LABELS } from '../presentation/phase-labels.js';
import { buildProductNextAction } from '../presentation/next-action-copy.js';

const ALL_COMMANDS = Object.values(Command) as FlowGuardCommand[];
import { evaluateCompleteness } from '../audit/completeness.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import { getReviewLoopProgress, type ReviewLoopProgress } from './review/review-loop-progress.js';
import {
  projectStatusConclusion,
  type StatusActionProjection,
  type StatusConclusionProjection,
} from './status-conclusion.js';
import type { KnownPresentationStatusInput } from '../presentation/labels.js';
import {
  summarizePersistedProofGraph,
  type PersistedProofGraphSummary,
} from '../audit/proofgraph/summary.js';
import {
  buildProofApprovalProjection,
  type ProofApprovalProjection,
} from './proofgraph/approval-projection.js';
import { projectProofStatusForState } from './proofgraph/proof-summary-projectors.js';
import { evaluateProofGraphGateFromState } from '../audit/proofgraph/gate.js';
import { mapGateKindToRegistryCode } from '../audit/proofgraph/reason-code-mapping.js';

// Re-export for consumers
export type { StatusActionProjection, StatusConclusionProjection };
// ─── Projection Types ─────────────────────────────────────────────────────────

/**
 * Structured status projection — canonical runtime truth projected for UI.
 *
 * Every field is derived from an existing SSOT source.
 * No new semantics are invented here.
 */
export interface StatusProjection {
  /** Current workflow phase (canonical enum value). */
  phase: string;
  /** Human-readable phase label for product display. */
  phaseLabel: string;
  /** Session identifier. */
  sessionId: string;
  /** Active policy mode (solo, team, team-ci, regulated). */
  policyMode: string;
  /** Active profile identifier. */
  profileId: string;
  /** Actor attribution (null when no session exists). */
  actor: {
    id: string;
    source: 'env' | 'git' | 'claim' | 'oidc' | 'unknown';
    assurance: 'best_effort' | 'claim_validated' | 'idp_verified';
  } | null;
  /** Archive lifecycle status. */
  archiveStatus: string | null;
  /** Commands that are currently admissible. */
  allowedCommands: string[];
  /** Next action guidance from the machine (canonical commands). */
  nextAction: {
    primaryCommand: string | null;
    summary: string;
  };
  /** Product-friendly next action guidance (presentation layer). */
  productNextAction: {
    primaryCommand: string | null;
    summary: string;
  };
  /**
   * Active blocker, if the current phase is waiting or pending.
   * reasonCode is null when no structured code exists in the canonical source.
   */
  blocker: {
    reasonCode: string | null;
    reasonText: string | null;
  } | null;
  /** Evidence completeness summary. */
  evidenceSummary: {
    present: number;
    missing: number;
    notYetRequired: number;
    failed: number;
  };
  proofGraph: PersistedProofGraphSummary;
  /** Mandatory compact ProofGraph presentation for every resolved session. */
  proofSummary: import('../presentation/proof-model.js').CompactProofPresentation;
  /**
   * Approval-certificate and materialization chain (#762). Present so a reviewer
   * or auditor can verify the binding from declaration through executed evidence
   * without reading raw session state.
   */
  proofApprovals: ProofApprovalProjection;
  /** Review loop progress during review phases (null when not in a review phase). */
  reviewLoop: ReviewLoopProgress | null;
  /**
   * Active check IDs that have not yet been validated.
   * Populated only during VALIDATION phase. Absent otherwise.
   */
  remainingChecks?: string[];

  /**
   * Canonical readiness derived from evalResult and evidenceSummary.
   * Computed upstream — the presentation builder MUST NOT re-derive this.
   */
  readiness: KnownPresentationStatusInput;

  /**
   * Canonical conclusion derived from evalResult and productNextAction.
   *
   * The presentation builder MUST NOT derive conclusion kind or actions itself.
   * This field carries the already-decided conclusion, typed by kind.
   */
  conclusion: StatusConclusionProjection;
}

/**
 * Evidence slot detail — per-slot breakdown for --evidence flag.
 * artifactKind sourced from canonical completeness.ts (SLOT_ARTIFACT_KIND).
 */
export interface EvidenceSlotProjection {
  slot: string;
  label: string;
  status: 'complete' | 'missing' | 'not_yet_required' | 'failed';
  required: boolean;
  artifactKind: string | null;
  hint: string | null;
  detail: string | null;
}

/**
 * Full evidence detail for --evidence flag.
 */
export interface EvidenceDetailProjection {
  phase: string;
  overallComplete: boolean;
  slots: EvidenceSlotProjection[];
  summary: StatusProjection['evidenceSummary'];
  fourEyes: {
    required: boolean;
    satisfied: boolean;
    initiatedBy: string;
    decidedBy: string | null;
    detail: string;
  };
}

/** Blocked surface for /status --why-blocked. */
export interface BlockedProjection {
  blocked: boolean;
  reasonCode: string | null;
  reasonText: string | null;
  recoveryHint: string | null;
  missingEvidence: Array<{
    slot: string;
    hint: string | null;
  }>;
  nextResolvableCommand: string | null;
  /**
   * Whether a human decision is required at a User Gate.
   *
   * DERIVED from evalResult.kind (canonical runtime truth):
   * - waiting  → true  (blocked at User Gate, human must decide)
   * - pending  → null  (workflow in progress, no gate block)
   * - terminal → false (session complete)
   * - transition → false (auto-advanced)
   *
   * This is a DISPLAY HINT, not an independent canonical fact.
   * It mirrors the same signal that feeds formatEval() for user guidance.
   */
  humanActionRequired: boolean | null;
}

/** Context surface for /status --context. */
export interface ContextProjection {
  actor: StatusProjection['actor'];
  archiveStatus: string | null;
  policyMode: string;
  regulated: {
    applicable: boolean;
    minimumActorAssuranceForApproval: 'best_effort' | 'claim_validated' | 'idp_verified' | null;
    centralPolicyActive: boolean | null;
    fourEyesRelevant: boolean | null;
  };
}

/** Readiness surface for /status --readiness. */
export interface ReadinessProjection {
  phase: string;
  policyMode: string;
  archiveStatus: string | null;
  blocked: boolean;
  evidenceComplete: boolean;
  fourEyesSatisfied: boolean;
  actorKnown: boolean;
  minimumActorAssuranceForApproval: 'best_effort' | 'claim_validated' | 'idp_verified' | null;
  /** Warnings about configuration normalization or legacy values. */
  warnings: string[];
}

/**
 * Overall Finish Card status.
 *
 * This is the SINGLE non-normative presentation classification introduced by
 * the Finish Card. It is derived by {@link deriveFinishOverallStatus} purely by
 * combining existing projection results — it never re-evaluates evidence slots,
 * phases, obligations, or gates.
 */
export type FinishOverallStatus =
  'IN_PROGRESS' | 'READY' | 'READY_WITH_WARNINGS' | 'CHANGES_REQUIRED' | 'BLOCKED' | 'NOT_VERIFIED';

/** Presentation-only guidance status for a candidate next action. */
export type FinishActionStatus = 'recommended' | 'not_recommended' | 'not_verified';

/**
 * Non-normative guidance for a candidate next action.
 *
 * IMPORTANT: `status` is a PRESENTATION LABEL derived from the overall Finish
 * status. It is NOT a command-policy decision, NOT an approval, and MUST NOT be
 * consumed for enforcement. Enforcement stays with the owning commands
 * (e.g. /export) and existing gates.
 */
export interface FinishActionGuidance {
  action: string;
  status: FinishActionStatus;
  reason: string;
}

/**
 * Finish Card — a curated, read-only overview of session readiness before
 * /export / PR / archive decisions.
 *
 * Composition-only: every field is either copied verbatim from an existing
 * projection ({@link buildReadinessProjection}, {@link buildEvidenceDetailProjection},
 * {@link resolveNextAction}) or derived by the single presentation classifier
 * {@link deriveFinishOverallStatus}. No independent evidence/gate evaluation.
 */
export interface FinishCard {
  phase: string;
  overallStatus: FinishOverallStatus;
  /** Readiness projection, copied verbatim from buildReadinessProjection. */
  readiness: ReadinessProjection;
  /** Evidence detail, copied verbatim from buildEvidenceDetailProjection. */
  evidence: EvidenceDetailProjection;
  /** Canonical next action from resolveNextAction. */
  nextAction: {
    primaryCommand: string | null;
    summary: string;
  };
  /**
   * Canonical blocker detail, copied verbatim from buildBlockedProjection.
   * Explains WHY the session is blocked (reason code/text, missing evidence,
   * next resolvable command) rather than only that it is blocked. Composition
   * only — no independent blocker logic is invented here.
   */
  blocker: BlockedProjection;
  /** Configuration warnings surfaced by the readiness projection. */
  warnings: string[];
  /**
   * Non-normative guidance for candidate next actions (create PR, export
   * evidence, keep branch). Presentation labels only — never approvals, never
   * command-policy, never consumed for enforcement.
   */
  actionGuidance: FinishActionGuidance[];
  /**
   * Exit options the system does not govern (e.g. abandon). Rendered as
   * available user choices, NEVER as forbidden actions.
   */
  exitOptions: string[];
  /** Explicit read-only / non-approval guarantees for consumers. */
  guarantees: {
    readOnly: true;
    approves: false;
    consumesObligations: false;
    triggersExport: false;
  };
  /** Compact ProofGraph summary for the completion card. */
  proofSummary: import('../presentation/proof-model.js').CompactProofPresentation;
}

// ─── Projection Builder ───────────────────────────────────────────────────────

/**
 * Build a StatusProjection purely from canonical runtime truth.
 *
 * This is the ONLY function that constructs StatusProjection.
 * No new logic — only projection from existing SSOT sources.
 *
 * @param state - Current session state.
 * @param policy - Resolved FlowGuard policy (from state or default).
 * @returns Structured status projection.
 */
export function buildStatusProjection(
  state: SessionState,
  policy: FlowGuardPolicy,
): StatusProjection {
  const completeness = evaluateCompleteness(state);
  const next = resolveNextAction(state.phase, state);
  const allowed = ALL_COMMANDS.filter((cmd: FlowGuardCommand) =>
    isCommandAllowed(state.phase, cmd),
  );
  const evalResult = evaluate(state, { requireHumanGates: policy.requireHumanGates });

  const blocker = buildBlocker(evalResult, state);
  const policyMode = state.policySnapshot?.mode ?? 'unknown';
  const profileId = state.activeProfile?.id ?? 'none';
  const productNext = buildProductNextAction(
    next,
    state.phase,
    state.error?.code === 'ABORTED',
    state.archiveStatus,
  );

  const actor = state.actorInfo
    ? {
        id: state.actorInfo.id,
        source: state.actorInfo.source,
        assurance: state.actorInfo.assurance,
      }
    : null;

  return {
    phase: state.phase,
    phaseLabel: PHASE_LABELS[state.phase],
    sessionId: state.id,
    policyMode,
    profileId,
    actor,
    archiveStatus: state.archiveStatus ?? null,
    allowedCommands: allowed.map((cmd: FlowGuardCommand) => `/${cmd}`),
    nextAction: {
      primaryCommand: next.commands[0] ?? null,
      summary: next.text,
    },
    productNextAction: {
      primaryCommand: productNext.commands[0] ?? null,
      summary: productNext.text,
    },
    blocker,
    evidenceSummary: {
      present: completeness.summary.complete,
      missing: completeness.summary.missing,
      notYetRequired: completeness.summary.notYetRequired,
      failed: completeness.summary.failed,
    },
    proofGraph: summarizePersistedProofGraph(state),
    proofSummary: projectProofStatusForState(state),
    proofApprovals: buildProofApprovalProjection(state),
    reviewLoop: getReviewLoopProgress(state),
    remainingChecks:
      state.phase === 'VALIDATION' && state.activeChecks.length > 0
        ? state.activeChecks.filter((id) => !state.validation.some((v) => v.checkId === id))
        : undefined,
    conclusion: projectStatusConclusion(evalResult, productNext),
    readiness: deriveReadinessField(evalResult, completeness),
  };
}

/**
 * Build EvidenceDetailProjection from canonical completeness report.
 *
 * Uses audit/completeness.ts as the single source of truth.
 * No new evidence rules are invented here.
 */
export function buildEvidenceDetailProjection(state: SessionState): EvidenceDetailProjection {
  const report = evaluateCompleteness(state);

  return {
    phase: state.phase,
    overallComplete: report.overallComplete,
    slots: report.slots.map((s) => ({
      slot: s.slot,
      label: s.label,
      required: s.required,
      status: s.status,
      artifactKind: s.artifactKind ?? null,
      hint: s.status === 'failed' ? (s.detail ?? null) : null,
      detail: s.detail ?? null,
    })),
    summary: {
      present: report.summary.complete,
      missing: report.summary.missing,
      notYetRequired: report.summary.notYetRequired,
      failed: report.summary.failed,
    },
    fourEyes: {
      required: report.fourEyes.required,
      satisfied: report.fourEyes.satisfied,
      initiatedBy: report.fourEyes.initiatedBy,
      decidedBy: report.fourEyes.decidedBy,
      detail: report.fourEyes.detail,
    },
  };
}

/** Build blocked detail projection for /status --why-blocked. */
export function buildBlockedProjection(
  state: SessionState,
  policy: FlowGuardPolicy,
): BlockedProjection {
  const evalResult = evaluate(state, { requireHumanGates: policy.requireHumanGates });
  const next = resolveNextAction(state.phase, state);
  const completeness = evaluateCompleteness(state);

  const blocked = evalResult.kind === 'waiting';
  const missingEvidence = completeness.slots
    .filter((slot) => slot.required && (slot.status === 'missing' || slot.status === 'failed'))
    .map((slot) => ({
      slot: slot.slot,
      hint: slot.status === 'failed' ? (slot.detail ?? null) : null,
    }));

  // #400: surface the explicit validation-evidence reason when VALIDATION is
  // fail-closed-blocked with no active checks. This is a projection of the single
  // authority's decision — no independent interpretation.
  const validationEvidence =
    state.phase === 'VALIDATION' ? evaluateValidationEvidence(state) : null;
  const validationEvidenceBlocked =
    validationEvidence !== null && validationEvidence.blocked && validationEvidence.code !== null;
  // #695: surface the enforced ProofGraph gate reason at EVIDENCE_REVIEW so the
  // why-blocked surface projects the gate's migrated human copy.
  const proofGraphGateCode = proofGraphGateRegistryCode(state);

  return {
    blocked,
    reasonCode: validationEvidenceBlocked ? validationEvidence.code : proofGraphGateCode,
    reasonText:
      evalResult.kind === 'waiting'
        ? evalResult.reason
        : validationEvidenceBlocked
          ? next.text
          : null,
    recoveryHint: next.text,
    missingEvidence,
    nextResolvableCommand: next.commands[0] ?? null,
    humanActionRequired:
      evalResult.kind === 'waiting' ? true : evalResult.kind === 'pending' ? null : false,
  };
}

/** Build context detail projection for /status --context. */
export function buildContextProjection(state: SessionState): ContextProjection {
  const snapshot = state.policySnapshot;
  const isRegulated = snapshot.mode === 'regulated';
  return {
    actor: state.actorInfo
      ? {
          id: state.actorInfo.id,
          source: state.actorInfo.source,
          assurance: state.actorInfo.assurance,
        }
      : null,
    archiveStatus: state.archiveStatus ?? null,
    policyMode: snapshot.mode,
    regulated: {
      applicable: isRegulated,
      minimumActorAssuranceForApproval: isRegulated
        ? (snapshot.minimumActorAssuranceForApproval ?? 'claim_validated')
        : null,
      centralPolicyActive: snapshot.centralMinimumMode ? true : null,
      fourEyesRelevant: isRegulated ? snapshot.allowSelfApproval === false : null,
    },
  };
}

/** Build readiness projection for /status --readiness. */
export function buildReadinessProjection(
  state: SessionState,
  policy: FlowGuardPolicy,
): ReadinessProjection {
  const completeness = evaluateCompleteness(state);
  const evalResult = evaluate(state, { requireHumanGates: policy.requireHumanGates });
  const blocked = evalResult.kind === 'waiting';
  const snapshot = state.policySnapshot;
  const warnings: string[] = [];

  // Check for legacy/weakened selfReview config
  if (snapshot.selfReview) {
    const cfg = snapshot.selfReview;
    if (
      cfg.subagentEnabled !== true ||
      cfg.fallbackToSelf !== false ||
      cfg.strictEnforcement !== true
    ) {
      warnings.push(
        'Legacy selfReview config detected and normalized to mandatory strict. ' +
          `Ensure ${REVIEWER_SUBAGENT_TYPE} plugin is active.`,
      );
    }
  }

  return {
    phase: state.phase,
    policyMode: snapshot.mode,
    archiveStatus: state.archiveStatus ?? null,
    blocked,
    evidenceComplete: completeness.overallComplete,
    fourEyesSatisfied: completeness.fourEyes.satisfied,
    actorKnown: state.actorInfo?.source !== 'unknown',
    minimumActorAssuranceForApproval:
      snapshot.mode === 'regulated'
        ? (snapshot.minimumActorAssuranceForApproval ?? 'claim_validated')
        : null,
    warnings,
  };
}

// ─── Readiness Derivation ──────────────────────────────────────────────────────

/** Canonical readiness for StatusProjection — computed upstream, never in presentation. */
function deriveReadinessField(
  evalResult: ReturnType<typeof evaluate>,
  completeness: ReturnType<typeof evaluateCompleteness>,
): KnownPresentationStatusInput {
  if (evalResult.kind === 'waiting') return 'BLOCKED';
  if (completeness.summary.missing > 0 || completeness.summary.failed > 0) return 'NOT_VERIFIED';
  if (evalResult.kind === 'pending') return 'IN_PROGRESS';
  return 'READY';
}

// ─── Blocker Extraction ───────────────────────────────────────────────────────

/**
 * Extract blocker from an EvalResult.
 *
 * The blocker surface mirrors the EvalResult semantics used for
 * human-facing guidance. This is the same truth that feeds
 * formatEval() — no new blocker logic is invented here.
 *
 * At EVIDENCE_REVIEW the waiting blocker carries the registered reason code
 * of the ProofGraph gate that the review-decision rail enforces (mirrors the
 * rail inputs via evaluateProofGraphGateFromState), so the status surface can
 * project the migrated human copy for the gate.
 */
function buildBlocker(
  evalResult: ReturnType<typeof evaluate>,
  state: SessionState,
): StatusProjection['blocker'] {
  switch (evalResult.kind) {
    case 'waiting':
      return {
        reasonCode: proofGraphGateRegistryCode(state),
        reasonText: evalResult.reason,
      };
    case 'pending':
      // No structured code or text in canonical EvalPending
      return {
        reasonCode: null,
        reasonText: null,
      };
    case 'terminal':
    case 'transition':
      return null;
  }
}

/**
 * Registry reason code for the enforced ProofGraph gate at EVIDENCE_REVIEW,
 * or null when no gate is active. Projection of the rail's gate decision only
 * — no independent gating authority.
 */
function proofGraphGateRegistryCode(state: SessionState): string | null {
  if (state.phase !== 'EVIDENCE_REVIEW') return null;
  const decision = evaluateProofGraphGateFromState(state);
  if (!decision.gated || decision.kind === 'clear') return null;
  return mapGateKindToRegistryCode(decision.kind);
}
