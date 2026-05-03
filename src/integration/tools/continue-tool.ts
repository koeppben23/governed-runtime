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

import { withMutableSession, formatBlocked, appendNextAction } from './helpers.js';
import { USER_GATES, TERMINAL } from '../../machine/topology.js';
import type { ToolDefinition } from './helpers.js';

const PHASE_GUIDANCE: Record<string, { status: string; command?: string; commands?: string[] }> = {
  READY: {
    status: 'Session ready. Choose a flow.',
    commands: ['/task', '/architecture', '/review'],
  },
  TICKET: {
    status: 'Task captured. Generate an implementation plan.',
    command: '/plan',
  },
  PLAN: {
    status:
      'Plan is under review. Use /plan to submit a self-review verdict, or wait for review convergence.',
    command: '/plan',
  },
  VALIDATION: {
    status: 'Validation checks are pending. Run /check to execute them.',
    command: '/check',
  },
  IMPLEMENTATION: {
    status: 'Plan approved. Execute the implementation.',
    command: '/implement',
  },
  IMPL_REVIEW: {
    status: 'Implementation review is pending. Submit a review verdict.',
    command: '/implement',
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
    'explicit decision options.',
  args: {},
  async execute(_args, context) {
    try {
      const { state, sessDir } = await withMutableSession(context);
      const { phase } = state;

      // User-gate phases require explicit human decision
      if (USER_GATES.has(phase)) {
        const guidance: Record<string, string[]> = {
          PLAN_REVIEW: ['/approve', '/request-changes', '/reject'],
          EVIDENCE_REVIEW: ['/approve', '/request-changes', '/reject'],
          ARCH_REVIEW: ['/approve', '/request-changes', '/reject'],
        };
        return appendNextAction(
          JSON.stringify({
            phase,
            status: `User gate active at ${phase}. A human decision is required.`,
            next: guidance[phase]?.join(', ') ?? '/approve, /request-changes, /reject',
            _continue: { action: 'manual_decision' },
          }),
          state,
        );
      }

      // Terminal phases — workflow complete
      if (TERMINAL.has(phase)) {
        return appendNextAction(
          JSON.stringify({
            phase,
            status: 'Workflow complete.',
            next: '/export',
            _continue: { action: 'terminal' },
          }),
          state,
        );
      }

      // READY: ambiguous — block with options
      if (phase === 'READY') {
        return formatBlocked('CONTINUE_AMBIGUOUS', {
          phase,
          reason: 'Multiple flows available from READY. Choose one explicitly.',
        });
      }

      // All other phases: lookup guidance
      const guidance = PHASE_GUIDANCE[phase];
      if (guidance) {
        return appendNextAction(
          JSON.stringify({
            phase,
            status: guidance.status,
            next: guidance.command ?? '',
            commands: guidance.commands,
            _continue: { action: 'deterministic' },
          }),
          state,
        );
      }

      // Unknown phase — fail closed
      return formatBlocked('CONTINUE_UNKNOWN_PHASE', { phase });
    } catch (err) {
      return JSON.stringify({ error: true, message: String(err) });
    }
  },
};
