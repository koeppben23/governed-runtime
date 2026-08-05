/**
 * @module integration/status-finish
 * @description Finish-card composition for the read-only completion view.
 *
 * Split out of status.ts to keep that module within the file-size budget. This
 * module performs NO independent evidence, phase, obligation, or gate
 * evaluation: it composes existing projections and applies one presentational
 * classifier. It is not an authority.
 *
 * @version v1
 */

import type { SessionState } from '../state/schema.js';
import type { FlowGuardPolicy } from '../config/policy.js';
import type { ReviewReport } from '../state/evidence.js';
import { resolveNextAction } from '../machine/next-action.js';
import { projectCompletionProofStatus } from './proofgraph/proof-summary-projectors.js';
import { isTerminalPhase } from '../machine/topology.js';
import {
  buildEvidenceDetailProjection,
  buildReadinessProjection,
  buildBlockedProjection,
  type EvidenceDetailProjection,
  type ReadinessProjection,
  type FinishActionGuidance,
  type FinishCard,
  type FinishOverallStatus,
} from './status.js';

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
 * 1. BLOCKED             — readiness projection reports blocked (waiting).
 * 2. NOT_VERIFIED        — a required evidence slot is missing or failed.
 * 3. IN_PROGRESS         — non-terminal phase; lifecycle not yet complete.
 * 4. CHANGES_REQUIRED    — completed standalone review report has issues.
 * 5. READY_WITH_WARNINGS — terminal, evidence ok, but warnings present.
 * 6. READY               — otherwise.
 *
 * BLOCKED intentionally wins over NOT_VERIFIED so a blocked session is not
 * mislabelled merely because evidence is also incomplete.
 */
export function deriveFinishOverallStatus(
  readiness: ReadinessProjection,
  evidence: EvidenceDetailProjection,
  reviewReport: ReviewReport | null = null,
): FinishOverallStatus {
  if (readiness.blocked) return 'BLOCKED';
  if (hasUnverifiedEvidence(evidence)) return 'NOT_VERIFIED';
  // Non-terminal phases are in progress regardless of warnings or review status.
  if (!isTerminalPhase(readiness.phase)) return 'IN_PROGRESS';
  if (reviewReport?.overallStatus === 'issues') return 'CHANGES_REQUIRED';
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
  CHANGES_REQUIRED: {
    proceed: {
      status: 'not_recommended',
      reason:
        'Review completed with findings that require changes before the artifact can proceed.',
    },
    keep: {
      status: 'recommended',
      reason:
        'Keep the artifact available while the documented findings are addressed and reviewed again.',
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
  IN_PROGRESS: {
    proceed: {
      status: 'not_verified',
      reason: 'Workflow is not yet complete; export is not applicable.',
    },
    keep: {
      status: 'recommended',
      reason: 'Keep the branch open while the workflow progresses.',
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
export function buildFinishCard(
  state: SessionState,
  policy: FlowGuardPolicy,
  reviewReport: ReviewReport | null = null,
): FinishCard {
  const readiness = buildReadinessProjection(state, policy);
  const evidence = buildEvidenceDetailProjection(state);
  const blocker = buildBlockedProjection(state, policy);
  const next = resolveNextAction(state.phase, state);
  const overallStatus = deriveFinishOverallStatus(readiness, evidence, reviewReport);

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
    proofSummary: projectCompletionProofStatus(state) ?? undefined,
  };
}
