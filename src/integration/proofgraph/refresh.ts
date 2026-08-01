/**
 * @module integration/proofgraph/refresh
 * @description Refresh the persisted ProofGraph from structured declarations and evidence.
 *
 * This is intentionally declaration-driven: it never derives claims from free-form
 * ticket, plan, ADR, review, or implementation text.
 */

import { summarizeProofGraph } from '../../audit/proofgraph/summary.js';
import type { ProofGraphProjection } from '../../state/proofgraph.js';
import type { SessionState } from '../../state/schema.js';
import { bindMutationEvidence } from '../../audit/proofgraph/mutation-binder.js';
import {
  evaluateStructuralSurfaces,
  bindStructuralEvidence,
  surfaceDigestMap,
} from './structural-provider.js';
import { resolveVerifiedMutationVerdicts } from './mutation-provider.js';

/**
 * Derive the current compact projection. The empty projection is intentional when
 * no structured contract exists: it records missing ProofGraph coverage rather
 * than inventing claims from unstructured workflow artifacts.
 */
export async function refreshProofGraph(
  state: SessionState,
  evaluatedAt: string,
): Promise<ProofGraphProjection> {
  const structuralSurfaces = evaluateStructuralSurfaces();
  const mutationVerdicts = await resolveVerifiedMutationVerdicts(
    state.binding.worktree,
    state.mutationAttempts,
  );
  return summarizeProofGraph(state, evaluatedAt, {
    providerResults: [
      ...bindStructuralEvidence(state, structuralSurfaces, evaluatedAt),
      ...bindMutationEvidence(state, mutationVerdicts, evaluatedAt),
    ],
    surfaceDigests: surfaceDigestMap(structuralSurfaces),
  }).projection;
}
