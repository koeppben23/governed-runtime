/**
 * @module presentation/directive-copy
 * @description Human-readable projection of canonical workflow-directive codes.
 *
 * The machine-owned WorkflowDirective is deliberately copy-free: it carries the
 * authoritative code, allowed intents, and commands. This module is the single
 * presentation-owned mapping from those codes to short labels and descriptions.
 * It never adds, removes, renames, or reorders commands and never touches
 * machine authority.
 *
 * TypeScript enforces exhaustiveness via `satisfies Record<WorkflowDirectiveCode, ...>`:
 * adding a directive code without adding its copy is a type error.
 *
 * @version v1
 */

import type { WorkflowDirectiveCode } from '../machine/workflow-directive.js';

export interface DirectiveCopy {
  /** Short sentence-case label for rendered conclusions and summaries. */
  readonly label: string;
  /** One-sentence orientation for help and detail surfaces. */
  readonly description: string;
}

export const DIRECTIVE_COPY = {
  CHOOSE_FLOW: {
    label: 'Choose your workflow.',
    description: 'Start with /task, /architecture, or /review.',
  },
  PLAN_REQUIRED: {
    label: 'Plan required.',
    description: 'Generate a plan from the captured task with /plan.',
  },
  PLAN_REVIEW_IN_PROGRESS: {
    label: 'Independent plan review in progress.',
    description: 'No action required; FlowGuard drives the plan review loop.',
  },
  PLAN_DECISION_REQUIRED: {
    label: 'Plan decision required.',
    description: 'Review the plan and choose /approve, /request-changes, or /reject.',
  },
  PLAN_OVERRIDE_REQUIRED: {
    label: 'Plan review exhausted: governance override required.',
    description:
      'The reviewer did not accept the plan. Choose /override-approve to accept anyway with a recorded override, or /request-changes or /reject.',
  },
  PLAN_VALIDATION_IN_PROGRESS: {
    label: 'Plan validation in progress.',
    description: 'No action required; FlowGuard runs the approved validation automatically.',
  },
  IMPLEMENTATION_REQUIRED: {
    label: 'Implementation required.',
    description: 'Execute the approved plan with /implement.',
  },
  IMPLEMENTATION_IN_PROGRESS: {
    label: 'Implementation in progress.',
    description: 'No action required; FlowGuard validates and reviews the recorded implementation.',
  },
  IMPLEMENTATION_VALIDATION_IN_PROGRESS: {
    label: 'Implementation validation in progress.',
    description: 'No action required; FlowGuard re-runs the verification checks automatically.',
  },
  IMPLEMENTATION_REVIEW_IN_PROGRESS: {
    label: 'Independent implementation review in progress.',
    description: 'No action required; FlowGuard drives the implementation review loop.',
  },
  IMPLEMENTATION_DECISION_REQUIRED: {
    label: 'Implementation decision required.',
    description: 'Review the implementation and choose /approve, /request-changes, or /reject.',
  },
  IMPLEMENTATION_OVERRIDE_REQUIRED: {
    label: 'Implementation review exhausted: governance override required.',
    description:
      'The reviewer did not accept the implementation. Choose /override-approve to accept anyway with a recorded override, or /request-changes or /reject.',
  },
  ARCHITECTURE_IN_PROGRESS: {
    label: 'Architecture review in progress.',
    description: 'No action required; FlowGuard drives the ADR review loop.',
  },
  ARCHITECTURE_DECISION_REQUIRED: {
    label: 'Architecture decision required.',
    description: 'Review the ADR and choose /approve, /request-changes, or /reject.',
  },
  ARCHITECTURE_OVERRIDE_REQUIRED: {
    label: 'Architecture review exhausted: governance override required.',
    description:
      'The reviewer did not accept the ADR. Choose /override-approve to accept anyway with a recorded override, or /request-changes or /reject.',
  },
  PEER_REVIEW_IN_PROGRESS: {
    label: 'Peer review in progress.',
    description: 'No action required; FlowGuard reviews the foreign target.',
  },
  PEER_REVIEW_COMPLETE: {
    label: 'Peer review complete.',
    description: 'Review the report; this flow has no approval gate.',
  },
  EXPORT_REQUIRED: {
    label: 'Export required.',
    description: 'Materialize the audit package with /export to complete the workflow.',
  },
  WORKFLOW_BLOCKED: {
    label: 'Workflow blocked.',
    description: 'Resolve the blocker described in the directive context.',
  },
  WORKFLOW_REJECTED: {
    label: 'Workflow rejected.',
    description: 'The governed work was rejected and the session is closed.',
  },
  WORKFLOW_ABORTED: {
    label: 'Workflow aborted.',
    description: 'The session was terminated before completion.',
  },
  WORKFLOW_COMPLETE: {
    label: 'Workflow complete.',
    description: 'All required steps are complete.',
  },
  ARCHITECTURE_COMPLETE: {
    label: 'Architecture flow complete.',
    description: 'The architecture decision record is accepted.',
  },
} satisfies Record<WorkflowDirectiveCode, DirectiveCopy>;

/** Short human-readable label for a canonical directive code. */
export function directiveLabel(code: WorkflowDirectiveCode): string {
  return DIRECTIVE_COPY[code].label;
}

/** One-sentence orientation for a canonical directive code. */
export function directiveDescription(code: WorkflowDirectiveCode): string {
  return DIRECTIVE_COPY[code].description;
}
