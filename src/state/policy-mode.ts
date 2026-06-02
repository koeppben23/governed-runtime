/**
 * @module state/policy-mode
 * @description Canonical SSOT for FlowGuard policy mode values.
 *
 * Why this lives in the state layer (not config): the PolicySnapshot embedded in
 * SessionState (see {@link ./evidence-policy.ts}) must validate `mode`/`requestedMode`
 * with a closed enum, and the innermost state layer MUST NOT depend on the outer
 * config layer. Defining the canonical enum here lets state validate fail-closed,
 * while config (which already depends on state schema types) re-exports it — keeping
 * a single runtime authority with no duplicate/parallel mode definition.
 *
 * @version v1
 */

import { z } from 'zod';

/**
 * All supported FlowGuard policy modes, in canonical order.
 *
 * This is the one place a new mode is added. Every validator, schema, and preset
 * derives from this tuple — there is no parallel list anywhere else.
 */
export const POLICY_MODES = ['solo', 'team', 'team-ci', 'regulated'] as const;

/** Closed enum schema for a policy mode. Unknown values fail closed (ZodError). */
export const PolicyModeSchema = z.enum(POLICY_MODES);

/** Supported policy modes. */
export type PolicyMode = z.infer<typeof PolicyModeSchema>;

/**
 * Central policy minimum modes (team-ci is intentionally excluded).
 *
 * A central bundle may not pin a CI-conditional mode as a floor, so the minimum
 * is constrained to the non-conditional subset.
 */
export const CENTRAL_MINIMUM_MODES = ['solo', 'team', 'regulated'] as const;

/** Closed enum schema for a central minimum mode. */
export const CentralMinimumModeSchema = z.enum(CENTRAL_MINIMUM_MODES);

/** Central policy minimum modes (team-ci is intentionally excluded). */
export type CentralMinimumMode = z.infer<typeof CentralMinimumModeSchema>;

/**
 * Type guard: whether an unknown value is a valid policy mode.
 *
 * Fail-closed by construction — anything not in {@link POLICY_MODES} returns false.
 */
export function isPolicyMode(value: unknown): value is PolicyMode {
  return PolicyModeSchema.safeParse(value).success;
}
