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
  formatError,
  appendNextAction,
  writeStateWithArtifacts,
} from './helpers.js';
import { USER_GATES, TERMINAL } from '../../machine/topology.js';
import type { MutableSession, ToolDefinition } from './helpers.js';
import type { SessionState } from '../../state/schema.js';
import { bindExternalReviewEvidence } from '../review/transport-evidence.js';
import { REVIEW_IDENTITY_REJECTION_FIELD } from '../../shared/flowguard-identifiers.js';

const PHASE_GUIDANCE: Record<
  string,
  { status: string; command?: string; commands?: string[]; next?: string }
> = {
  TICKET: {
    status: 'Ticket captured. Continue with /plan.',
    command: '/plan',
  },
  PLAN: {
    status: 'Plan phase active. Submit or revise the implementation plan via /plan.',
    command: '/plan',
  },
  VALIDATION: {
    status: 'Validation phase active. Run required checks and submit results via /check.',
    command: '/check',
  },
  IMPLEMENTATION: {
    status: 'Plan approved. Execute the implementation.',
    command: '/implement',
  },
  IMPL_REVIEW: {
    status:
      'Implementation review is pending. Invoke the flowguard-reviewer via the Task tool, then submit its verdict with flowguard_review_implementation.',
    next: 'Invoke the flowguard-reviewer via the Task tool, then submit its verdict with flowguard_review_implementation.',
  },
  ARCHITECTURE: {
    status:
      'Architecture review is pending. Use /architecture with required review findings when review evidence is available.',
    command: '/architecture',
  },
  REVIEW: {
    status: 'Standalone review phase active. Call /review to evaluate the session.',
    command: '/review',
  },
  COMPLETE: {
    status: 'Workflow complete. Use /export to create an audit package.',
    command: '/export',
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
  const guidance: Record<string, string[]> = {
    PLAN_REVIEW: ['/approve', '/request-changes', '/reject'],
    EVIDENCE_REVIEW: ['/approve', '/request-changes', '/reject'],
    ARCH_REVIEW: ['/approve', '/request-changes', '/reject'],
  };
  return appendNextAction(
    JSON.stringify({
      phase: state.phase,
      status: `User gate active at ${state.phase}. A human decision is required.`,
      next: guidance[state.phase]?.join(', ') ?? '/approve, /request-changes, /reject',
      _continue: { action: 'manual_decision' },
    }),
    state,
  );
}

function formatTerminalGuidance(state: SessionState): string {
  // Aborted sessions are terminal (phase=COMPLETE) but are NOT clean
  // completions: do not route them to /export as an audit package. /export is
  // additionally fail-closed against aborted sessions in archive-tool.ts.
  const aborted = state.error?.code === 'ABORTED';
  return appendNextAction(
    JSON.stringify({
      phase: state.phase,
      status: aborted ? 'Session aborted — not a clean completion.' : 'Workflow complete.',
      next: aborted ? '/review' : '/export',
      _continue: { action: 'terminal' },
    }),
    state,
  );
}

function formatDeterministicGuidance(
  state: SessionState,
  guidance: { status: string; command?: string; commands?: string[]; next?: string },
): string {
  return appendNextAction(
    JSON.stringify({
      phase: state.phase,
      status: guidance.status,
      next: guidance.next ?? guidance.command ?? '',
      commands: guidance.commands,
      _continue: { action: 'deterministic' },
    }),
    state,
  );
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
