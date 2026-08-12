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

import {
  withMutableSessionTransaction,
  withMutableSession,
  withReadOnlySession,
  formatBlocked,
  appendNextAction,
  writeStateWithArtifacts,
} from './helpers.js';
import { formatError } from './error-format.js';
import { USER_GATES, TERMINAL } from '../../machine/topology.js';
import { resolveNextAction } from '../../machine/next-action.js';
import { buildProductNextAction } from '../../presentation/next-action-copy.js';
import type { MutableSession, ToolDefinition } from './helpers.js';
import type { SessionState } from '../../state/schema.js';
import { bindExternalReviewEvidence } from '../review/transport-evidence.js';
import { REVIEW_IDENTITY_REJECTION_FIELD } from '../../shared/flowguard-identifiers.js';

const PHASE_GUIDANCE: Record<string, { status: string }> = {
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
    status: 'Implementation review is pending.',
  },
  ARCHITECTURE: {
    status: 'Architecture review is pending.',
  },
  REVIEW: {
    status: 'Standalone review phase active.',
  },
  COMPLETE: {
    status: 'Workflow complete.',
  },
};

export const continue_cmd: ToolDefinition = {
  description:
    'Deterministic phase dispatcher. Returns guidance on which command to execute next ' +
    'based on the current workflow phase. Blocks at user-gate and terminal phases with ' +
    'explicit decision options. Use /continue for routing decisions (which command next). ' +
    'Use /status to inspect detailed session state and evidence slots.',
  args: {},
  async execute(_args, context) {
    try {
      const mutableSession = await tryBindTransportEvidence(context);
      if (typeof mutableSession === 'string') return mutableSession;
      const { state } = mutableSession ?? (await withReadOnlySession(context)) ?? {};
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
      if (guidance) return formatDeterministicGuidance(state, guidance);

      // Unknown phase — fail closed
      return formatBlocked('CONTINUE_UNKNOWN_PHASE', { phase });
    } catch (err) {
      return formatError(err);
    }
  },
};

function formatUserGateGuidance(state: SessionState): string {
  // Derive the gate decision commands from the canonical product projection
  // instead of a local hardcoded list. buildProductNextAction resolves the
  // user-gate phases (PLAN_REVIEW / EVIDENCE_REVIEW / ARCH_REVIEW) to their
  // decision commands from the machine authority, so /continue no longer keeps
  // a parallel copy of ['/approve', '/request-changes', '/reject'].
  const nextAction = resolveNextAction(state.phase, state);
  const productNext = buildProductNextAction(
    nextAction,
    state.phase,
    state.error?.code === 'ABORTED',
    state.archiveStatus ?? null,
  );
  return formatContinueResponse(
    {
      phase: state.phase,
      status: `User gate active at ${state.phase}. A human decision is required.`,
      decisionRequired: true,
      decisionCommands: productNext.commands,
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
  const response = JSON.parse(appendNextAction(JSON.stringify(value), state)) as Record<
    string,
    unknown
  >;
  const productNext = response.productNextAction as { text?: unknown } | undefined;
  const commands = (productNext as { commands?: unknown } | undefined)?.commands;
  if (Array.isArray(commands) && commands.every((command) => typeof command === 'string')) {
    response.next = commands.join(', ');
  }
  return JSON.stringify(response);
}

async function tryBindTransportEvidence(context: {
  sessionID: string;
  worktree: string;
  directory: string;
}): Promise<MutableSession | string> {
  const probe = await withMutableSession(context);
  const probeResult = await bindExternalReviewEvidence(
    probe.sessDir,
    probe.state,
    context.sessionID,
    probe.ctx.now(),
  );
  if (probeResult.status === 'none' || probeResult.status === 'already_bound') return probe;
  if (probeResult.status === 'invalid') {
    return formatTransportEvidenceBlock(probeResult);
  }

  return withMutableSessionTransaction(context, async (session) => {
    const result = await bindExternalReviewEvidence(
      session.sessDir,
      session.state,
      context.sessionID,
      session.ctx.now(),
    );
    if (result.status === 'none' || result.status === 'already_bound') return session;
    if (result.status === 'invalid') {
      return formatTransportEvidenceBlock(result);
    }
    await writeStateWithArtifacts(session.sessDir, result.state);
    return { ...session, state: result.state };
  });
}

function formatTransportEvidenceBlock(
  result: Extract<Awaited<ReturnType<typeof bindExternalReviewEvidence>>, { status: 'invalid' }>,
): string {
  const vars = {
    reason: result.reason,
    ...(result.vars ?? {}),
    ...(result.obligationId ? { obligationId: result.obligationId } : {}),
  };
  return formatBlocked(
    result.code,
    vars,
    result.rejectionReason
      ? {
          [REVIEW_IDENTITY_REJECTION_FIELD]: {
            reason: result.rejectionReason,
            ...(result.obligationId ? { obligationId: result.obligationId } : {}),
          },
        }
      : undefined,
  );
}
