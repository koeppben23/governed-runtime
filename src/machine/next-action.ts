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
import { evaluateValidationEvidence } from './validation-evidence.js';

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
  VALIDATION_EVIDENCE_REQUIRED: 'VALIDATION_EVIDENCE_REQUIRED',
  VALIDATION_EVIDENCE_UNVERIFIED: 'VALIDATION_EVIDENCE_UNVERIFIED',
  RUN_IMPLEMENT: 'RUN_IMPLEMENT',
  IMPLEMENTATION_REVIEW_BLOCKED: 'IMPLEMENTATION_REVIEW_BLOCKED',
  RUN_ARCHITECTURE: 'RUN_ARCHITECTURE',
  RUN_REVIEWER_TASK: 'RUN_REVIEWER_TASK',
  REVIEW_STATE_INCOMPLETE: 'REVIEW_STATE_INCOMPLETE',
  SESSION_COMPLETE: 'SESSION_COMPLETE',
} as const;

// ─── Next Action Resolver — Lookup Table ──────────────────────────────────────

/**
 * Phase-specific next-action resolver function.
 *
 * Pure function: inspects state and returns the next action for a given phase.
 * Stateless phases return constant actions; conditional phases inspect state slots.
 */
type NextActionFn = (state: SessionState) => NextAction;

/** Resolver for phases that have self-review (PLAN, ARCHITECTURE). */
function selfReviewAction(
  state: SessionState,
  convergedLabel: string,
  pendingLabel: string,
): NextAction {
  if (state.selfReview !== null && isConverged(state.selfReview)) {
    return {
      code: ACTION_CODES.RUN_CONTINUE,
      text: `${convergedLabel} converged. Run /continue to advance to review`,
      commands: ['/continue'],
    };
  }
  return {
    code: ACTION_CODES.RUN_CONTINUE,
    text: `${pendingLabel} self-review in progress. Run /continue to iterate`,
    commands: ['/continue'],
  };
}

/**
 * Exhaustive lookup table mapping every Phase to its next-action resolver.
 *
 * TypeScript enforces compile-time exhaustiveness: adding a new Phase
 * without adding an entry here is a type error.
 */
const NEXT_ACTION_MAP: Record<Phase, NextActionFn> = {
  // ── Routing ───────────────────────────────────────────────
  READY: () => ({
    code: ACTION_CODES.CHOOSE_FLOW,
    text: [
      'Choose your workflow:',
      '  /ticket        — Start the full development lifecycle (ticket → plan → implement → review)',
      '  /architecture  — Create an Architecture Decision Record (ADR)',
      '  /review        — Generate a compliance review report',
    ].join('\n'),
    commands: ['/ticket', '/architecture', '/review'],
  }),

  // ── Ticket Flow ───────────────────────────────────────────
  TICKET: (state) =>
    state.ticket !== null && state.plan === null
      ? {
          code: ACTION_CODES.RUN_PLAN,
          text: 'Ticket captured. Generate a plan from your ticket with /plan',
          commands: ['/plan'],
        }
      : {
          code: ACTION_CODES.RUN_TICKET,
          text: 'Describe your task with /ticket',
          commands: ['/ticket'],
        },

  PLAN: (state) => selfReviewAction(state, 'Plan', 'Plan'),

  PLAN_REVIEW: () => ({
    code: ACTION_CODES.RUN_REVIEW_DECISION,
    text: 'Review the plan and decide: /review-decision',
    commands: ['/review-decision'],
  }),

  VALIDATION: (state) => {
    // #400: when policy requires validation evidence but no active checks exist,
    // /validate would only fail-closed. Guide the user toward restoring real
    // verification evidence instead of recommending a command that will block.
    const evidence = evaluateValidationEvidence(state);
    if (evidence.blocked && evidence.code !== null) {
      return evidence.code === 'VALIDATION_EVIDENCE_REQUIRED'
        ? {
            code: ACTION_CODES.VALIDATION_EVIDENCE_REQUIRED,
            text:
              'Policy requires validation evidence, but no Discovery-derived verification ' +
              'commands are active. Re-run discovery and /hydrate to detect repo-native checks, ' +
              'or set validationEvidence.allowNoCommands=true in policy (governance approval).',
            commands: ['/hydrate', '/status'],
          }
        : {
            code: ACTION_CODES.VALIDATION_EVIDENCE_UNVERIFIED,
            text:
              'Policy requires validation evidence but Discovery is not trustworthy, so the ' +
              'absence of verification commands cannot be verified (NOT_VERIFIED). Run /hydrate ' +
              'to restore healthy Discovery and clear any blocked discovery health gate.',
            commands: ['/hydrate', '/status'],
          };
    }
    return state.validation.length === 0
      ? {
          code: ACTION_CODES.RUN_VALIDATE,
          text: 'Run validation checks with /validate',
          commands: ['/validate'],
        }
      : {
          code: ACTION_CODES.RUN_CONTINUE,
          text: 'Validation complete. Run /continue to advance',
          commands: ['/continue'],
        };
  },

  IMPLEMENTATION: (state) =>
    state.implementation === null
      ? {
          code: ACTION_CODES.RUN_IMPLEMENT,
          text: 'Execute the implementation with /implement',
          commands: ['/implement'],
        }
      : {
          code: ACTION_CODES.RUN_CONTINUE,
          text: 'Implementation complete. Run /continue to advance',
          commands: ['/continue'],
        },

  IMPL_VALIDATION: (state) =>
    state.implValidation.length === 0
      ? {
          code: ACTION_CODES.RUN_VALIDATE,
          text: 'Implementation recorded. Re-run the verification checks against the fixed code with /check',
          commands: ['/check'],
        }
      : {
          code: ACTION_CODES.RUN_CONTINUE,
          text: 'Post-implementation validation complete. Run /continue to advance',
          commands: ['/continue'],
        },

  IMPL_REVIEW: (state) => {
    const obligations = state.reviewAssurance?.obligations ?? [];
    const implObligations = obligations.filter((o) => o.obligationType === 'implement');
    const last = implObligations.at(-1);
    if (last?.status === 'blocked') {
      if (implObligations.filter((o) => o.status === 'blocked').length >= 3) {
        return {
          code: ACTION_CODES.IMPLEMENTATION_REVIEW_BLOCKED,
          text:
            'Implementation review orchestration failed permanently after repeated blocked review obligations. ' +
            'Abort the session or start over with a new ticket.',
          commands: ['/abort'],
        };
      }
      return {
        code: ACTION_CODES.IMPLEMENTATION_REVIEW_BLOCKED,
        text: `Implementation review obligation is blocked (${last.blockedCode ?? 'unknown'}). Re-run /implement to re-record the implementation and mint a fresh review obligation.`,
        commands: ['/implement'],
      };
    }
    return {
      code: ACTION_CODES.RUN_CONTINUE,
      text: 'Implementation review is pending. Invoke the flowguard-reviewer task, then submit its verdict with flowguard_review_implementation.',
      commands: ['/continue'],
    };
  },

  EVIDENCE_REVIEW: () => ({
    code: ACTION_CODES.RUN_REVIEW_DECISION,
    text: 'Final review: /review-decision',
    commands: ['/review-decision'],
  }),

  COMPLETE: () => ({
    code: ACTION_CODES.SESSION_COMPLETE,
    text: 'Workflow complete. Review readiness and archive evidence when appropriate.',
    commands: [],
  }),

  // ── Architecture Flow ─────────────────────────────────────
  ARCHITECTURE: (state) =>
    state.architecture === null
      ? {
          code: ACTION_CODES.RUN_ARCHITECTURE,
          text: 'Submit your ADR with /architecture',
          commands: ['/architecture'],
        }
      : selfReviewAction(state, 'ADR self-review', 'ADR'),

  ARCH_REVIEW: () => ({
    code: ACTION_CODES.RUN_REVIEW_DECISION,
    text: 'Review the ADR: /review-decision',
    commands: ['/review-decision'],
  }),

  ARCH_COMPLETE: () => ({
    code: ACTION_CODES.SESSION_COMPLETE,
    text: 'Architecture flow complete. Review readiness and archive the ADR when appropriate.',
    commands: [],
  }),

  // ── Review Flow ───────────────────────────────────────────
  REVIEW: () => ({
    code: ACTION_CODES.REVIEW_STATE_INCOMPLETE,
    text: 'Review is incomplete: no pending reviewer obligation or persisted report is available. Inspect status or abort this session; /continue cannot complete it.',
    commands: [],
  }),

  REVIEW_COMPLETE: () => ({
    code: ACTION_CODES.SESSION_COMPLETE,
    text: 'Review flow complete. Review the report and archive it when appropriate.',
    commands: [],
  }),
};

function planReviewAction(phase: Phase, state: SessionState): NextAction | null {
  if (phase !== 'PLAN') return null;
  const latestPlanReview = [...(state.reviewAssurance?.obligations ?? [])]
    .reverse()
    .find((obligation) => obligation.obligationType === 'plan');
  if (latestPlanReview?.status === 'pending') {
    return {
      code: ACTION_CODES.RUN_REVIEWER_TASK,
      text: 'Independent plan review is pending. Invoke the flowguard-reviewer Task, then submit only its verdict with /plan.',
      commands: [],
    };
  }
  if (latestPlanReview?.status === 'fulfilled') {
    return {
      code: ACTION_CODES.RUN_REVIEW_DECISION,
      text: 'Independent plan review evidence is ready. Submit its verdict with /plan.',
      commands: ['/plan'],
    };
  }
  return null;
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Resolve the next action for the current phase and state.
 *
 * Pure function — no side effects. Deterministic for the same inputs.
 * Covers all 14 phases across 3 flows via an exhaustive lookup table.
 * TypeScript enforces compile-time phase exhaustiveness.
 *
 * @param phase - Current session phase.
 * @param state - Current session state (for slot inspection).
 * @returns NextAction with code, guidance text, and available commands.
 */
export function resolveNextAction(phase: Phase, state: SessionState): NextAction {
  const planAction = planReviewAction(phase, state);
  if (planAction) return planAction;
  const pendingStandaloneReview = state.reviewAssurance?.obligations.some(
    (obligation) => obligation.obligationType === 'review' && obligation.status === 'pending',
  );
  if ((phase === 'READY' || phase === 'REVIEW') && pendingStandaloneReview) {
    return {
      code: ACTION_CODES.RUN_REVIEWER_TASK,
      text: 'Independent content review is pending. Invoke the flowguard-reviewer Task, then submit only its verdict with flowguard_review.',
      commands: [],
    };
  }
  return NEXT_ACTION_MAP[phase](state);
}
