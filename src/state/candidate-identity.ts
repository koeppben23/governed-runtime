/**
 * @module state/candidate-identity
 * @description Deterministic verification-candidate identity authority.
 *
 * `candidateId` is the hash of the identity-free candidate definition, so the
 * id is a stable function of the complete definition (assertion capability,
 * report specification, command, kind and scope attestation). Gate boundaries
 * can therefore prove that a persisted candidate still matches the definition
 * it was minted from: an edited definition with a reused id fails closed.
 *
 * @version v1
 */

import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashText } from '../shared/hashing.js';
import type {
  UnidentifiedVerificationCandidate,
  VerificationCandidate,
} from './discovery-schemas.js';

/** Mint the deterministic planner identity for an identity-free candidate. */
export function deriveVerificationCandidateId(
  candidate: UnidentifiedVerificationCandidate,
): string {
  return `vc_${hashText(canonicalJsonStringify(candidate))}`;
}

/**
 * Whether the persisted candidate id still equals the hash of its own
 * definition. False means the definition was edited after minting (or the id
 * was never planner-minted) and the candidate cannot attest anything.
 */
export function isVerificationCandidateBound(candidate: VerificationCandidate): boolean {
  const { candidateId, ...definition } = candidate;
  return candidateId === deriveVerificationCandidateId(definition);
}
