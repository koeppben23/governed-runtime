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
 * Canonical digest over the approval-relevant state projection: plan authority,
 * certificate, claims, implementation revision, risk assessment, proof
 * contract, proof graph semantics, and the frozen policy. Any change invalidates
 * a previously issued admission and is refused for an already-approved session.
 */
export function evidenceApprovalBasisDigest(state: SessionState): string {
  const plan = state.plan;
  return hashText(
    canonicalJsonStringify({
      flowguardSessionId: state.flowguardSessionId,
      bindingDigest: evidenceApprovalBindingDigest(state),
      policyHash: state.policySnapshot.hash,
      plan:
        plan === null
          ? null
          : {
              current: plan.current,
              claimDeclarations: plan.claimDeclarations ?? null,
              reviewCompletion: plan.reviewCompletion,
              approvalCertificate: plan.approvalCertificate ?? null,
            },
      implementationDigest: state.implementation?.digest ?? null,
      implementationChangedFiles: state.implementation?.changedFiles ?? null,
      implementationRiskAssessment: state.implementationRiskAssessment,
      proofContract: state.proofContract ?? null,
      proofGraph: semanticProofGraph(state.proofGraph),
    }),
  );
}

/** Issue an admission bound to the exact checked basis. */
export function issueEvidenceApprovalAdmission(state: SessionState): EvidenceApprovalAdmission {
  const admission: EvidenceApprovalAdmission = Object.freeze({
    kind: 'evidence-approval-admission' as const,
  });
  records.set(admission, {
    flowguardSessionId: state.flowguardSessionId,
    bindingDigest: evidenceApprovalBindingDigest(state),
    basisDigest: evidenceApprovalBasisDigest(state),
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
 */
export function consumeEvidenceApprovalAdmission(input: {
  readonly admission: unknown;
  readonly state: SessionState;
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
