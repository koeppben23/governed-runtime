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
 *   6. required positive (fresh) + adversarial evidence all satisfied -> PROVEN
 *   7. required adversarial evidence missing/unresolved -> NOT_VERIFIED
 *   8. positive evidence only stale -> STALE, otherwise -> UNPROVEN
 *
 * @version v1
 */

import type {
  DeclaredClaim,
  ProofClaim,
  ProofGraphProjection,
  ProofProviderResult,
  ProofProviderBinding,
  RequiredEvidence,
  ProofCounterexample,
} from '../../state/proofgraph.js';
import { PROOFGRAPH_SCHEMA_VERSION } from '../../state/proofgraph.js';
import type { ClaimVerificationState, Freshness } from '../../state/proofgraph-primitives.js';

/** No explicit evidence requirement: any fresh pass proves, no adversarial needed. */
const EMPTY_REQUIRED: RequiredEvidence = { positive: [], adversarial: [] };

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
  // 6.-8. Enforce the claim's policy-required evidence classes.
  const required = claim.requiredEvidence ?? EMPTY_REQUIRED;
  const passing = results.filter((r) => r.status === 'pass');
  const freshPassKinds = new Set(
    passing.filter((r) => isFresh(r.binding, input)).map((r) => r.providerKind),
  );
  // 6. Required adversarial evidence: an executed counterexample that was
  //    attempted and did NOT hold ('supported'). A missing or 'not_verified'
  //    counterexample is a missing required provider, never a pass-by-fallback.
  const adversarialSatisfied = required.adversarial.every((kind) =>
    kind === 'counterexample' ? counterexamples.some((c) => c.outcome === 'supported') : false,
  );
  // 7. Required positive evidence: every required kind needs a fresh pass; with
  //    no explicit positive requirement, any single fresh pass suffices.
  const positiveSatisfied =
    required.positive.length > 0
      ? required.positive.every((kind) => freshPassKinds.has(kind))
      : freshPassKinds.size > 0;
  if (adversarialSatisfied && positiveSatisfied) return 'PROVEN';
  // Required adversarial evidence is missing/unresolved - never summarized as proven.
  if (!adversarialSatisfied) return 'NOT_VERIFIED';
  // 8. Adversarial satisfied, but the positive evidence is only stale / insufficient.
  if (passing.some((r) => r.binding !== undefined && !isFresh(r.binding, input))) return 'STALE';
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
