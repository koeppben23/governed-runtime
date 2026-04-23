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
    id: string | null;
    source: 'env' | 'git' | 'claim' | 'unknown' | null;
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
 */
export interface EvidenceSlotProjection {
  slot: string;
  label: string;
  status: 'complete' | 'missing' | 'not_yet_required' | 'failed';
  required: boolean;
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

// ─── Helpers ─────────────────────────────────────────────────────────────────