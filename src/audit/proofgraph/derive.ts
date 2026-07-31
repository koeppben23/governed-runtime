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
 */
export function deriveProofGraph(
  state: SessionState,
  providerResults: readonly ProofProviderResult[],
  counterexamples: readonly ProofCounterexample[],
  evaluatedAt: string,
): ProofGraphProjection {
  return evaluateProofGraph(
    {
      claims: state.proofContract?.claims ?? [],
      providerResults,
      counterexamples,
      currentImplementationDigest: state.implementation?.digest ?? null,
    },
    evaluatedAt,
  );
}
