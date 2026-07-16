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
  /** Review loop progress during review phases (null when not in a review phase). */
  reviewLoop: ReviewLoopProgress | null;
  /**
   * Active check IDs that have not yet been validated.
   * Populated only during VALIDATION phase. Absent otherwise.
   */
  remainingChecks?: string[];
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
export type FinishOverallStatus = 'READY' | 'READY_WITH_WARNINGS' | 'BLOCKED' | 'NOT_VERIFIED';

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

  const blocker = buildBlocker(evalResult);
  const policyMode = state.policySnapshot?.mode ?? 'unknown';
  const profileId = state.activeProfile?.id ?? 'none';
  const productNext = buildProductNextAction(next, state.phase);

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
    reviewLoop: getReviewLoopProgress(state),
    remainingChecks:
      state.phase === 'VALIDATION' && state.activeChecks.length > 0
        ? state.activeChecks.filter((id) => !state.validation.some((v) => v.checkId === id))
        : undefined,
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

  const blocked = evalResult.kind === 'waiting' || evalResult.kind === 'pending';
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

  return {
    blocked,
    reasonCode: validationEvidenceBlocked ? validationEvidence.code : null,
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
  const blocked = evalResult.kind === 'waiting' || evalResult.kind === 'pending';
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

// ─── Blocker Extraction ───────────────────────────────────────────────────────

/**
 * Extract blocker from an EvalResult.
 *
 * The blocker surface mirrors the EvalResult semantics used for
 * human-facing guidance. This is the same truth that feeds
 * formatEval() — no new blocker logic is invented here.
 */
function buildBlocker(evalResult: ReturnType<typeof evaluate>): StatusProjection['blocker'] {
  switch (evalResult.kind) {
    case 'waiting':
      return {
        reasonCode: null,
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

// ─── Finish Card ──────────────────────────────────────────────────────────────

/**
 * Whether any REQUIRED evidence slot is unverified (missing or failed).
 *
 * Operates on the already-composed EvidenceDetailProjection — no second
 * evaluateCompleteness() call. `not_yet_required` slots NEVER count as
 * unverified (early phases are classified via readiness.blocked, not here).
 * There is no `stale` slot status in the canonical completeness report, so no
 * stale detection is claimed.
 */
function hasUnverifiedEvidence(evidence: EvidenceDetailProjection): boolean {
  return evidence.slots.some(
    (slot) => slot.required && (slot.status === 'missing' || slot.status === 'failed'),
  );
}

/**
 * Derive the single overall Finish status by combining existing projection
 * results. This is the ONLY new classification in the Finish Card and it is
 * strictly presentational — it re-evaluates nothing.
 *
 * Precedence (highest first):
 * 1. BLOCKED             — readiness projection reports blocked (waiting/pending).
 * 2. NOT_VERIFIED        — a required evidence slot is missing or failed.
 * 3. READY_WITH_WARNINGS — not blocked, evidence ok, but warnings present.
 * 4. READY               — otherwise.
 *
 * BLOCKED intentionally wins over NOT_VERIFIED so a blocked session is not
 * mislabelled merely because evidence is also incomplete.
 */
export function deriveFinishOverallStatus(
  readiness: ReadinessProjection,
  evidence: EvidenceDetailProjection,
): FinishOverallStatus {
  if (readiness.blocked) return 'BLOCKED';
  if (hasUnverifiedEvidence(evidence)) return 'NOT_VERIFIED';
  if (readiness.warnings.length > 0) return 'READY_WITH_WARNINGS';
  return 'READY';
}

/** Candidate next actions the Finish Card annotates (non-exit). */
const FINISH_CANDIDATE_ACTIONS = ['create PR', 'export evidence', 'keep branch'] as const;

/** Actions that mean "proceed toward landing" (vs. "keep the branch open"). */
const FINISH_PROCEED_ACTIONS = new Set<string>(['create PR', 'export evidence']);

/** Exit options the system does not govern. Never rendered as forbidden. */
const FINISH_EXIT_OPTIONS = ['abandon'] as const;

/**
 * Per-overall-status guidance for "proceed" vs "keep branch" actions.
 *
 * This is a static presentation table, not eligibility logic. Each entry maps
 * the overall Finish status to a label + reason for proceed-actions and for the
 * keep-branch action. Labels are presentation-only and must not be consumed for
 * enforcement.
 */
const FINISH_ACTION_TABLE: Record<
  FinishOverallStatus,
  { proceed: Omit<FinishActionGuidance, 'action'>; keep: Omit<FinishActionGuidance, 'action'> }
> = {
  READY: {
    proceed: {
      status: 'recommended',
      reason: 'Session reports ready; proceeding is a suitable next step.',
    },
    keep: {
      status: 'not_recommended',
      reason: 'Session is ready; keeping the branch open is not necessary.',
    },
  },
  READY_WITH_WARNINGS: {
    proceed: {
      status: 'recommended',
      reason: 'Ready with warnings; review warnings before proceeding.',
    },
    keep: {
      status: 'not_recommended',
      reason: 'Ready with warnings; keeping the branch open is optional.',
    },
  },
  NOT_VERIFIED: {
    proceed: {
      status: 'not_verified',
      reason: 'Required evidence is missing or failed; proceeding is not verified.',
    },
    keep: {
      status: 'recommended',
      reason: 'Keep the branch to complete verification before proceeding.',
    },
  },
  BLOCKED: {
    proceed: {
      status: 'not_recommended',
      reason: 'Session is blocked; resolve blockers before proceeding.',
    },
    keep: {
      status: 'recommended',
      reason: 'Keep the branch to resolve blockers before proceeding.',
    },
  },
};

/**
 * Build non-normative action guidance from the overall status alone.
 *
 * No per-action eligibility logic exists — the label is a trivial, documented
 * lookup keyed by overallStatus. These labels are presentation-only and must
 * not be consumed for enforcement.
 */
function buildFinishActionGuidance(overallStatus: FinishOverallStatus): FinishActionGuidance[] {
  const entry = FINISH_ACTION_TABLE[overallStatus];
  return FINISH_CANDIDATE_ACTIONS.map((action) => ({
    action,
    ...(FINISH_PROCEED_ACTIONS.has(action) ? entry.proceed : entry.keep),
  }));
}

/**
 * Build the Finish Card by composing existing projections. Pure function:
 * requires a valid SessionState and policy. No-session / unreadable-state
 * handling stays in the calling tool via the read-only session helpers.
 *
 * This function performs NO independent evidence, phase, obligation, or gate
 * evaluation — it only composes buildReadinessProjection,
 * buildEvidenceDetailProjection, resolveNextAction, and the single
 * presentation classifier deriveFinishOverallStatus.
 */
export function buildFinishCard(state: SessionState, policy: FlowGuardPolicy): FinishCard {
  const readiness = buildReadinessProjection(state, policy);
  const evidence = buildEvidenceDetailProjection(state);
  const blocker = buildBlockedProjection(state, policy);
  const next = resolveNextAction(state.phase, state);
  const overallStatus = deriveFinishOverallStatus(readiness, evidence);

  return {
    phase: state.phase,
    overallStatus,
    readiness,
    evidence,
    nextAction: {
      primaryCommand: next.commands[0] ?? null,
      summary: next.text,
    },
    blocker,
    warnings: readiness.warnings,
    actionGuidance: buildFinishActionGuidance(overallStatus),
    exitOptions: [...FINISH_EXIT_OPTIONS],
    guarantees: {
      readOnly: true,
      approves: false,
      consumesObligations: false,
      triggersExport: false,
    },
  };
}
