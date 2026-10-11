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
  resolveAuthoritativePeerReviewTask,
  type PeerReviewTask,
} from '../../state/peer-review.js';
import type {
  DeclaredClaim,
  ProofGraphProjection,
  ProofProviderResult,
  ProofCounterexample,
  AssertionBindingReasonCode,
} from '../../state/proofgraph.js';
import { evaluateProofGraph } from './evaluate.js';
import { assessEvidenceRoleIndependence } from './evidence-role-independence.js';

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
function collectAuthoritativePeerReviewClaims(
  state: SessionState,
): Map<string, PeerReviewTask['claims'][number]> {
  // Peer-review claims project ONLY from the single authoritative task per
  // obligation (canonical lifecycle authority in state/peer-review.ts).
  // Superseded/predecessor incarnations are audit-only. A structurally broken
  // chain cannot reach this projection: the SessionState schema boundary
  // rejects it fail-closed (SCHEMA_VALIDATION_FAILED) before any derivation.
  const claims = new Map<string, PeerReviewTask['claims'][number]>();
  for (const obligation of state.reviewAssurance?.obligations ?? []) {
    if (obligation.obligationType !== 'review') continue;
    const resolved = resolveAuthoritativePeerReviewTask(
      state.peerReviewEvidence,
      obligation.obligationId,
    );
    if (resolved.kind !== 'ok') continue;
    for (const claim of resolved.task.claims) {
      claims.set(claim.claimId, claim);
    }
  }
  return claims;
}

/**
 * Persist the diagnostic for a defective evidence-role binding, using the
 * canonical independence assessment (never a second implementation).
 */
function roleIndependenceDiagnostics(
  claims: readonly DeclaredClaim[],
  providerResults: readonly ProofProviderResult[],
  counterexamples: readonly ProofCounterexample[],
): Readonly<Record<string, AssertionBindingReasonCode>> {
  const record: Record<string, AssertionBindingReasonCode> = {};
  for (const claim of claims) {
    const assessment = assessEvidenceRoleIndependence({
      ...(claim.counterexampleRequirement !== undefined
        ? { counterexampleRequirement: claim.counterexampleRequirement }
        : {}),
      adversarialCounterexampleRequired: (claim.requiredEvidence?.adversarial ?? []).includes(
        'counterexample',
      ),
      providerResults: providerResults.filter((r) => r.claimId === claim.claimId),
      counterexamples: counterexamples.filter((c) => c.claimId === claim.claimId),
    });
    if (assessment.kind === 'role_collision') {
      record[claim.claimId] = 'evidence_role_collision';
    } else if (assessment.kind === 'not_verifiable') {
      record[claim.claimId] = 'evidence_missing';
    }
  }
  return record;
}

/**
 * Merge role-independence diagnostics over the binder-provided record. A role
 * collision is the claim's primary defect; a missing execution identity fills
 * in only when no more specific binding code exists.
 */
function mergeRoleDiagnostics(
  provided: Readonly<Record<string, AssertionBindingReasonCode>>,
  computed: Readonly<Record<string, AssertionBindingReasonCode>>,
): Record<string, AssertionBindingReasonCode> {
  const merged: Record<string, AssertionBindingReasonCode> = { ...provided };
  for (const [claimId, code] of Object.entries(computed)) {
    if (code === 'evidence_role_collision' || merged[claimId] === undefined) {
      merged[claimId] = code;
    }
  }
  return merged;
}

/**
 * Project the coverage causes already determined at materialization. A claim
 * whose shared attempt was removed from `counterexampleRefs` can no longer be
 * re-detected from evidence, so the persisted cause supplies the diagnostic.
 */
function coverageGapDiagnostics(
  state: SessionState,
): Readonly<Record<string, AssertionBindingReasonCode>> {
  const record: Record<string, AssertionBindingReasonCode> = {};
  for (const gap of state.proofContractCoverage ?? []) {
    if (gap.cause === 'evidence_role_collision' && gap.claimId !== undefined) {
      record[gap.claimId] = 'evidence_role_collision';
    }
  }
  return record;
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
  // Peer-review claims project ONLY from the single authoritative task per
  // obligation (canonical lifecycle authority in state/peer-review.ts).
  const peerReviewClaims = collectAuthoritativePeerReviewClaims(state);
  const contractClaims = normalizeContractClaims(state);
  const declaredClaims = [...contractClaims, ...peerReviewClaims.values()];
  const base = evaluateProofGraph(
    {
      claims: declaredClaims,
      providerResults,
      counterexamples,
      currentImplementationDigest: state.implementation?.digest ?? null,
      currentPlanDigest: state.plan?.current.digest ?? null,
      currentSurfaceDigests: opts?.currentSurfaceDigests ?? {},
    },
    evaluatedAt,
  );
  const diagnostics = mergeRoleDiagnostics(
    { ...coverageGapDiagnostics(state), ...(opts?.claimDiagnostics ?? {}) },
    roleIndependenceDiagnostics(declaredClaims, providerResults, counterexamples),
  );
  return Object.keys(diagnostics).length > 0 ? { ...base, claimDiagnostics: diagnostics } : base;
}

function normalizeContractClaims(state: SessionState) {
  // Hard Assurance Epoch: plan declarations are v2-only; there is no legacy
  // declaration branch to reinterpret — persisted contract claims pass through.
  return state.proofContract?.claims ?? [];
}
