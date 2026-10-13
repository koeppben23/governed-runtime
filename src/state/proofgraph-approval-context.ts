/**
 * @module proofgraph-approval-context
 * @description Session-bound projection of the plan approval authority.
 *
 * The certificate validity authority lives in `proofgraph-approval.ts`; this
 * module owns the ONLY bridge from full session state to that authority, so no
 * caller can reconstruct a weaker context (or omit the session/policy binding)
 * on its own.
 *
 * @version v1
 */

import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashText } from '../shared/hashing.js';
import {
  authorizedCriticalPlanClaimIds as authorizedCriticalPlanClaimIdsOf,
  hasCurrentPlanApprovalCertificate,
  type AuthorizedCriticalPlanClaimIds,
  type PlanApprovalContext,
  type PlanClaimAuthority,
} from './proofgraph-approval.js';
import type { SessionState } from './schema.js';

/** The canonical session/policy binding of a plan approval certificate. */
export function planApprovalContextOf(state: SessionState): PlanApprovalContext {
  return {
    flowguardSessionId: state.flowguardSessionId,
    bindingDigest: hashText(canonicalJsonStringify(state.binding)),
    policyHash: state.policySnapshot.hash,
    policyHashVersion: state.policySnapshot.hashVersion,
    requireHumanGates: state.policySnapshot.requireHumanGates,
  };
}

/** Project the current plan record onto the certificate validity authority. */
function planClaimAuthorityOfState(state: SessionState): PlanClaimAuthority | null {
  const plan = state.plan;
  if (plan === null) return null;
  return {
    current: {
      digest: plan.current.digest,
      planVersion: plan.current.planVersion,
      recordDigest: plan.current.recordDigest,
    },
    ...(plan.claimDeclarations !== undefined ? { claimDeclarations: plan.claimDeclarations } : {}),
    ...(plan.approvalCertificate !== undefined
      ? { approvalCertificate: plan.approvalCertificate }
      : {}),
  };
}

/**
 * Certificate-authorized critical plan claims for this exact session. This is
 * the single state-level entry point; a context-free plan-only authorization
 * is deliberately not exported.
 */
export function authorizedCriticalPlanClaimIds(
  state: SessionState,
): AuthorizedCriticalPlanClaimIds {
  return authorizedCriticalPlanClaimIdsOf(
    planClaimAuthorityOfState(state),
    planApprovalContextOf(state),
  );
}

/**
 * Whether the session's current plan carries a current, session- and
 * policy-bound approval certificate.
 *
 * This is the only state-level boolean entry point: the plan-record shape is
 * converted to the certificate authority here, so callers never rebuild the
 * bridge (or a weaker context) themselves.
 */
export function hasCurrentPlanApprovalCertificateForState(state: SessionState): boolean {
  return hasCurrentPlanApprovalCertificate(
    planClaimAuthorityOfState(state),
    planApprovalContextOf(state),
  );
}
