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
import {
  resolveAuthoritativeStandaloneReviewTask,
  type StandaloneReviewTask,
} from '../../state/standalone-review.js';
import type {
  ProofGraphProjection,
  ProofProviderResult,
  ProofCounterexample,
  AssertionBindingReasonCode,
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
function collectAuthoritativeStandaloneClaims(
  state: SessionState,
): Map<string, StandaloneReviewTask['claims'][number]> {
  // Standalone-review claims project ONLY from the single authoritative task per
  // obligation (canonical lifecycle authority in state/standalone-review.ts).
  // Superseded/predecessor incarnations are audit-only. A structurally broken
  // chain cannot reach this projection: the SessionState schema boundary
  // rejects it fail-closed (SCHEMA_VALIDATION_FAILED) before any derivation.
  const claims = new Map<string, StandaloneReviewTask['claims'][number]>();
  for (const obligation of state.reviewAssurance?.obligations ?? []) {
    if (obligation.obligationType !== 'review') continue;
    const resolved = resolveAuthoritativeStandaloneReviewTask(
      state.standaloneReviewEvidence,
      obligation.obligationId,
    );
    if (resolved.kind !== 'ok') continue;
    for (const claim of resolved.task.claims) {
      claims.set(claim.claimId, claim);
    }
  }
  return claims;
}

export function deriveProofGraph(
  state: SessionState,
  providerResults: readonly ProofProviderResult[],
  counterexamples: readonly ProofCounterexample[],
  evaluatedAt: string,
  opts?: {
    currentSurfaceDigests?: Readonly<Record<string, string>>;
    claimDiagnostics?: Readonly<Record<string, AssertionBindingReasonCode>>;
  },
): ProofGraphProjection {
  // Standalone-review claims project ONLY from the single authoritative task per
  // obligation (canonical lifecycle authority in state/standalone-review.ts).
  const standaloneClaims = collectAuthoritativeStandaloneClaims(state);
  const contractClaims = normalizeContractClaims(state);
  const base = evaluateProofGraph(
    {
      claims: [...contractClaims, ...standaloneClaims.values()],
      providerResults,
      counterexamples,
      currentImplementationDigest: state.implementation?.digest ?? null,
      currentPlanDigest: state.plan?.current.digest ?? null,
      currentSurfaceDigests: opts?.currentSurfaceDigests ?? {},
    },
    evaluatedAt,
  );
  const diagnostics = opts?.claimDiagnostics;
  if (diagnostics && Object.keys(diagnostics).length > 0) {
    return { ...base, claimDiagnostics: diagnostics };
  }
  return base;
}

function normalizeContractClaims(state: SessionState) {
  // Pre-v2 plan declarations did not persist proofEligibility. Preserve their
  // certificate for audit while denying proof even for already-materialized claims.
  const declarations = state.plan?.claimDeclarations;
  const legacyPlanClaimIds =
    declarations && !('version' in declarations)
      ? new Set(declarations.claims.map((claim) => claim.claimId))
      : new Set<string>();
  return (state.proofContract?.claims ?? []).map((claim) =>
    claim.proofEligibility === undefined && legacyPlanClaimIds.has(claim.claimId)
      ? { ...claim, proofEligibility: 'legacy_declaration_v1' as const }
      : claim,
  );
}
