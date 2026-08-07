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

import type { VerificationCandidate, ExecutionSubjectInput } from '../state/discovery-schemas.js';

export interface PlannedVerificationCandidate {
  readonly candidate: VerificationCandidate;
  readonly executionProfileId?: string;
  readonly executionSubjectInputs: readonly ExecutionSubjectInput[];
}
