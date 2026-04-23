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
import { isCommandAllowed, Command, type Command as FlowGuardCommand } from '../machine/commands.js';

const ALL_COMMANDS = Object.values(Command) as FlowGuardCommand[];
import { evaluateCompleteness } from '../audit/completeness.js';

// ─── Projection Types ─────────────────────────────────────────────────────────

/**
 * Structured status projection — canonical runtime truth projected for UI.
 *
 * Every field is derived from an existing SSOT source.
 * No new semantics are invented here.
 */
export interface StatusProjection {
  /** Current workflow phase. */
  phase: string;
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
  /** Next action guidance from the machine. */
  nextAction: {
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
    requireVerifiedActorsForApproval: boolean | null;
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
  requiresVerifiedActorsForApproval: boolean;
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
  const evalResult = evaluate(
    state,
    // evaluate() uses only requireHumanGates from policy. Other policy fields
    // are not yet consumed by the evaluator — this is intentional and tracked
    // as a follow-up for when evaluate() needs broader policy context.
    { requireHumanGates: policy.requireHumanGates },
  );

  const blocker = buildBlocker(evalResult);
  const policyMode = state.policySnapshot?.mode ?? 'unknown';
  const profileId = state.activeProfile?.id ?? 'none';

  const actor = state.actorInfo
    ? {
        id: state.actorInfo.id,
        source: state.actorInfo.source,
        assurance: state.actorInfo.assurance,
      }
    : null;

  return {
    phase: state.phase,
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
    blocker,
    evidenceSummary: {
      present: completeness.summary.complete,
      missing: completeness.summary.missing,
      notYetRequired: completeness.summary.notYetRequired,
      failed: completeness.summary.failed,
    },
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

  return {
    blocked,
    reasonCode: null,
    reasonText: evalResult.kind === 'waiting' ? evalResult.reason : null,
    recoveryHint: next.text,
    missingEvidence,
    nextResolvableCommand: next.commands[0] ?? null,
    humanActionRequired:
      evalResult.kind === 'waiting'
        ? true
        : evalResult.kind === 'pending'
          ? null
          : false,
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
      requireVerifiedActorsForApproval: isRegulated ? snapshot.requireVerifiedActorsForApproval : null,
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

  return {
    phase: state.phase,
    policyMode: state.policySnapshot.mode,
    archiveStatus: state.archiveStatus ?? null,
    blocked,
    evidenceComplete: completeness.overallComplete,
    fourEyesSatisfied: completeness.fourEyes.satisfied,
    actorKnown: state.actorInfo?.source !== 'unknown',
    requiresVerifiedActorsForApproval:
      state.policySnapshot.mode === 'regulated' &&
      state.policySnapshot.requireVerifiedActorsForApproval === true,
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
function buildBlocker(
  evalResult: ReturnType<typeof evaluate>,
): StatusProjection['blocker'] {
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
