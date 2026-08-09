/**
 * @module presentation/human-projection
 * @description Canonical Human Projection types for FlowGuard user surfaces.
 *
 * The Human Projection is a READ-ONLY, presentation-owned layer between the
 * canonical domain state and the rendered PresentationDocument. It explains
 * governance outcomes to a human (why something is blocked, what to do next)
 * without ever becoming a second authority:
 *
 * - It never re-derives blocker, readiness, evidence, or gate decisions.
 * - It only classifies and re-orders facts that already exist canonically.
 * - A default (lossy) presentation must remain traceable to canonical
 *   semantics through the diagnostic surface.
 *
 * Pure type + pure function layer. Imports only presentation-layer types.
 *
 * @version v1
 */

import type { PresentationAction } from './model.js';

/** Semantic impact a governance state has on the developer's workflow. */
export type UserImpact =
  | 'workflow_blocked'
  | 'verification_incomplete'
  | 'review_required'
  | 'decision_required'
  | 'degraded_only';

/**
 * Human-readable explanation of a governance state.
 *
 * Presentation-only classification: `impact` and `summary` never alter
 * workflow, policy, evidence, or routing.
 */
export interface HumanExplanation {
  readonly impact: UserImpact;
  readonly summary: string;
}

/**
 * Projected recovery guidance for a governance state.
 *
 * `primary` is the first, most direct action; `secondary` holds the remaining
 * ordered steps. `diagnosticNotes` carry diagnostic-only detail that must not
 * be rendered in the default surface.
 */
export interface RecoveryProjection {
  readonly primary: string;
  readonly secondary: readonly string[];
  readonly diagnosticNotes?: string;
}

/** Minimal set of deterministic next-action intents a human may take. */
export type ActionIntent =
  | 'refresh_repository'
  | 'run_validation'
  | 'rerun_review'
  | 'inspect_status'
  | 'inspect_blocker'
  | 'approve'
  | 'request_changes';

/** A projected, canonical-command-backed action a developer can take. */
export interface ProjectedAction {
  readonly intent: ActionIntent;
  /** Short present-tense title for the action. */
  readonly title: string;
  readonly description?: string;
  /** Canonical command action when the intent maps to a slash command. */
  readonly presentationAction?: PresentationAction;
}

/** Titles for each projected action intent. */
const INTENT_TITLES: Record<ActionIntent, string> = {
  refresh_repository: 'Refresh repository discovery and evidence',
  run_validation: 'Run validation checks',
  rerun_review: 'Re-run independent review',
  inspect_status: 'Inspect session status',
  inspect_blocker: 'Explain the blocker',
  approve: 'Approve the current review decision',
  request_changes: 'Request changes',
};

/** Canonical slash commands that back each intent. */
const INTENT_COMMANDS: Record<ActionIntent, readonly string[]> = {
  refresh_repository: ['/hydrate', '/start'],
  run_validation: ['/check', '/validate'],
  rerun_review: ['/review'],
  inspect_status: ['/status'],
  inspect_blocker: ['/why'],
  approve: ['/approve'],
  request_changes: ['/request-changes'],
};

const COMMAND_TO_INTENT = new Map<string, ActionIntent>(
  Object.entries(INTENT_COMMANDS).flatMap(([intent, commands]) =>
    commands.map((command) => [command, intent as ActionIntent]),
  ),
);

/**
 * Project a canonical slash command into a {@link ProjectedAction}.
 *
 * Returns null for invocations that carry no projected intent. The resulting
 * `presentationAction` uses `available` visibility — a projected action is a
 * surface offering, never a recommendation (the conclusion owns that).
 */
export function projectActionIntent(invocation: string): ProjectedAction | null {
  const intent = COMMAND_TO_INTENT.get(invocation);
  if (!intent) return null;
  return {
    intent,
    title: INTENT_TITLES[intent],
    presentationAction: {
      invocation,
      description: INTENT_TITLES[intent],
      visibility: 'available',
    },
  };
}
