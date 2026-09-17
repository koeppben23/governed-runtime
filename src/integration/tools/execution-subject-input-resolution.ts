/**
 * @module integration/tools/execution-subject-input-resolution
 * @description Resolves execution-subject inputs without weakening candidate identity.
 */

import type { SessionState } from '../../state/schema.js';
import type {
  ExecutionSubjectInput,
  VerificationCandidate,
} from '../../state/discovery-schemas.js';

export type ExecutionSubjectResolution =
  | { readonly kind: 'resolved'; readonly inputs: readonly ExecutionSubjectInput[] }
  | { readonly kind: 'unavailable'; readonly detail: string };

export function resolveExecutionSubjectInputs(
  state: SessionState,
  candidate: VerificationCandidate,
): ExecutionSubjectResolution {
  const inputs = state.executionSubjectInputsByCandidateId?.[candidate.candidateId];
  return inputs && inputs.length > 0
    ? { kind: 'resolved', inputs }
    : {
        kind: 'unavailable',
        detail:
          `no candidate-specific execution subject inputs for '${candidate.candidateId}' — ` +
          're-run flowguard_hydrate to restore the exact candidate binding',
      };
}
