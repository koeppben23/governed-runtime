/**
 * @module audit/proofgraph/evaluate
 * @description Deterministic ProofGraph evaluator.
 *
 * Pure projection: given declared claims, executed provider results, and
 * executed counterexamples — all bound to implementation revisions — it assigns
 * each claim an explicit verification state and computes revision freshness.
 * Identical persisted inputs always yield an identical projection (claims are
 * sorted by `claimId`).
 *
 * This module derives state only; it does not decide policy blocking. Whether a
 * `PROVEN` claim may gate a workflow (e.g. `fact`-only blocking) is a separate
 * policy-layer decision and is intentionally not encoded here.
 *
 * Verification-state precedence (first match wins):
 *   1. missing provenance                 -> NOT_VERIFIED
 *   2. a counterexample contradicted it   -> CONTRADICTED
 *   3. a provider errored (execution)     -> BLOCKED
 *   4. a required provider was unavailable-> NOT_VERIFIED
 *   5. a provider reported a failure      -> UNPROVEN
 *   6. fresh (digest-bound) passing evidence of any kind -> PROVEN
 *   7. only stale (superseded binding) passing evidence -> STALE
 *   8. otherwise (declared, no evidence)  -> UNPROVEN
 *
 * @version v1
 */

import type {
  DeclaredClaim,
  ProofClaim,
  ProofGraphProjection,
  ProofProviderResult,
  ProofProviderBinding,
  ProofCounterexample,
} from '../../state/proofgraph.js';
import { PROOFGRAPH_SCHEMA_VERSION } from '../../state/proofgraph.js';
import type { ClaimVerificationState, Freshness } from '../../state/proofgraph-primitives.js';

/** Immutable inputs for a single deterministic evaluation. */
export interface ProofGraphEvaluationInput {
  /** Declared claims (provenance + references, no verification state). */
  readonly claims: readonly DeclaredClaim[];
  /** Executed provider results across all claims. */
  readonly providerResults: readonly ProofProviderResult[];
  /** Executed counterexamples across all claims. */
  readonly counterexamples: readonly ProofCounterexample[];
  /**
   * The current implementation revision digest, or `null` when no
   * implementation exists yet. Implementation-bound evidence bound to any other
   * digest is stale.
   */
  readonly currentImplementationDigest: string | null;
  /** The current plan digest, or `null`/absent. Plan-bound evidence uses this. */
  readonly currentPlanDigest?: string | null;
  /**
   * Current digest per surface id. A `surface_set`-bound result is fresh only
   * while the current digest for its `surfaceId` still matches its bound digest.
   */
  readonly currentSurfaceDigests?: Readonly<Record<string, string>>;
}

/**
 * Whether a passing result is fresh: its digest binding still matches the
 * current revision/surface. A result with no binding is never fresh.
 */
function isFresh(
  binding: ProofProviderBinding | undefined,
  input: ProofGraphEvaluationInput,
): boolean {
  if (binding === undefined) return false;
  switch (binding.kind) {
    case 'implementation':
      return (
        input.currentImplementationDigest !== null &&
        binding.digest === input.currentImplementationDigest
      );
    case 'plan': {
      const currentPlanDigest = input.currentPlanDigest ?? null;
      return currentPlanDigest !== null && binding.digest === currentPlanDigest;
    }
    case 'surface_set':
      return (input.currentSurfaceDigests ?? {})[binding.surfaceId] === binding.digest;
  }
}

function computeFreshness(
  passingResults: readonly ProofProviderResult[],
  input: ProofGraphEvaluationInput,
  evaluatedAt: string,
): Freshness | undefined {
  const bound = passingResults.filter((r) => r.binding !== undefined);
  if (bound.length === 0) return undefined;
  const fresh = bound.find((r) => isFresh(r.binding, input));
  const chosen = fresh ?? bound[0]!;
  return { boundDigest: chosen.binding!.digest, evaluatedAt, stale: fresh === undefined };
}

function deriveVerificationState(
  claim: DeclaredClaim,
  results: readonly ProofProviderResult[],
  counterexamples: readonly ProofCounterexample[],
  input: ProofGraphEvaluationInput,
): ClaimVerificationState {
  // 1. Provenance is mandatory; an unsourced manifest assertion is an assumption.
  if (claim.provenance === null) return 'NOT_VERIFIED';
  // 2. An executed counterexample that falsified the claim wins over any pass.
  if (counterexamples.some((c) => c.outcome === 'contradicted')) return 'CONTRADICTED';
  // 3./4. Distinguish an execution error (BLOCKED) from a missing provider (NOT_VERIFIED).
  if (results.some((r) => r.status === 'error')) return 'BLOCKED';
  if (results.some((r) => r.status === 'unavailable')) return 'NOT_VERIFIED';
  // 5. A failing verdict leaves the claim unproven.
  if (results.some((r) => r.status === 'fail')) return 'UNPROVEN';
  // 6. Passing evidence proves only while its digest binding is fresh - this
  //    applies to every provider kind (structural/schema included), so a pass
  //    can never satisfy a claim after its bound surface changed.
  const passing = results.filter((r) => r.status === 'pass');
  if (passing.some((r) => isFresh(r.binding, input))) return 'PROVEN';
  // 7. The only passing evidence is bound to a superseded revision/surface.
  if (passing.length > 0) return 'STALE';
  // 8. Declared with provenance but no evidence.
  return 'UNPROVEN';
}

function evaluateClaim(
  claim: DeclaredClaim,
  input: ProofGraphEvaluationInput,
  evaluatedAt: string,
): ProofClaim {
  const results = input.providerResults.filter((r) => r.claimId === claim.claimId);
  const counterexamples = input.counterexamples.filter((c) => c.claimId === claim.claimId);
  const verificationState = deriveVerificationState(claim, results, counterexamples, input);
  const freshness = computeFreshness(
    results.filter((r) => r.status === 'pass'),
    input,
    evaluatedAt,
  );
  return freshness === undefined
    ? { ...claim, verificationState }
    : { ...claim, verificationState, freshness };
}

/**
 * Evaluate a ProofGraph deterministically.
 *
 * @param input        Immutable declared claims, provider results, and counterexamples.
 * @param evaluatedAt  ISO-8601 evaluation timestamp (caller-supplied for determinism).
 * @returns            A compact, claim-sorted `ProofGraphProjection`.
 */
export function evaluateProofGraph(
  input: ProofGraphEvaluationInput,
  evaluatedAt: string,
): ProofGraphProjection {
  const claims: ProofClaim[] = [...input.claims]
    .sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0))
    .map((claim) => evaluateClaim(claim, input, evaluatedAt));
  return { version: PROOFGRAPH_SCHEMA_VERSION, claims, evaluatedAt };
}
