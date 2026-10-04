/**
 * @module discovery/verification-candidate-planned
 * @description Planned VerificationCandidate with explicit execution profile identity.
 *
 * The planner carries profileId alongside the candidate so downstream modules
 * (runtime resolution, status projection) can look up profile-specific data
 * without inferring identity from source strings.
 *
 * VerificationCandidate remains the provider-neutral persisted state form.
 * PlannedVerificationCandidate is planner-internal and not persisted.
 *
 * @version v1
 */

import type {
  UnidentifiedVerificationCandidate,
  VerificationCandidate,
  ExecutionSubjectInput,
} from '../state/discovery-schemas.js';

/** Planner-internal planned candidate before identity minting. */
export interface PlannedVerificationCandidate {
  readonly candidate: UnidentifiedVerificationCandidate;
  readonly executionProfileId?: string;
  /** Repo-native script body used only to attest full-check scope. Never persisted or executed. */
  readonly scopeSemanticCommand?: string;
  readonly executionSubjectInputs: readonly ExecutionSubjectInput[];
}

/** Planner-final planned candidate carrying the minted persisted identity. */
export interface IdentifiedPlannedVerificationCandidate extends Omit<
  PlannedVerificationCandidate,
  'candidate'
> {
  readonly candidate: VerificationCandidate;
}
