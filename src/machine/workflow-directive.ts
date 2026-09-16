/** Canonical, presentation-neutral authority for the current workflow directive. */

import type { Phase, SessionState } from '../state/schema.js';

export type WorkflowIntent =
  | 'CAPTURE_TASK'
  | 'CREATE_PLAN'
  | 'CREATE_ARCHITECTURE'
  | 'RUN_PEER_REVIEW'
  | 'APPROVE'
  | 'REQUEST_CHANGES'
  | 'REJECT'
  | 'IMPLEMENT'
  | 'APPROVE_WITH_GOVERNANCE_OVERRIDE'
  | 'EXPORT';

export type WorkflowDirectiveKind =
  'user_action' | 'human_gate' | 'system_work' | 'blocked' | 'terminal';

export type WorkflowDirectiveCode =
  | 'CHOOSE_FLOW'
  | 'PLAN_REQUIRED'
  | 'PLAN_REVIEW_IN_PROGRESS'
  | 'PLAN_DECISION_REQUIRED'
  | 'PLAN_OVERRIDE_REQUIRED'
  | 'PLAN_VALIDATION_IN_PROGRESS'
  | 'IMPLEMENTATION_REQUIRED'
  | 'IMPLEMENTATION_IN_PROGRESS'
  | 'IMPLEMENTATION_VALIDATION_IN_PROGRESS'
  | 'IMPLEMENTATION_REVIEW_IN_PROGRESS'
  | 'IMPLEMENTATION_DECISION_REQUIRED'
  | 'IMPLEMENTATION_OVERRIDE_REQUIRED'
  | 'ARCHITECTURE_IN_PROGRESS'
  | 'ARCHITECTURE_DECISION_REQUIRED'
  | 'ARCHITECTURE_OVERRIDE_REQUIRED'
  | 'PEER_REVIEW_IN_PROGRESS'
  | 'PEER_REVIEW_COMPLETE'
  | 'EXPORT_REQUIRED'
  | 'WORKFLOW_BLOCKED'
  | 'WORKFLOW_REJECTED'
  | 'WORKFLOW_ABORTED'
  | 'WORKFLOW_COMPLETE'
  | 'ARCHITECTURE_COMPLETE';

export interface DirectiveContext {
  readonly reasonCode?: string;
  readonly recovery?: string;
}

export interface WorkflowDirective {
  readonly kind: WorkflowDirectiveKind;
  readonly code: WorkflowDirectiveCode;
  readonly allowedIntents: readonly WorkflowIntent[];
  readonly commands: readonly string[];
  readonly context?: DirectiveContext;
}

function systemWork(code: WorkflowDirectiveCode): WorkflowDirective {
  return { kind: 'system_work', code, allowedIntents: [], commands: [] };
}

function humanGate(code: WorkflowDirectiveCode): WorkflowDirective {
  return {
    kind: 'human_gate',
    code,
    allowedIntents: ['APPROVE', 'REQUEST_CHANGES', 'REJECT'],
    commands: ['/approve', '/request-changes', '/reject'],
  };
}

/**
 * Exhausted review loops end in a governance override gate: the human may
 * still proceed, but only through the explicit override intent. Plain
 * APPROVE is never legal at an override gate.
 */
function overrideGate(code: WorkflowDirectiveCode): WorkflowDirective {
  return {
    kind: 'human_gate',
    code,
    allowedIntents: ['APPROVE_WITH_GOVERNANCE_OVERRIDE', 'REQUEST_CHANGES', 'REJECT'],
    commands: ['/override-approve', '/request-changes', '/reject'],
  };
}

/**
 * Whether the gate at the current position adjudicates an exhausted review
 * loop. The gate type is derived from the workflow position; whether the
 * review actually exhausted its budget is derived from the persisted
 * obligation outcome, never from a second gate registry.
 */
function isReviewExhausted(state: SessionState): boolean {
  if (state.phase === 'PLAN_REVIEW') {
    return state.plan?.reviewCompletion === 'review_exhausted';
  }
  if (state.phase === 'ARCH_REVIEW') {
    return state.architecture?.reviewCompletion === 'review_exhausted';
  }
  if (state.phase === 'EVIDENCE_REVIEW') {
    return state.implementationRework?.exhausted === true;
  }
  return false;
}

function gateDirective(state: SessionState, code: WorkflowDirectiveCode): WorkflowDirective {
  return isReviewExhausted(state)
    ? overrideGate(
        code === 'PLAN_DECISION_REQUIRED'
          ? 'PLAN_OVERRIDE_REQUIRED'
          : code === 'ARCHITECTURE_DECISION_REQUIRED'
            ? 'ARCHITECTURE_OVERRIDE_REQUIRED'
            : 'IMPLEMENTATION_OVERRIDE_REQUIRED',
      )
    : humanGate(code);
}

function terminal(code: WorkflowDirectiveCode): WorkflowDirective {
  return { kind: 'terminal', code, allowedIntents: [], commands: [] };
}

const PHASE_DIRECTIVES: Record<Phase, WorkflowDirective> = {
  READY: {
    kind: 'user_action',
    code: 'CHOOSE_FLOW',
    allowedIntents: ['CAPTURE_TASK', 'CREATE_ARCHITECTURE', 'RUN_PEER_REVIEW'],
    commands: ['/task', '/architecture', '/review'],
  },
  TICKET: {
    kind: 'user_action',
    code: 'PLAN_REQUIRED',
    allowedIntents: ['CREATE_PLAN'],
    commands: ['/plan'],
  },
  PLAN: systemWork('PLAN_REVIEW_IN_PROGRESS'),
  PLAN_REVIEW: humanGate('PLAN_DECISION_REQUIRED'),
  VALIDATION: systemWork('PLAN_VALIDATION_IN_PROGRESS'),
  IMPLEMENTATION: {
    kind: 'user_action',
    code: 'IMPLEMENTATION_REQUIRED',
    allowedIntents: ['IMPLEMENT'],
    commands: ['/implement'],
  },
  IMPL_VALIDATION: systemWork('IMPLEMENTATION_VALIDATION_IN_PROGRESS'),
  IMPL_REVIEW: systemWork('IMPLEMENTATION_REVIEW_IN_PROGRESS'),
  EVIDENCE_REVIEW: humanGate('IMPLEMENTATION_DECISION_REQUIRED'),
  EXPORT_READY: {
    kind: 'user_action',
    code: 'EXPORT_REQUIRED',
    allowedIntents: ['EXPORT'],
    commands: ['/export'],
  },
  COMPLETE: terminal('WORKFLOW_COMPLETE'),
  REJECTED: terminal('WORKFLOW_REJECTED'),
  ABORTED: terminal('WORKFLOW_ABORTED'),
  ARCHITECTURE: systemWork('ARCHITECTURE_IN_PROGRESS'),
  ARCH_REVIEW: humanGate('ARCHITECTURE_DECISION_REQUIRED'),
  ARCH_COMPLETE: terminal('ARCHITECTURE_COMPLETE'),
  PEER_REVIEW: systemWork('PEER_REVIEW_IN_PROGRESS'),
  PEER_REVIEW_COMPLETE: terminal('PEER_REVIEW_COMPLETE'),
};

/** Resolve the directive from complete persisted state without changing it. */
export function resolveWorkflowDirective(state: SessionState): WorkflowDirective {
  // A terminal position is authoritative even when it retains a diagnostic error.
  // In particular, ABORTED retains its error marker for audit provenance.
  const directive = PHASE_DIRECTIVES[state.phase];
  if (directive.kind === 'terminal') return directive;
  if (state.error) {
    return {
      kind: 'blocked',
      code: 'WORKFLOW_BLOCKED',
      allowedIntents: [],
      commands: [],
      context: { reasonCode: state.error.code, recovery: state.error.recoveryHint },
    };
  }
  // The gate type comes from the position; whether this gate requires the
  // explicit override intent comes from the persisted review outcome.
  if (directive.kind === 'human_gate') return gateDirective(state, directive.code);
  return directive;
}
