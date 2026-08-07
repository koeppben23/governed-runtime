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
 *   1. missing provenance                       -> NOT_VERIFIED
 *   2. a FRESH counterexample contradicted it    -> CONTRADICTED
 *  2.5 a FRESH counterexample is blocked         -> BLOCKED
 *   3. a provider errored (execution)            -> BLOCKED
 *   4. a required provider was unavailable       -> NOT_VERIFIED
 *   5. a provider reported a failure             -> UNPROVEN
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

/** The digest binding of a result, or `undefined` for an `unavailable` result. */
function bindingOf(result: ProofProviderResult): ProofProviderBinding | undefined {
  return result.status === 'unavailable' ? undefined : result.binding;
}

/**
 * Whether a counterexample is fresh: bound to the current implementation
 * revision. A stale counterexample can neither contradict the current revision
 * nor satisfy an adversarial requirement for it.
 */
export function isFreshCounterexample(
  counterexample: ProofCounterexample,
  currentImplementationDigest: string | null,
): boolean {
  return (
    currentImplementationDigest !== null &&
    counterexample.boundDigest === currentImplementationDigest
  );
}

function computeFreshness(
  passingResults: readonly ProofProviderResult[],
  input: ProofGraphEvaluationInput,
  evaluatedAt: string,
): Freshness | undefined {
  const bound = passingResults.filter((r) => bindingOf(r) !== undefined);
  if (bound.length === 0) return undefined;
  const fresh = bound.find((r) => isFresh(bindingOf(r), input));
  const chosen = fresh ?? bound[0]!;
  return { boundDigest: bindingOf(chosen)!.digest, evaluatedAt, stale: fresh === undefined };
}

/** Fresh/stale adversarial (counterexample) analysis for one claim. */
interface AdversarialAnalysis {
  readonly freshContradicted: boolean;
  readonly freshSupported: boolean;
  readonly freshBlocked: boolean;
  readonly hasStaleAdversarial: boolean;
  readonly hasFreshAdversarial: boolean;
}

function analyzeCounterexamples(
  counterexamples: readonly ProofCounterexample[],
  currentImplementationDigest: string | null,
): AdversarialAnalysis {
  let freshContradicted = false;
  let freshSupported = false;
  let freshBlocked = false;
  let hasStaleAdversarial = false;
  let hasFreshAdversarial = false;
  for (const c of counterexamples) {
    if (c.outcome === 'not_verified') continue;
    if (c.outcome === 'blocked') {
      if (isFreshCounterexample(c, currentImplementationDigest)) {
        freshBlocked = true;
        hasFreshAdversarial = true;
      } else {
        hasStaleAdversarial = true;
      }
      continue;
    }
    if (isFreshCounterexample(c, currentImplementationDigest)) {
      hasFreshAdversarial = true;
      if (c.outcome === 'contradicted') freshContradicted = true;
      else freshSupported = true;
    } else {
      hasStaleAdversarial = true;
    }
  }
  return {
    freshContradicted,
    freshSupported,
    freshBlocked,
    hasStaleAdversarial,
    hasFreshAdversarial,
  };
}

/** Resolve a claim's state once precedence 1-5 has not already decided it. */
function deriveFromRequiredEvidence(
  claim: DeclaredClaim,
  passing: readonly ProofProviderResult[],
  cx: AdversarialAnalysis,
  input: ProofGraphEvaluationInput,
): ClaimVerificationState {
  const required = claim.requiredEvidence ?? EMPTY_REQUIRED;
  const freshPassKinds = new Set(
    passing
      .filter((r) => r.attestation !== 'external_self_reported')
      .filter((r) => isFresh(bindingOf(r), input))
      .map((r) => r.providerKind),
  );
  // Required adversarial evidence: a FRESH 'supported' counterexample. A missing,
  // stale, or 'not_verified' counterexample is unmet, never a pass-by-fallback.
  const adversarialSatisfied = required.adversarial.every((kind) =>
    kind === 'counterexample' ? cx.freshSupported : false,
  );
  // Required positive evidence: every required kind needs a fresh pass; with no
  // explicit positive requirement, any single fresh pass suffices.
  const positiveSatisfied =
    required.positive.length > 0
      ? required.positive.every((kind) => freshPassKinds.has(kind))
      : freshPassKinds.size > 0;
  if (adversarialSatisfied && positiveSatisfied) {
    // A stale, unsuperseded adversarial result leaves the claim not fully fresh.
    return cx.hasStaleAdversarial && !cx.hasFreshAdversarial ? 'STALE' : 'PROVEN';
  }
  if (!adversarialSatisfied) return 'NOT_VERIFIED';
  const hasStalePositive = passing.some(
    (r) => bindingOf(r) !== undefined && !isFresh(bindingOf(r), input),
  );
  return hasStalePositive ? 'STALE' : 'UNPROVEN';
}

function deriveVerificationState(
  claim: DeclaredClaim,
  results: readonly ProofProviderResult[],
  counterexamples: readonly ProofCounterexample[],
  input: ProofGraphEvaluationInput,
): ClaimVerificationState {
  // 1. Provenance is mandatory; an unsourced manifest assertion is an assumption.
  if (claim.provenance === null) return 'NOT_VERIFIED';
  const cx = analyzeCounterexamples(counterexamples, input.currentImplementationDigest);
  // 2. Only a FRESH executed counterexample that falsified the claim contradicts it.
  if (cx.freshContradicted) return 'CONTRADICTED';
  // 2.5 A fresh blocked counterexample blocks the claim — evidence provider could not
  //      produce an answerative result (timeout, crash, empty output).
  if (cx.freshBlocked) return 'BLOCKED';
  // 3./4. Distinguish an execution error (BLOCKED) from a missing provider (NOT_VERIFIED).
  if (results.some((r) => r.status === 'error')) return 'BLOCKED';
  if (results.some((r) => r.status === 'unavailable')) return 'NOT_VERIFIED';
  // 5. A failing verdict leaves the claim unproven.
  if (results.some((r) => r.status === 'fail')) return 'UNPROVEN';
  // 6.-8. Enforce the claim's policy-required evidence classes.
  return deriveFromRequiredEvidence(
    claim,
    results.filter((r) => r.status === 'pass'),
    cx,
    input,
  );
}

function evaluateClaim(
  claim: DeclaredClaim,
  input: ProofGraphEvaluationInput,
  evaluatedAt: string,
): ProofClaim {
  const results = input.providerResults.filter((r) => r.claimId === claim.claimId);
  const rawCounterexamples = input.counterexamples.filter((c) => c.claimId === claim.claimId);
  const selection = selectCurrentCounterexamples(rawCounterexamples);

  const verificationState = selection.conflicting
    ? 'NOT_VERIFIED'
    : deriveVerificationState(claim, results, selection.counterexamples, input);

  const freshness = computeFreshness(
    results.filter((r) => r.status === 'pass'),
    input,
    evaluatedAt,
  );
  return freshness === undefined
    ? { ...claim, verificationState }
    : { ...claim, verificationState, freshness };
}

// ─── Supersession: deterministische Attempt-Auswahl ─────────────────────────

type AttemptKey = string;

interface CurrentCounterexampleSelection {
  counterexamples: readonly ProofCounterexample[];
  conflicting: boolean;
  conflictReason?: string;
}

interface CounterexampleGroupResolution {
  status: 'current' | 'conflicting';
  value?: ProofCounterexample;
  values?: readonly ProofCounterexample[];
}

function resolveAttemptHistory(
  sortedNewestFirst: readonly ProofCounterexample[],
): CounterexampleGroupResolution {
  const latest = sortedNewestFirst[0] as ProofCounterexample;
  const older = sortedNewestFirst.slice(1);

  const next = older[0];
  if (next !== undefined && next.executedAt === latest.executedAt) {
    const outcomes = new Set(
      sortedNewestFirst.filter((c) => c.executedAt === latest.executedAt).map((c) => c.outcome),
    );
    if (outcomes.size > 1) {
      return {
        status: 'conflicting',
        values: sortedNewestFirst.filter((c) => c.executedAt === latest.executedAt),
      };
    }
  }

  if (latest.outcome === 'contradicted') {
    return { status: 'current', value: latest };
  }

  const hasOlderContradiction = older.some((c) => c.outcome === 'contradicted');
  if (hasOlderContradiction) {
    return { status: 'conflicting', values: sortedNewestFirst };
  }

  return { status: 'current', value: latest };
}

function selectCurrentCounterexamples(
  counterexamples: readonly ProofCounterexample[],
): CurrentCounterexampleSelection {
  const groups = new Map<AttemptKey, ProofCounterexample[]>();

  for (const c of counterexamples) {
    const key = `${c.claimId}:${c.checkId}:${c.boundDigest}`;
    const existing = groups.get(key) ?? [];
    existing.push(c);
    groups.set(key, existing);
  }

  const resolved: ProofCounterexample[] = [];
  let conflicting = false;
  let conflictReason: string | undefined;

  for (const [, group] of groups) {
    if (group.length === 1) {
      resolved.push(group[0]!);
      continue;
    }
    const sorted = [...group].sort((a, b) => b.executedAt.localeCompare(a.executedAt));
    const resolution = resolveAttemptHistory(sorted);
    if (resolution.status === 'current' && resolution.value) {
      resolved.push(resolution.value);
    } else {
      conflicting = true;
      conflictReason = `conflicting counterexample outcomes at revision ${group[0]!.boundDigest.slice(0, 12)}`;
    }
  }

  return { counterexamples: resolved, conflicting, conflictReason };
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
