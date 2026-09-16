/**
 * @module integration/tools/continue-tool
 * @description flowguard_continue — deterministic phase dispatcher.
 *
 * Reads the canonical session state and returns phase-specific guidance
 * on which command to execute next. This is a routing tool, not an
 * orchestration engine — it never invents semantics, never infers missing
 * evidence, and never auto-approves. When multiple next actions are valid
 * the tool blocks with explicit options (fail-closed).
 *
 * @version v1
 */

import { withReadOnlySession, formatBlocked, enrichWithWorkflowDirective } from './helpers.js';
import { formatError } from './error-format.js';
import { USER_GATES, TERMINAL } from '../../machine/topology.js';
import { resolveWorkflowDirective } from '../../machine/workflow-directive.js';
import type { ToolDefinition } from './helpers.js';
import type { SessionState } from '../../state/schema.js';

const PHASE_GUIDANCE: Record<string, { status: string | ((state: SessionState) => string) }> = {
  TICKET: {
    status: 'Ticket captured.',
  },
  PLAN: {
    status: 'Plan phase active.',
  },
  VALIDATION: {
    status: 'Validation phase active.',
  },
  IMPLEMENTATION: {
    status: 'Implementation phase active.',
  },
  IMPL_REVIEW: {
    status: implReviewContinueStatus,
  },
  ARCHITECTURE: {
    status: 'Architecture review is pending.',
  },
  PEER_REVIEW: {
    status: 'Peer review phase active.',
  },
  COMPLETE: {
    status: 'Workflow complete.',
  },
};

/**
 * State-aware /continue status for IMPL_REVIEW: a blocked implementation
 * review obligation must surface its blocker and the executable recovery
 * instead of claiming a pending review the runtime itself refuses to run.
 */
function implReviewContinueStatus(state: SessionState): string {
  const obligations = state.reviewAssurance?.obligations ?? [];
  const implObligations = obligations.filter((o) => o.obligationType === 'implement');
  const last = implObligations.at(-1);
  if (last?.status !== 'blocked') return 'Implementation review is pending.';
  if (implObligations.filter((o) => o.status === 'blocked').length >= 3) {
    return (
      'Implementation review orchestration failed permanently after repeated blocked ' +
      'review obligations. Abort the session or start over with a new ticket.'
    );
  }
  return (
    `Implementation review obligation is blocked (${last.blockedCode ?? 'unknown'}). ` +
    'Re-run /implement to re-record the implementation and mint a fresh review obligation.'
  );
}

export const continue_cmd: ToolDefinition = {
  description:
    'Deterministic phase dispatcher. Returns guidance on which command to execute next ' +
    'based on the current workflow phase. Blocks at user-gate and terminal phases with ' +
    'explicit decision options. Use /continue for routing decisions (which command next). ' +
    'Use /status to inspect detailed session state and evidence slots.',
  args: {},
  async execute(_args, context) {
    try {
      const { state } = (await withReadOnlySession(context)) ?? {};
      if (!state) return formatBlocked('NO_SESSION');
      const { phase } = state;

      if (USER_GATES.has(phase)) return formatUserGateGuidance(state);
      if (TERMINAL.has(phase)) return formatTerminalGuidance(state);
      if (phase === 'READY') {
        return formatBlocked('CONTINUE_AMBIGUOUS', {
          phase,
          reason: 'Multiple flows available from READY. Choose one explicitly.',
        });
      }

      // All other phases: lookup guidance
      const guidance = PHASE_GUIDANCE[phase];
      if (guidance) {
        const status =
          typeof guidance.status === 'function' ? guidance.status(state) : guidance.status;
        return formatDeterministicGuidance(state, { status });
      }

      // Unknown phase — fail closed
      return formatBlocked('CONTINUE_UNKNOWN_PHASE', { phase });
    } catch (err) {
      return formatError(err);
    }
  },
};

function formatUserGateGuidance(state: SessionState): string {
  // Derive the gate decision commands from the canonical product projection
  // instead of a local hardcoded list. resolveWorkflowDirective resolves the
  // user-gate phases (PLAN_REVIEW / EVIDENCE_REVIEW / ARCH_REVIEW) to their
  // decision commands from the machine authority, so /continue no longer keeps
  // a parallel copy of ['/approve', '/request-changes', '/reject'].
  const directive = resolveWorkflowDirective(state);
  return formatContinueResponse(
    {
      phase: state.phase,
      status: `User gate active at ${state.phase}. A human decision is required.`,
      decisionRequired: true,
      decisionCommands: directive.commands,
      _continue: { action: 'manual_decision' },
    },
    state,
  );
}

function formatTerminalGuidance(state: SessionState): string {
  // Aborted sessions are terminal (phase=COMPLETE) but are NOT clean
  // completions: do not route them to /export as an audit package. /export is
  // additionally fail-closed against aborted sessions in archive-tool.ts.
  const aborted = state.error?.code === 'ABORTED';
  return formatContinueResponse(
    {
      phase: state.phase,
      status: aborted ? 'Session aborted — not a clean completion.' : 'Workflow complete.',
      _continue: { action: 'terminal' },
    },
    state,
  );
}

function formatDeterministicGuidance(state: SessionState, guidance: { status: string }): string {
  return formatContinueResponse(
    {
      phase: state.phase,
      status: guidance.status,
      _continue: { action: 'deterministic' },
    },
    state,
  );
}
function formatContinueResponse(value: Record<string, unknown>, state: SessionState): string {
  return JSON.stringify(enrichWithWorkflowDirective(value, state));
}
