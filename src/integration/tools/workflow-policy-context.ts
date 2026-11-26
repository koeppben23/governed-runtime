/**
 * @module integration/tools/workflow-policy-context
 * @description Policy, rail-context, and workflow-directive projections shared
 * by command tools. Split from `helpers.ts` so the session wrappers stay
 * within the file-size budget.
 *
 * @version v1
 */

import { createRailContext } from '../../adapters/context.js';
import { resolvePolicyFromSnapshot } from '../../config/policy.js';
import type { FlowGuardPolicy } from '../../config/policy.js';
import { resolveWorkflowDirective } from '../../machine/workflow-directive.js';
import { PHASE_LABELS } from '../../presentation/index.js';
import type { RailContext } from '../../rails/types.js';
import type { SessionState } from '../../state/schema.js';
import { IntegrationInvariantError } from '../errors.js';

/**
 * Resolve policy from session state's frozen snapshot.
 *
 * P2c: Accepts only non-null SessionState. All callers guard null before calling.
 * Fail-closed: if policySnapshot is missing (corrupt state), throws instead of
 * silently falling back to a reconstructed policy from a mode string.
 *
 * This is the helper/plugin fallback path. Hydrate owns its own
 * developer-friendly solo fallback via the P21 config chain.
 */
export function resolvePolicyFromState(state: SessionState): FlowGuardPolicy {
  if (state.policySnapshot) {
    return resolvePolicyFromSnapshot(state.policySnapshot);
  }
  // Fail-closed: a hydrated session must always have a policySnapshot.
  // If missing, this is a data integrity error — not a recoverable fallback.
  throw new IntegrationInvariantError(
    'POLICY_SNAPSHOT_MISSING',
    'Session state is missing policySnapshot. This indicates data corruption — ' +
      'every hydrated session must have a frozen policy snapshot.',
  );
}

/**
 * Create a policy-aware RailContext.
 * Merges the production context with the resolved policy.
 */
export function createPolicyContext(policy: FlowGuardPolicy): RailContext {
  return { ...createRailContext(), policy };
}

/**
 * Machine-readable NextAction routing fields appended by
 * {@link enrichWithWorkflowDirective}. These are NOT a rendered footer — user-facing
 * next-action text is owned by the presentation conclusion where a rendered
 * document exists.
 */
export interface WorkflowDirectiveFields {
  directive: ReturnType<typeof resolveWorkflowDirective>;
  phaseLabel: string;
}

/**
 * Enrich an arbitrary value object with a workflow directive.
 *
 * Callers serialize the enriched object only at their response boundary.
 *
 * @param value - The object to enrich.
 * @param state - Current session state for workflow-directive resolution.
 * @returns The value augmented with directive and phaseLabel.
 */
export function enrichWithWorkflowDirective<T extends Record<string, unknown>>(
  value: T,
  state: SessionState,
): T & WorkflowDirectiveFields {
  const directive = resolveWorkflowDirective(state);
  return {
    ...value,
    directive,
    phaseLabel: PHASE_LABELS[state.phase],
  };
}
