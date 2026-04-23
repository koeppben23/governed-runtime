/**
 * @module next-action
 * @description NextAction type and resolver — tells the user what to do next.
 *
 *              Pure function: (phase, state) → NextAction.
 *              SSOT for all user-facing guidance after every FlowGuard response.
 *
 * Design:
 * - NextAction is machine-layer data (code, text, commands).
 * - The integration layer appends it as JSON + footer to every response.
 * - Rails are unaware of NextAction — they produce RailResult, the integration layer
 *   calls resolveNextAction() separately.
 * - Commands in NextAction are the available slash-commands the user can run.
 * - An empty commands array means no further action (terminal).
 *
 * @version v1
 */

import type { Phase, SessionState } from '../state/schema.js';
import { isConverged } from './guards.js';

// ─── Type ─────────────────────────────────────────────────────────────────────

/**
 * Machine-layer guidance for the next user action.
 *
 * @property code - Machine-readable action identifier.
 * @property text - Human-readable guidance text (rendered as footer).
 * @property commands - Available slash-commands the user can run next.
 */
export interface NextAction {
  readonly code: string;
  readonly text: string;
  readonly commands: readonly string[];
}

// ─── Action Codes ─────────────────────────────────────────────────────────────

/** Machine-readable action codes. */
export const ACTION_CODES = {
  CHOOSE_FLOW: 'CHOOSE_FLOW',
  RUN_TICKET: 'RUN_TICKET',
  RUN_PLAN: 'RUN_PLAN',
  RUN_CONTINUE: 'RUN_CONTINUE',
  RUN_REVIEW_DECISION: 'RUN_REVIEW_DECISION',
  RUN_VALIDATE: 'RUN_VALIDATE',
  RUN_IMPLEMENT: 'RUN_IMPLEMENT',
  RUN_ARCHITECTURE: 'RUN_ARCHITECTURE',
  SESSION_COMPLETE: 'SESSION_COMPLETE',
} as const;

// ─── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Resolve the next action for the current phase and state.
 *
 * Pure function — no side effects. Deterministic for the same inputs.
 * Covers all 14 phases across 3 flows.
 *
 * @param phase - Current session phase.
 * @param state - Current session state (for slot inspection).
 * @returns NextAction with code, guidance text, and available commands.
 */
export function resolveNextAction(phase: Phase, state: SessionState): NextAction {
  switch (phase) {
    // ── Routing ───────────────────────────────────────────────
    case 'READY':
      return {
        code: ACTION_CODES.CHOOSE_FLOW,
        text: [
          'Choose your workflow:',
          '  /ticket        — Start the full development lifecycle (ticket → plan → implement → review)',
          '  /architecture  — Create an Architecture Decision Record (ADR)',
          '  /review        — Generate a compliance review report',
        ].join('\n'),
        commands: ['/ticket', '/architecture', '/review'],
      };

    // ── Ticket Flow ───────────────────────────────────────────
    case 'TICKET':
      if (state.ticket !== null && state.plan === null) {
        return {
          code: ACTION_CODES.RUN_PLAN,
          text: 'Ticket captured. Generate a plan from your ticket with /plan',
          commands: ['/plan'],
        };
      }
      return {
        code: ACTION_CODES.RUN_TICKET,
        text: 'Describe your task with /ticket',
        commands: ['/ticket'],
      };

    case 'PLAN':
      if (state.selfReview !== null) {
        if (isConverged(state.selfReview)) {
          return {
            code: ACTION_CODES.RUN_CONTINUE,
            text: 'Plan converged. Run /continue to advance to review',
            commands: ['/continue'],
          };
        }
        return {
          code: ACTION_CODES.RUN_CONTINUE,
          text: 'Plan self-review in progress. Run /continue to iterate',
          commands: ['/continue'],
        };
      }
      return {
        code: ACTION_CODES.RUN_CONTINUE,
        text: 'Plan self-review in progress. Run /continue to iterate',
        commands: ['/continue'],
      };

    case 'PLAN_REVIEW':
      return {
        code: ACTION_CODES.RUN_REVIEW_DECISION,
        text: 'Review the plan and decide: /review-decision',
        commands: ['/review-decision'],
      };

    case 'VALIDATION':
      if (state.validation.length === 0) {
        return {
          code: ACTION_CODES.RUN_VALIDATE,
          text: 'Run validation checks with /validate',
          commands: ['/validate'],
        };
      }
      return {
        code: ACTION_CODES.RUN_CONTINUE,
        text: 'Validation complete. Run /continue to advance',
        commands: ['/continue'],
      };

    case 'IMPLEMENTATION':
      if (state.implementation === null) {
        return {
          code: ACTION_CODES.RUN_IMPLEMENT,
          text: 'Execute the implementation with /implement',
          commands: ['/implement'],
        };
      }
      return {
        code: ACTION_CODES.RUN_CONTINUE,
        text: 'Implementation complete. Run /continue to advance',
        commands: ['/continue'],
      };

    case 'IMPL_REVIEW':
      return {
        code: ACTION_CODES.RUN_CONTINUE,
        text: 'Run /continue to advance',
        commands: ['/continue'],
      };

    case 'EVIDENCE_REVIEW':
      return {
        code: ACTION_CODES.RUN_REVIEW_DECISION,
        text: 'Final review: /review-decision',
        commands: ['/review-decision'],
      };

    case 'COMPLETE':
      return {
        code: ACTION_CODES.SESSION_COMPLETE,
        text: 'Workflow complete. All evidence archived.',
        commands: [],
      };

    // ── Architecture Flow ─────────────────────────────────────
    case 'ARCHITECTURE':
      if (state.architecture === null) {
        return {
          code: ACTION_CODES.RUN_ARCHITECTURE,
          text: 'Submit your ADR with /architecture',
          commands: ['/architecture'],
        };
      }
      if (state.selfReview !== null) {
        if (isConverged(state.selfReview)) {
          return {
            code: ACTION_CODES.RUN_CONTINUE,
            text: 'ADR self-review converged. Run /continue to advance to review',
            commands: ['/continue'],
          };
        }
        return {
          code: ACTION_CODES.RUN_CONTINUE,
          text: 'ADR self-review in progress. Run /continue to iterate',
          commands: ['/continue'],
        };
      }
      return {
        code: ACTION_CODES.RUN_CONTINUE,
        text: 'ADR self-review in progress. Run /continue to iterate',
        commands: ['/continue'],
      };

    case 'ARCH_REVIEW':
      return {
        code: ACTION_CODES.RUN_REVIEW_DECISION,
        text: 'Review the ADR: /review-decision',
        commands: ['/review-decision'],
      };

    case 'ARCH_COMPLETE':
      return {
        code: ACTION_CODES.SESSION_COMPLETE,
        text: 'Architecture flow complete. ADR archived.',
        commands: [],
      };

    // ── Review Flow ───────────────────────────────────────────
    case 'REVIEW':
      return {
        code: ACTION_CODES.RUN_CONTINUE,
        text: 'Review report generated. Run /continue to complete',
        commands: ['/continue'],
      };

    case 'REVIEW_COMPLETE':
      return {
        code: ACTION_CODES.SESSION_COMPLETE,
        text: 'Review flow complete. Report archived.',
        commands: [],
      };
  }
}
