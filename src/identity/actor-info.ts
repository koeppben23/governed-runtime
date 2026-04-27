/**
 * @module identity/actor-info
 * @description Canonical actor identity and assurance utilities.
 *
 * SSOT for ActorInfo type (imported from state/evidence.js) plus
 * assurance comparison helpers used by decision enforcement paths.
 *
 * Assurance tier ordering: best_effort < claim_validated < idp_verified
 *
 * @version v1
 */

export type ActorAssurance = 'best_effort' | 'claim_validated' | 'idp_verified';

/**
 * Ordinal assurance tier values for comparison.
 * Higher ordinal = stronger assurance.
 */
const ASSURANCE_ORDINAL: Record<ActorAssurance, number> = {
  best_effort: 0,
  claim_validated: 1,
  idp_verified: 2,
};

/** All valid assurance tiers in ordinal order (weakest → strongest). */
export const ASSURANCE_TIERS: readonly ActorAssurance[] = [
  'best_effort',
  'claim_validated',
  'idp_verified',
];

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
  const actualOrdinal = actual ? ASSURANCE_ORDINAL[actual] : -1;
  const requiredOrdinal = ASSURANCE_ORDINAL[required];
  return actualOrdinal >= requiredOrdinal;
}

/**
 * Compare two assurance tiers.
 *
 * @returns negative if a < b, zero if equal, positive if a > b.
 */
export function compareActorAssurance(a: ActorAssurance | undefined, b: ActorAssurance): number {
  const aOrdinal = a ? ASSURANCE_ORDINAL[a] : -1;
  const bOrdinal = ASSURANCE_ORDINAL[b];
  return aOrdinal - bOrdinal;
}
