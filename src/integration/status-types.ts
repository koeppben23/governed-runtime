/**
 * @module integration/status-types
 * @description Canonical projection contracts for the status surfaces.
 *
 * Every field is derived from an existing SSOT source; these declarations
 * define the shape only. `status.ts` builds the unified StatusProjection and
 * `status-detail-projections.ts` builds the per-flag detail surfaces.
 */

import type { ReviewFindings } from '../state/evidence.js';
import type { DecisionIdentity } from '../state/evidence-identity.js';
import type { ActorAssurance } from '../shared/actor-assurance.js';
import type { ExecutionDisposition, WorkflowDirective } from '../machine/workflow-directive.js';
import type { ReviewLoopProgress } from './review/review-loop-progress.js';
import type { StatusConclusionProjection } from './status-conclusion.js';
import type { KnownPresentationStatusInput } from '../presentation/labels.js';
import type { PersistedProofGraphSummary } from '../audit/proofgraph/summary.js';
import type { ProofApprovalProjection } from './proofgraph/approval-projection.js';
import type { CompactProofPresentation } from '../presentation/proof-model.js';

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
  /** FlowGuard session identity (FlowGuard UUID). */
  flowguardSessionId: string;
  /** Host session identity (OpenCode session id). */
  hostSessionId: string;
  /** Active policy mode (solo, team, team-ci, regulated). */
  policyMode: string;
  /** Active profile identifier. */
  profileId: string;
  /** Actor attribution (null when no session exists). */
  actor: {
    id: string;
    source: 'env' | 'git' | 'claim' | 'oidc' | 'unknown';
    assurance: ActorAssurance;
  } | null;
  /** Regulated archive lifecycle compatibility status. */
  archiveStatus: string | null;
  /** Semantics of the most recent user-requested archive export. */
  lastExport: {
    packagePurpose: 'sharing' | 'auditor' | null;
    integrityCapability: 'verifiable' | 'not_verifiable' | null;
    verificationStatus: 'not_run' | 'passed' | 'failed' | null;
  };
  /** Commands that are currently admissible. */
  allowedCommands: string[];
  /**
   * Derived execution disposition — never persisted. `blocked` never destroys
   * the workflow position; `awaiting_human` marks an open human gate.
   */
  executionDisposition: ExecutionDisposition;
  /** Canonical workflow directive, including the allowed commands verbatim. */
  directive: WorkflowDirective;
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
  proofSummary: CompactProofPresentation;
  /**
   * Approval-certificate and materialization chain (#762). Present so a reviewer
   * or auditor can verify the binding from declaration through executed evidence
   * without reading raw session state.
   */
  proofApprovals: ProofApprovalProjection;
  /** Review loop progress during review phases (null when not in a review phase). */
  reviewLoop: ReviewLoopProgress | null;
  /** Current rework required by an independent implementation review, if any. */
  implementationRework: {
    rejectedDigest: string;
    iteration: number | null;
    blockingIssues: ReviewFindings['blockingIssues'];
    majorRisks: ReviewFindings['majorRisks'];
    missingVerification: ReviewFindings['missingVerification'];
    scopeCreep: ReviewFindings['scopeCreep'];
    unknowns: ReviewFindings['unknowns'];
    openChallengeIds: readonly string[];
  } | null;
  /**
   * Active check IDs that have not yet been validated.
   * Populated only during VALIDATION phase. Absent otherwise.
   */
  remainingChecks?: string[] | undefined;

  /**
   * Canonical readiness derived from evalResult and evidenceSummary.
   * Computed upstream — the presentation builder MUST NOT re-derive this.
   */
  readiness: KnownPresentationStatusInput;

  /**
   * Canonical conclusion derived from evalResult and directive.
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
    decisionIdentity: DecisionIdentity | null;
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
   * It mirrors the same EvalResult signal that drives the structured
   * `directive` for user guidance.
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
    minimumActorAssuranceForApproval: ActorAssurance | null;
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
  minimumActorAssuranceForApproval: ActorAssurance | null;
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
 * A reviewer-authored caveat projected from the persisted ReviewReport.
 *
 * Only the two human-visible caveat sources are projected; material findings,
 * scope creep, mechanical findings, and challenge outcomes are owned by other
 * surfaces. `message` is the reviewer's plain text, copied verbatim — this is
 * a projection of persisted review authority, never a second interpretation of
 * the original ReviewFindings.
 */
export interface FinishReviewCaveat {
  readonly source: 'missing_verification' | 'unknown';
  readonly message: string;
}

/**
 * Finish Card — a curated, read-only overview of session readiness before
 * /export / PR / archive decisions.
 *
 * Composition-only: every field is either copied verbatim from an existing
 * projection ({@link buildReadinessProjection}, {@link buildEvidenceDetailProjection},
 * {@link resolveWorkflowDirective}, or the pure `projectFinishReviewCaveats`
 * projection of the persisted ReviewReport) or derived by the single
 * presentation classifier {@link deriveFinishOverallStatus}. No independent
 * evidence/gate evaluation.
 */
export interface FinishCard {
  phase: string;
  overallStatus: FinishOverallStatus;
  /** Readiness projection, copied verbatim from buildReadinessProjection. */
  readiness: ReadinessProjection;
  /** Evidence detail, copied verbatim from buildEvidenceDetailProjection. */
  evidence: EvidenceDetailProjection;
  /** Canonical workflow directive. */
  directive: WorkflowDirective;
  /**
   * Canonical blocker detail, copied verbatim from buildBlockedProjection.
   * Explains WHY the session is blocked (reason code/text, missing evidence,
   * next resolvable command) rather than only that it is blocked. Composition
   * only — no independent blocker logic is invented here.
   */
  blocker: BlockedProjection;
  /**
   * Reviewer-authored caveats projected verbatim from the persisted
   * ReviewReport (`missing_verification` and `unknown` only). Rendered as
   * advisory notices; never re-classified into blocker/evidence semantics.
   */
  reviewCaveats: FinishReviewCaveat[];
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
  proofSummary: CompactProofPresentation;
}
