/**
 * @module integration/review/reviewed-digest
 * @description Historical provenance projection: which obligation and
 *              invocation canonically produced a specific ReviewFindings
 *              record, resolved for review-gate verdict displays (cards,
 *              status projections, tool responses).
 *
 * This module is READ-ONLY provenance resolution. It deliberately does NOT
 * reuse `findAcceptedInvocationForFindings`, whose `consumedByObligationId ===
 * null` requirement serves ACTIVE settlement decisions: after
 * `consumeReviewObligation` marks the producer invocation as consumed by its
 * own obligation, the historical question "who produced these findings" must
 * still be answerable.
 *
 * Invariant (no recency selection, no current-state fallback):
 *   reviewedDigest may be projected for subagent findings IFF
 *   1. the exact producer obligation is identified,
 *   2. type / iteration / planVersion match the findings,
 *   3. the exact invocation matches childSessionId + findingsHash, and
 *   4. the invocation is either unconsumed OR consumed by exactly that
 *      producer obligation.
 *   Self-mode findings resolve ONLY via their attestation; without an
 *   attestation the identity is undefined.
 *
 * @version v1
 */

import { getAdapterLogger } from '../../logging/adapter-logger.js';
import { ensureReviewAssurance } from './assurance.js';
import type {
  ReviewAssuranceState,
  ReviewFindings,
  ReviewInvocationEvidence,
  ReviewObligation,
  ReviewObligationType,
} from '../../state/evidence.js';
import { hashFindings } from './findings-hash.js';

/** Full review identity of the findings displayed at a review gate. */
export interface ReviewedArtifactIdentity {
  readonly reviewedDigest: string;
  readonly reviewedObligationId: string;
  readonly reviewerIteration: number;
  readonly reviewedPlanVersion: number;
}

/**
 * Provenance-oriented invocation lookup: same strict binding as the active
 * settlement resolver (invocationId/obligationId, childSessionId,
 * findingsHash, host_subagent_task + hostVisible in the fallback path), but
 * consumption is accepted when bound to EXACTLY the producer obligation.
 * Consumption by any other obligation is never provenance.
 */
function findInvocationForFindingsProvenance(
  assurance: ReviewAssuranceState | undefined,
  obligation: ReviewObligation,
  findings: ReviewFindings,
): ReviewInvocationEvidence | null {
  const findingsHash = hashFindings(findings);
  const base = ensureReviewAssurance(assurance);
  const consumable = (invocation: ReviewInvocationEvidence): boolean =>
    invocation.consumedByObligationId === null ||
    invocation.consumedByObligationId === obligation.obligationId;

  if (obligation.invocationId) {
    return (
      base.invocations.find(
        (invocation) =>
          invocation.invocationId === obligation.invocationId &&
          invocation.obligationId === obligation.obligationId &&
          invocation.childSessionId === findings.reviewedBy.sessionId &&
          invocation.findingsHash === findingsHash &&
          consumable(invocation),
      ) ?? null
    );
  }
  return (
    base.invocations.find(
      (invocation) =>
        invocation.obligationId === obligation.obligationId &&
        invocation.invocationMode === 'host_subagent_task' &&
        invocation.hostVisible === true &&
        invocation.childSessionId === findings.reviewedBy.sessionId &&
        invocation.findingsHash === findingsHash &&
        consumable(invocation),
    ) ?? null
  );
}

/**
 * Resolve the reviewed artifact identity for a specific findings record.
 *
 * - Subagent findings require the exact producer obligation (via
 *   `attestation.toolObligationId`, or a UNIQUE exact findings↔invocation
 *   match) plus coherent type/iteration/planVersion and a valid invocation
 *   provenance (unconsumed or consumed by its own obligation).
 * - Self-mode findings resolve ONLY via their attestation; without one (the
 *   schema allows it), the identity is undefined — never guessed.
 * - Any inconsistency yields `undefined` plus a diagnostic warning; this is a
 *   presentation projection and never mutates state.
 */
export function resolveReviewedArtifactIdentity(
  assurance: ReviewAssuranceState | undefined,
  obligationType: ReviewObligationType,
  findings: ReviewFindings | undefined,
): ReviewedArtifactIdentity | undefined {
  if (!findings) return undefined;
  const base = ensureReviewAssurance(assurance);

  const obligation = resolveProducerObligation(base, obligationType, findings);
  if (!obligation) {
    getAdapterLogger().warn('review', 'reviewed_identity_unresolvable', {
      obligationType,
      attestationObligationId: findings.attestation?.toolObligationId ?? null,
      reviewMode: findings.reviewMode,
    });
    return undefined;
  }
  if (
    obligation.iteration !== findings.iteration ||
    obligation.planVersion !== findings.planVersion
  ) {
    getAdapterLogger().warn('review', 'reviewed_identity_coherence_mismatch', {
      obligationId: obligation.obligationId,
      obligationIteration: obligation.iteration,
      findingsIteration: findings.iteration,
      obligationPlanVersion: obligation.planVersion,
      findingsPlanVersion: findings.planVersion,
    });
    return undefined;
  }
  if (
    findings.reviewMode === 'subagent' &&
    findInvocationForFindingsProvenance(base, obligation, findings) === null
  ) {
    getAdapterLogger().warn('review', 'reviewed_identity_invocation_unproven', {
      obligationId: obligation.obligationId,
      reviewMode: findings.reviewMode,
    });
    return undefined;
  }

  return {
    reviewedDigest: obligation.subjectDigest,
    reviewedObligationId: obligation.obligationId,
    reviewerIteration: findings.iteration,
    reviewedPlanVersion: findings.planVersion,
  };
}

/**
 * Exact producer obligation for these findings. Subagent findings resolve via
 * `attestation.toolObligationId` (with type coherence) or a UNIQUE exact
 * findings↔invocation match; self-mode findings resolve ONLY via their
 * attestation. Never guessed by recency.
 */
function resolveProducerObligation(
  base: ReviewAssuranceState,
  obligationType: ReviewObligationType,
  findings: ReviewFindings,
): ReviewObligation | null {
  const attestationObligationId = findings.attestation?.toolObligationId;
  if (attestationObligationId) {
    return resolveObligationById(base, obligationType, attestationObligationId);
  }
  if (findings.reviewMode !== 'subagent') return null;
  const matches = base.obligations.filter(
    (o) =>
      o.obligationType === obligationType &&
      findInvocationForFindingsProvenance(base, o, findings) !== null,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function resolveObligationById(
  base: ReviewAssuranceState,
  obligationType: ReviewObligationType,
  obligationId: string,
): ReviewObligation | null {
  const byId = base.obligations.find((o) => o.obligationId === obligationId) ?? null;
  if (!byId || byId.obligationType !== obligationType) {
    getAdapterLogger().warn('review', 'reviewed_identity_type_mismatch', {
      obligationId: byId?.obligationId ?? null,
      expected: obligationType,
      actual: byId?.obligationType ?? null,
    });
    return null;
  }
  return byId;
}

/** Spread-able additive response fields from a resolved identity (empty when absent). */
export function reviewedIdentityFields(
  identity: ReviewedArtifactIdentity | undefined,
): Record<string, unknown> {
  if (!identity) return {};
  return {
    reviewedDigest: identity.reviewedDigest,
    reviewedObligationId: identity.reviewedObligationId,
    reviewerIteration: identity.reviewerIteration,
    reviewedPlanVersion: identity.reviewedPlanVersion,
  };
}
