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
 * - `headline`, `explanation`, and `impact` come from the canonical copy
 *   authority ({@link REASON_COPY}) for migrated codes. `impact` is NEVER
 *   derived from the technical reason category: `BlockedCategory` answers
 *   "what technical class of error is this", while `impact` answers "what
 *   does this state mean for the user's workflow" — orthogonal dimensions.
 * - For migrated codes, the registry-verbatim interpolated message is never
 *   lost: it is preserved as `canonicalMessage` so diagnostic surfaces can
 *   render the exact authoritative text.
 * - For unmigrated codes, `headline` and recovery come verbatim from the
 *   registry's interpolation authority (`defaultReasonRegistry.format`),
 *   never rephrased here.
 * - The recovery contract guarantees at least one step; the projection
 *   enforces that invariant and never invents steps.
 *
 * @version v2
 */

import { defaultReasonRegistry } from '../config/reasons.js';
import type { BlockedCategory } from '../config/reasons-types.js';
import { PresentationContractError } from './model.js';
import type { HumanExplanation, RecoveryProjection, UserImpact } from './human-projection.js';
import { isMigratedReasonCode, lookupReasonCopy } from './reason-copy.js';

/** A reason code projected into human-facing shape. */
export interface ReasonProjection extends HumanExplanation {
  readonly code: string;
  readonly category: BlockedCategory;
  /** Registry-verbatim interpolated message for migrated codes. */
  readonly canonicalMessage?: string;
  readonly recovery: RecoveryProjection;
}

/**
 * Deterministic impact lookup for explicitly migrated reason codes.
 * Derived from the canonical copy table — the single migrated-set authority.
 * Returns undefined (no impact) for unmigrated codes — the projection must
 * fail incomplete, not infer from an insufficient taxonomy.
 */
export function projectImpact(code: string): UserImpact | undefined {
  return lookupReasonCopy(code)?.impact;
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
  const formatted = defaultReasonRegistry.format(code, vars);
  const copy = lookupReasonCopy(code);
  const headline = copy?.headline ?? formatted.reason;
  const canonicalMessage = isMigratedReasonCode(code) ? formatted.reason : undefined;
  return {
    code,
    category: reason.category,
    headline,
    ...(copy?.explanation ? { explanation: copy.explanation } : {}),
    ...(canonicalMessage !== undefined ? { canonicalMessage } : {}),
    ...(copy?.impact ? { impact: copy.impact } : {}),
    recovery: toRecoveryProjection(formatted.recovery),
  };
}

/**
 * Extract the optional canonical detail fields (canonicalMessage + explanation)
 * of a reason projection for embedding in a `BlockerSection`.
 *
 * Consumers spread the result directly so migrated codes keep the
 * registry-verbatim message and human-authored explanation on every diagnostic
 * surface without duplicating the projection branch. Returns an empty object
 * for null projections (fail-closed: never fabricates copy).
 */
export function projectDetailFields(projection: ReasonProjection | null): {
  canonicalMessage?: string;
  explanation?: string;
} {
  if (!projection) return {};
  return {
    ...(projection.canonicalMessage ? { canonicalMessage: projection.canonicalMessage } : {}),
    ...(projection.explanation ? { explanation: projection.explanation } : {}),
  };
}
