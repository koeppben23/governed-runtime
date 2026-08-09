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
 * - `impact` classification is deterministic and documented, sourced from the
 *   canonical `category` field plus an explicit per-code override table for
 *   codes whose category is too coarse. Presentation-only — never consumed
 *   for enforcement.
 * - `summary` and `recovery` come verbatim from the registry's interpolation
 *   authority (defaultReasonRegistry.format), never rephrased here.
 *
 * @version v1
 */

import { defaultReasonRegistry } from '../config/reasons.js';
import type { BlockedReason, BlockedCategory } from '../config/reasons-types.js';
import type { HumanExplanation, RecoveryProjection, ProjectedAction } from './human-projection.js';
import { projectActionIntent, type ActionIntent, type UserImpact } from './human-projection.js';

/** A reason code projected into human-facing shape. */
export interface ReasonProjection extends HumanExplanation {
  readonly code: string;
  readonly category: BlockedCategory;
  readonly recovery: RecoveryProjection;
  readonly projectedActions: readonly ProjectedAction[];
}

/** Documented category-to-impact classification for the reason catalog. */
export const CATEGORY_IMPACT: Readonly<Record<BlockedCategory, UserImpact>> = {
  // A required precondition is missing → workflow cannot progress.
  precondition: 'workflow_blocked',
  // A gate/capability rejects the requested command → workflow cannot progress.
  admissibility: 'workflow_blocked',
  // User input is invalid → workflow cannot progress.
  input: 'workflow_blocked',
  // Four-eyes/authorization requires a different actor → an independent
  // reviewer must act.
  identity: 'review_required',
  // Session state is invalid → workflow cannot progress.
  state: 'workflow_blocked',
  // Configuration is invalid or drifted → workflow cannot progress.
  config: 'workflow_blocked',
  // External system (git/filesystem) degradation → capability degraded only.
  adapter: 'degraded_only',
};

/** Per-code impact overrides for codes whose category is too coarse. */
const CODE_IMPACT_OVERRIDES: Readonly<Record<string, UserImpact>> = {
  // Evidence/verification gaps are verification-incomplete, not hard blocks.
  VALIDATION_EVIDENCE_REQUIRED: 'verification_incomplete',
  VALIDATION_EVIDENCE_UNVERIFIED: 'verification_incomplete',
  VALIDATION_EVIDENCE_STACK_NO_COMMANDS: 'verification_incomplete',
  PROOFGRAPH_ASSERTION_EVIDENCE_MISSING: 'verification_incomplete',
  PROOFGRAPH_AGGREGATE_SCOPE_UNATTESTED: 'verification_incomplete',
  PROOFGRAPH_ASSERTION_PROVIDER_MISMATCH: 'verification_incomplete',
};

/** Deterministic impact classification: override table first, then category. */
export function projectImpact(category: BlockedCategory, code: string): UserImpact {
  return CODE_IMPACT_OVERRIDES[code] ?? CATEGORY_IMPACT[category];
}

/**
 * Split ordered recovery steps into primary + secondary projection.
 * Empty input yields an empty primary (the registry guarantees at least one
 * step for every registered code).
 */
export function toRecoveryProjection(steps: readonly string[]): RecoveryProjection {
  return {
    primary: steps[0] ?? '',
    secondary: steps.slice(1),
  };
}

/** Extract slash-command tokens referenced by a recovery/quickFix string. */
function commandTokens(...parts: ReadonlyArray<string | undefined>): string[] {
  const tokens = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    for (const match of part.matchAll(/\/([a-z][a-z0-9-]*)/g)) {
      tokens.add(`/${match[1]}`);
    }
  }
  return [...tokens];
}

/**
 * Projected actions derived deterministically from the canonical reason's
 * quick-fix command and recovery-step command tokens. Deduplicated by intent.
 */
function projectActions(reason: BlockedReason): ProjectedAction[] {
  const projected = new Map<ActionIntent, ProjectedAction>();
  for (const token of commandTokens(reason.quickFixCommand, ...reason.recoverySteps)) {
    const action = projectActionIntent(token);
    if (action && !projected.has(action.intent)) {
      projected.set(action.intent, action);
    }
  }
  return [...projected.values()];
}

/**
 * Project a registered reason code into a {@link ReasonProjection}.
 *
 * Returns null for unregistered codes (fail-closed). `vars` are passed through
 * to the registry's interpolation authority for `{placeholder}` templates.
 */
export function projectReasonFromRegistry(
  code: string,
  vars?: Record<string, string>,
): ReasonProjection | null {
  const reason = defaultReasonRegistry.get(code);
  if (!reason) return null;
  const formatted = defaultReasonRegistry.format(code, vars);
  return {
    code,
    category: reason.category,
    impact: projectImpact(reason.category, code),
    summary: formatted.reason,
    recovery: toRecoveryProjection(formatted.recovery),
    projectedActions: projectActions(reason),
  };
}
