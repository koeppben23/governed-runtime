/**
 * @module presentation/reason-projection
 * @description Canonical projection of a registered reason code into a
 *              {@link ReasonProjection} for human surfaces.
 *
 * Single projection authority for reason-code recovery UX. Consumers
 * (status-presentation, why-presentation) MUST derive recovery guidance from
 * {@link projectReasonFromRegistry} — never hand-format registry entries.
 *
 * Guardrails:
 * - Only projects codes that exist in the canonical reason registry; unknown
 *   codes project to null (fail-closed, never invented recovery).
 * - `impact` is present ONLY for explicitly migrated reason codes via
 *   {@link REASON_IMPACT}. It is NEVER derived from the technical reason
 *   category: `BlockedCategory` answers "what technical class of error is
 *   this", while `impact` answers "what does this state mean for the user's
 *   workflow" — orthogonal dimensions. Unmigrated codes project no impact.
 * - `headline` and recovery come verbatim from the registry's interpolation
 *   authority (`defaultReasonRegistry.format`), never rephrased here.
 * - The recovery contract guarantees at least one step; the projection
 *   enforces that invariant and never invents steps.
 *
 * @version v1
 */

import { defaultReasonRegistry } from '../config/reasons.js';
import type { BlockedCategory } from '../config/reasons-types.js';
import { PresentationContractError } from './model.js';
import type { HumanExplanation, RecoveryProjection, UserImpact } from './human-projection.js';

/** A reason code projected into human-facing shape. */
export interface ReasonProjection extends HumanExplanation {
  readonly code: string;
  readonly category: BlockedCategory;
  readonly recovery: RecoveryProjection;
}

/**
 * Explicit per-code impact classification. Only codes migrated onto the Human
 * Projection carry an impact. Migrating a code is an explicit, reviewed
 * decision — never a category heuristic. Coverage grows deliberately, code by
 * code.
 */
const REASON_IMPACT: Readonly<Partial<Record<string, UserImpact>>> = {
  VALIDATION_EVIDENCE_REQUIRED: 'verification_incomplete',
  VALIDATION_EVIDENCE_UNVERIFIED: 'verification_incomplete',
  VALIDATION_EVIDENCE_STACK_NO_COMMANDS: 'verification_incomplete',
  PROOFGRAPH_ASSERTION_EVIDENCE_MISSING: 'verification_incomplete',
  PROOFGRAPH_AGGREGATE_SCOPE_UNATTESTED: 'verification_incomplete',
  PROOFGRAPH_ASSERTION_PROVIDER_MISMATCH: 'verification_incomplete',
  FOUR_EYES_ACTOR_MATCH: 'review_required',
  DISCOVERY_DRIFT_BLOCKED: 'workflow_blocked',
};

/**
 * Deterministic impact lookup for explicitly migrated reason codes.
 * Returns undefined (no impact) for unmigrated codes — the projection must
 * fail incomplete, not infer from an insufficient taxonomy.
 */
export function projectImpact(code: string): UserImpact | undefined {
  return REASON_IMPACT[code];
}

/**
 * Split ordered recovery steps into primary + secondary projection.
 *
 * Enforces the recovery-contract invariant that at least one step exists
 * (guaranteed by the reason catalog completeness guard). An empty registry
 * result is a contract violation, not a valid projection.
 */
export function toRecoveryProjection(steps: readonly string[]): RecoveryProjection {
  if (steps.length === 0) {
    throw new PresentationContractError(
      'reason registry must provide at least one recovery step for a registered reason code',
    );
  }
  return { primary: steps[0]!, secondary: steps.slice(1) };
}

/**
 * Project a registered reason code into a {@link ReasonProjection}.
 *
 * Returns null for unregistered codes (fail-closed). `vars` are passed through
 * to the registry's interpolation authority for `{placeholder}` templates.
 * `impact` is present only for explicitly migrated codes.
 */
export function projectReasonFromRegistry(
  code: string,
  vars?: Record<string, string>,
): ReasonProjection | null {
  const reason = defaultReasonRegistry.get(code);
  if (!reason) return null;
  const impact = REASON_IMPACT[code];
  const formatted = defaultReasonRegistry.format(code, vars);
  return {
    code,
    category: reason.category,
    headline: formatted.reason,
    ...(impact ? { impact } : {}),
    recovery: toRecoveryProjection(formatted.recovery),
  };
}
