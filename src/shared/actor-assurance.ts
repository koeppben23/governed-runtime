/**
 * @module shared/actor-assurance
 * @description The single actor-assurance vocabulary authority.
 *
 * This module owns the tier tuple, the derived TypeScript union, the closed Zod
 * schema, and the ordinal comparison helpers. The tuple IS the ordering: every
 * comparison derives from its index, so vocabulary and ordinal order can never
 * diverge. No other production module defines the tier list, a
 * `'best_effort' | 'claim_validated' | 'idp_verified'` union, or a literal
 * `z.enum([...])` of the tiers (enforced by
 * `architecture/__tests__/actor-assurance-ssot.test.ts`).
 *
 * Schema/vocabulary placement follows `shared/policy-idp-config.ts`: the state
 * leaf validates fail-closed against this schema without depending on the
 * identity or config layers.
 *
 * @version v1
 */

import { z } from 'zod';

/**
 * All actor assurance tiers in canonical ordinal order (weakest → strongest).
 *
 * This is the one place a tier is added. Adding a tier here also extends the
 * schema and the ordinal scale in the same change.
 */
export const ACTOR_ASSURANCE_TIERS = ['best_effort', 'claim_validated', 'idp_verified'] as const;

/** Actor assurance tier. */
export type ActorAssurance = (typeof ACTOR_ASSURANCE_TIERS)[number];

/** Closed enum schema for an actor assurance tier. Unknown values fail closed. */
export const ActorAssuranceSchema = z.enum(ACTOR_ASSURANCE_TIERS);

/**
 * Type guard: whether an unknown value is a valid actor assurance tier.
 *
 * Fail-closed by construction — anything outside {@link ACTOR_ASSURANCE_TIERS}
 * returns false. Used by policy resolution to decide whether a config override
 * is admissible.
 */
export function isActorAssurance(value: unknown): value is ActorAssurance {
  return ActorAssuranceSchema.safeParse(value).success;
}

/**
 * Ordinal position of a tier in the canonical tuple.
 *
 * `undefined` (no resolved actor) is below every tier. This function is the
 * ONLY ordinal authority: there is no parallel map or rank table.
 */
function assuranceOrdinal(value: ActorAssurance | undefined): number {
  return value === undefined ? -1 : ACTOR_ASSURANCE_TIERS.indexOf(value);
}

/**
 * Check whether an actor's assurance meets or exceeds a required minimum.
 *
 * @param actual - The actor's resolved assurance tier.
 * @param required - The minimum required assurance tier for the operation.
 * @returns true if actual ≥ required in the assurance ordinal scale.
 */
export function isAssuranceAtLeast(
  actual: ActorAssurance | undefined,
  required: ActorAssurance,
): boolean {
  return assuranceOrdinal(actual) >= assuranceOrdinal(required);
}

/**
 * Compare two assurance tiers.
 *
 * @returns negative if a < b, zero if equal, positive if a > b.
 */
export function compareActorAssurance(a: ActorAssurance | undefined, b: ActorAssurance): number {
  return assuranceOrdinal(a) - assuranceOrdinal(b);
}
