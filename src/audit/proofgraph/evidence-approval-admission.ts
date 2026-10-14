/**
 * @module audit/proofgraph/evidence-approval-admission
 * @description Ephemeral, non-forgeable approval admission and the canonical
 * approval-relevant evidence basis.
 *
 * An admission is a process-local capability proving that the CANONICAL
 * protected application evaluated BOTH the approval authority (a recorded
 * approving decision at a human-gated policy, or automatic permission) and the
 * canonical evidence preflight for exactly one evidence basis. The persistence
 * boundary consumes it exactly once for the commit that newly enters
 * `EXPORT_READY`, so a state object with a self-declared
 * `transition.event = 'APPROVE'` is never sufficient.
 *
 * The bookkeeping deliberately lives OUTSIDE the pure evaluators: the
 * substantive rules stay in `evidence-approval-preflight.ts` and the credential
 * machinery only enforces that the same runtime checked the same basis.
 *
 * @version v1
 */

import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { hashText } from '../../shared/hashing.js';
import type { SessionState } from '../../state/schema.js';
import type { ProofGraphProjection } from '../../state/proofgraph.js';

/** Opaque admission handle. All authoritative data is held privately. */
export interface EvidenceApprovalAdmission {
  readonly kind: 'evidence-approval-admission';
}

interface AdmissionRecord {
  readonly flowguardSessionId: string;
  readonly bindingDigest: string;
  readonly basisDigest: string;
  /**
   * Basis of the PRE-APPROVAL predecessor state (everything except the
   * approval decision). The persisted predecessor must match it, so an
   * admission issued from state A cannot be committed on a predecessor that
   * was changed to state B in between.
   */
  readonly sourceBasisDigest: string;
  /**
   * Canonical digest of the APPLIED approval transition (from/to/event/at).
   * The candidate state must present exactly the transition the protected
   * application applied; a tampered transition record invalidates the handle.
   */
  readonly transitionDigest: string;
  consumed: boolean;
}

const records = new WeakMap<object, AdmissionRecord>();

/** Session-binding digest of a state. */
function evidenceApprovalBindingDigest(state: SessionState): string {
  return hashText(canonicalJsonStringify(state.binding));
}

function semanticProofGraph(
  projection: ProofGraphProjection | null | undefined,
): Record<string, unknown> | null {
  if (!projection) return null;
  // `evaluatedAt`/claim-freshness timestamps are volatile refresh metadata, not
  // approval evidence: strip them so identical evidence stays identical while
  // any semantic graph change still invalidates the admission.
  const { evaluatedAt: _evaluatedAt, ...rest } = projection;
  const claims = projection.claims.map((claim) => {
    const { freshness, ...claimRest } = claim;
    return {
      ...claimRest,
      ...(freshness !== undefined
        ? { freshness: { boundDigest: freshness.boundDigest, stale: freshness.stale } }
        : {}),
    };
  });
  return { ...rest, claims };
}

/**
 * Canonical digest over the immutable approval basis. The basis is split into:
 *
 * - **approval authority** — review decision, plan authority, certificate,
 *   frozen policy hash, session binding;
 * - **review/validation evidence** — implementation review result and
 *   findings, review assurance (reviewer evidence ledger), validation
 *   attempts, implementation validation, mutation episodes and resolutions,
 *   implementation revision, risk assessment, proof contract and evaluated
 *   proof graph semantics.
 *
 * Operative metadata that is deliberately NOT part of the basis: runtime
 * lease, audit outbox, risk/discovery gates, error, review cycles, pending
 * system work. Any basis change invalidates a previously issued admission and
 * is refused for an already-approved session.
 */
function evidenceApprovalBasisProjection(
  state: SessionState,
  includeDecision: boolean,
): Record<string, unknown> {
  return {
    flowguardSessionId: state.flowguardSessionId,
    bindingDigest: evidenceApprovalBindingDigest(state),
    // The FULL frozen policy snapshot, not only its stored hash: the reader
    // does not recompute the hash from the fields, so a hash-only binding
    // would not detect in-place policy tampering.
    policySnapshot: state.policySnapshot,
    ticket: state.ticket,
    architecture: state.architecture,
    actorInfo: state.actorInfo ?? null,
    initiatedBy: state.initiatedBy,
    initiatedByIdentity: state.initiatedByIdentity ?? null,
    reducedCeremony: state.reducedCeremony,
    implementationRework: state.implementationRework ?? null,
    ...(includeDecision ? { reviewDecision: state.reviewDecision } : {}),
    plan: state.plan,
    implReview: state.implReview,
    implReviewFindings: state.implReviewFindings ?? null,
    reviewAssurance: state.reviewAssurance ?? null,
    validationAttempts: state.validationAttempts,
    implValidation: state.implValidation,
    mutationEpisodes: state.mutationEpisodes,
    mutationEpisodeResolutions: state.mutationEpisodeResolutions,
    implementation: state.implementation,
    implementationRiskAssessment: state.implementationRiskAssessment,
    proofContract: state.proofContract ?? null,
    proofGraph: semanticProofGraph(state.proofGraph),
  };
}

/** Canonical digest of the applied approval transition, including its time. */
function appliedTransitionDigest(state: SessionState): string {
  return hashText(canonicalJsonStringify(state.transition ?? null));
}

/** Basis of the persisted predecessor: everything except the approval decision. */
function evidenceApprovalSourceBasisDigest(state: SessionState): string {
  return hashText(canonicalJsonStringify(evidenceApprovalBasisProjection(state, false)));
}

export function evidenceApprovalBasisDigest(state: SessionState): string {
  return hashText(canonicalJsonStringify(evidenceApprovalBasisProjection(state, true)));
}

/** Top-level basis keys that differ between two states, for forensic diagnostics. */
export function evidenceApprovalBasisDiff(previous: SessionState, next: SessionState): string[] {
  const before = evidenceApprovalBasisProjection(previous, true);
  const after = evidenceApprovalBasisProjection(next, true);
  return Object.keys(before).filter(
    (key) =>
      canonicalJsonStringify(before[key] ?? null) !== canonicalJsonStringify(after[key] ?? null),
  );
}

/**
 * Issue an admission bound to the exact checked basis.
 *
 * TRUST BOUNDARY: only the canonical protected application
 * (`rails/evidence-approval-application.ts`) may call this after it has checked
 * the approval authority and the evidence preflight. The architecture guard
 * `evidence-approval-admission-ssot.test.ts` pins the caller set; any new
 * issuer caller outside that set is a review blocker.
 */
export function issueEvidenceApprovalAdmission(state: SessionState): EvidenceApprovalAdmission {
  const admission: EvidenceApprovalAdmission = Object.freeze({
    kind: 'evidence-approval-admission' as const,
  });
  records.set(admission, {
    flowguardSessionId: state.flowguardSessionId,
    bindingDigest: evidenceApprovalBindingDigest(state),
    basisDigest: evidenceApprovalBasisDigest(state),
    sourceBasisDigest: evidenceApprovalSourceBasisDigest(state),
    transitionDigest: appliedTransitionDigest(state),
    consumed: false,
  });
  return admission;
}

export type AdmissionConsumption =
  { readonly kind: 'accepted' } | { readonly kind: 'rejected'; readonly reason: string };

/**
 * Consume an admission exactly once for the exact basis it was issued for.
 * Forged objects, foreign runtime instances, replays, and any evidence,
 * authority, policy, or binding drift are rejected.
 *
 * RECOVERY CONTRACT: consumption is fail-closed BEFORE durability, so a failed
 * commit burns the handle. Recovery never replays it: re-read the persisted
 * state, reconcile the audit outbox, and obtain a FRESH admission through the
 * canonical protected application before committing again — the same basis
 * cannot be approved twice.
 */
export function consumeEvidenceApprovalAdmission(input: {
  readonly admission: unknown;
  readonly state: SessionState;
  /** The persisted predecessor the approval is committed on top of. */
  readonly predecessor: SessionState | null;
}): AdmissionConsumption {
  if (input.admission === null || typeof input.admission !== 'object') {
    return { kind: 'rejected', reason: 'no authentic approval admission was supplied' };
  }
  const record = records.get(input.admission);
  if (record === undefined) {
    return { kind: 'rejected', reason: 'the approval admission was not issued by this runtime' };
  }
  if (record.consumed) {
    return { kind: 'rejected', reason: 'the approval admission was already consumed' };
  }
  if (record.flowguardSessionId !== input.state.flowguardSessionId) {
    return { kind: 'rejected', reason: 'the approval admission belongs to another session' };
  }
  if (record.bindingDigest !== evidenceApprovalBindingDigest(input.state)) {
    return {
      kind: 'rejected',
      reason: 'the approval admission belongs to another worktree binding',
    };
  }
  if (
    input.predecessor === null ||
    record.sourceBasisDigest !== evidenceApprovalSourceBasisDigest(input.predecessor)
  ) {
    return {
      kind: 'rejected',
      reason: 'the persisted predecessor changed after the approval basis was admitted',
    };
  }
  if (record.transitionDigest !== appliedTransitionDigest(input.state)) {
    return {
      kind: 'rejected',
      reason: 'the applied approval transition changed after it was admitted',
    };
  }
  const basisDigest = evidenceApprovalBasisDigest(input.state);
  if (record.basisDigest !== basisDigest) {
    return {
      kind: 'rejected',
      reason: 'the approval evidence basis changed after it was admitted',
    };
  }
  record.consumed = true;
  return { kind: 'accepted' };
}
