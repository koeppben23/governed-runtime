/**
 * @module audit/proofgraph/derive
 * @description Derive a ProofGraph projection from a session's persisted contract.
 *
 * Bridges SessionState to the pure evaluator: declared claims come from the
 * in-session contract, the current implementation revision comes from
 * implementation evidence, and executed provider results / counterexamples are
 * supplied by the caller (providers). No side effects; deterministic for
 * identical inputs.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import type {
  ProofGraphProjection,
  ProofProviderResult,
  ProofCounterexample,
} from '../../state/proofgraph.js';
import { evaluateProofGraph } from './evaluate.js';

/**
 * Derive the ProofGraph projection for a session.
 *
 * @param state           Session state (source of declared claims and impl digest).
 * @param providerResults Executed provider results across claims.
 * @param counterexamples Executed counterexamples across claims.
 * @param evaluatedAt     ISO-8601 evaluation timestamp (caller-supplied for determinism).
 * @param currentSurfaceDigests Current digest per surface id for `surface_set`-bound results.
 * @param claimDiagnostics Per-claim binding diagnostic codes persisted alongside the projection.
 */
export function deriveProofGraph(
  state: SessionState,
  providerResults: readonly ProofProviderResult[],
  counterexamples: readonly ProofCounterexample[],
  evaluatedAt: string,
  opts?: {
    currentSurfaceDigests?: Readonly<Record<string, string>>;
    claimDiagnostics?: Readonly<Record<string, string>>;
  },
): ProofGraphProjection {
  const standaloneClaims = new Map(
    state.standaloneReviewEvidence.flatMap((evidence) =>
      evidence.task.claims.map((claim) => [claim.claimId, claim] as const),
    ),
  );
  const surfaceDigests = opts?.currentSurfaceDigests ?? {};
  const diagnostics = opts?.claimDiagnostics;
  const base = evaluateProofGraph(
    {
      claims: [...(state.proofContract?.claims ?? []), ...standaloneClaims.values()],
      providerResults,
      counterexamples,
      currentImplementationDigest: state.implementation?.digest ?? null,
      currentPlanDigest: state.plan?.current.digest ?? null,
      currentSurfaceDigests: surfaceDigests,
    },
    evaluatedAt,
  );
  if (diagnostics && Object.keys(diagnostics).length > 0) {
    return { ...base, claimDiagnostics: diagnostics };
  }
  return base;
}
