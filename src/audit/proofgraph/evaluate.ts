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
 *   6. a passing structural assertion, or fresh revision-bound evidence -> PROVEN
 *   7. only stale revision-bound passing evidence -> STALE
 *   8. otherwise (declared, no evidence)  -> UNPROVEN
 *
 * @version v1
 */

import type {
  DeclaredClaim,
  ProofClaim,
  ProofGraphProjection,
  ProofProviderResult,
  ProofCounterexample,
} from '../../state/proofgraph.js';
import { PROOFGRAPH_SCHEMA_VERSION } from '../../state/proofgraph.js';
import type {
  ClaimVerificationState,
  Freshness,
  ProofProviderKind,
} from '../../state/proofgraph-primitives.js';

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
   * implementation exists yet. Evidence bound to any other digest is stale.
   */
  readonly currentImplementationDigest: string | null;
}

/** A passing result is fresh only when bound to the current implementation digest. */
function isFresh(
  boundDigest: string | undefined,
  currentImplementationDigest: string | null,
): boolean {
  return (
    currentImplementationDigest !== null &&
    boundDigest !== undefined &&
    boundDigest === currentImplementationDigest
  );
}

/**
 * Whether a provider kind produces revision-bound evidence. Executed tests and
 * fault injections are bound to an implementation revision (freshness applies).
 * Structural and schema-comparison assertions are repo-level, not revision-bound,
 * so a passing structural result proves regardless of the implementation digest.
 */
function isRevisionBound(kind: ProofProviderKind): boolean {
  return kind === 'executed_test' || kind === 'fault_injection';
}

function computeFreshness(
  passingResults: readonly ProofProviderResult[],
  currentImplementationDigest: string | null,
  evaluatedAt: string,
): Freshness | undefined {
  const withDigest = passingResults.filter(
    (r) => isRevisionBound(r.providerKind) && r.boundDigest !== undefined,
  );
  if (withDigest.length === 0) return undefined;
  const fresh = withDigest.find((r) => isFresh(r.boundDigest, currentImplementationDigest));
  if (fresh?.boundDigest !== undefined) {
    return { boundDigest: fresh.boundDigest, evaluatedAt, stale: false };
  }
  const boundDigest = withDigest[0]!.boundDigest;
  return boundDigest === undefined ? undefined : { boundDigest, evaluatedAt, stale: true };
}

function deriveVerificationState(
  claim: DeclaredClaim,
  results: readonly ProofProviderResult[],
  counterexamples: readonly ProofCounterexample[],
  currentImplementationDigest: string | null,
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
  // 6. Non-revision-bound passing evidence (structural / schema) proves regardless
  //    of the implementation digest; revision-bound evidence proves only when fresh.
  const passing = results.filter((r) => r.status === 'pass');
  if (passing.some((r) => !isRevisionBound(r.providerKind))) return 'PROVEN';
  if (passing.some((r) => isFresh(r.boundDigest, currentImplementationDigest))) return 'PROVEN';
  // 7. The only passing evidence is revision-bound but stale.
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
  const verificationState = deriveVerificationState(
    claim,
    results,
    counterexamples,
    input.currentImplementationDigest,
  );
  const freshness = computeFreshness(
    results.filter((r) => r.status === 'pass'),
    input.currentImplementationDigest,
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
