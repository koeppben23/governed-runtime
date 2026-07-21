/**
 * @module integration/review-evidence-binding
 * @description Host-task evidence binding for review enforcement.
 *
 * Extracted from review-enforcement.ts (FG-REL-038) for single-responsibility.
 * Builds persistent ReviewInvocationEvidence from enforcement state and
 * persisted obligations after a Task tool call to flowguard-reviewer.
 *
 * Pure function — reads enforcement state but does not mutate it.
 *
 * @version v1
 */

import type { ReviewInvocationEvidence, ReviewObligation } from '../../state/evidence.js';
import type { SessionEnforcementState, HostTaskBindResult } from './enforcement/types.js';
import { REVIEWER_SUBAGENT_TYPE, TOOL_FLOWGUARD_REVIEW } from '../tool-names.js';
import { obligationTypeForTool } from './obligation-tools.js';
import { buildInvocationEvidence, hashFindings, hashText } from './assurance.js';
import { getRequiredBranchReviewProvenance } from '../tools/review-tool/obligation.js';

function getBranchProvenanceFields(obligation: ReviewObligation): {
  resolvedBranchSha: string | null;
  resolvedBaseSha: string | null;
  reviewedContentDigest: string | null;
} {
  const isBranch =
    typeof obligation.metadata?.branch === 'string' && obligation.metadata.branch.length > 0;
  if (!isBranch)
    return { resolvedBranchSha: null, resolvedBaseSha: null, reviewedContentDigest: null };
  const p = getRequiredBranchReviewProvenance(obligation);
  return {
    resolvedBranchSha: p.resolvedBranchSha,
    resolvedBaseSha: p.resolvedBaseSha,
    reviewedContentDigest: p.reviewedContentDigest,
  };
}

/**
 * Build host-subagent-task invocation evidence from enforcement state and persisted obligations.
 *
 * Called after `onTaskToolAfter` records a Task tool call to flowguard-reviewer.
 * Creates persistent ReviewInvocationEvidence with invocationMode='host_subagent_task'
 * and hostVisible=true, so that validateReviewFindings can find it during tool.execute.
 *
 * @param state - Session enforcement state (after onTaskToolAfter update)
 * @param sessionId - Current session ID (parent session)
 * @param obligations - Persisted review obligations from session state
 * @param invocations - Persisted invocation evidence from session state
 * @param now - ISO 8601 timestamp
 * @returns HostTaskBindResult with evidence (or null) plus diagnostic metadata
 */
export function buildHostTaskEvidence(
  state: SessionEnforcementState,
  sessionId: string,
  obligations: ReviewObligation[],
  invocations: ReviewInvocationEvidence[],
  now: string,
): HostTaskBindResult {
  const latestResult = latestBindableReviewRecord(state);
  if ('bindOutcome' in latestResult) return latestResult;
  const { latest, childSessionId, obligationType: oType, rawFindings } = latestResult;
  const attestation = rawFindings.attestation as Record<string, unknown> | undefined;
  const attestationInfo = resolveAttestationInfo(attestation);
  const obligationMatch = matchBindableObligation(obligations, oType, attestationInfo);
  if ('bindOutcome' in obligationMatch) return obligationMatch;
  const matchedObligation = obligationMatch.obligation;

  // Cycle-binding fields (iteration/planVersion) are reviewer-reliable and stay fatal.
  const fieldMismatch = checkBindingFieldMismatch(rawFindings, matchedObligation, attestationInfo);
  if (fieldMismatch) return fieldMismatch;

  // Host-only constants (mandateDigest/criteriaVersion/reviewedBy) are installed-mandate
  // values the host already owns; they are NOT reviewer-chosen. The LLM reviewer cannot
  // reliably echo a 64-hex digest it was never given and tends to confabulate it, so we
  // bind host-authoritatively and overwrite them — mirroring how reviewedBy.sessionId is
  // overwritten in orchestrator.structuredReviewerResult. Divergence is surfaced for
  // diagnostics rather than fatally rejected.
  const hostConstantDivergence = hostConstantDivergentFields(matchedObligation, attestation);

  const normalizedFindings = normalizeHostTaskFindings(
    rawFindings,
    matchedObligation,
    attestationInfo.hasValidAttestation,
    childSessionId,
    now,
  );

  const findingsHash = hashFindings(normalizedFindings);
  const duplicate = checkDuplicateHostTaskEvidence(
    invocations,
    matchedObligation,
    childSessionId,
    findingsHash,
  );
  if (duplicate) return duplicate;

  const promptHash = hashText(
    `${oType}:${matchedObligation.iteration}:${matchedObligation.planVersion}`,
  );

  // F8: findings recovered from an embedded/brace-balanced block (mixed model
  // output) are downgraded from structured_high so the audit trail reflects the
  // lower provenance confidence. The whole transport contract must agree — a
  // recovered block was NOT clean structured output, so reviewOutputMode,
  // structuredOutputUsed, and extractionMethod are set consistently rather than
  // left at their structured-output defaults. Binding still proceeds.
  const recovered = latest.capturedFindings?.extractionMethod === 'recovered_block';
  const transport = recovered
    ? {
        reviewAssuranceLevel: 'structured_recovered' as const,
        reviewOutputMode: 'text_compat' as const,
        structuredOutputUsed: false,
        extractionMethod: 'outermost_braces' as const,
      }
    : { reviewAssuranceLevel: 'structured_high' as const };

  const evidence = buildInvocationEvidence({
    obligationId: matchedObligation.obligationId,
    obligationType: oType,
    parentSessionId: sessionId,
    childSessionId,
    invocationMode: 'host_subagent_task',
    hostVisible: true,
    promptHash,
    findingsHash,
    invokedAt: now,
    source: 'host-orchestrated',
    ...transport,
    capturedVerdict: latest.capturedFindings?.overallVerdict,
    capturedRawFindings: normalizedFindings,
    ...getBranchProvenanceFields(matchedObligation),
  });

  return {
    evidence,
    bindOutcome: 'bound',
    diagnostic: {
      obligationId: matchedObligation.obligationId,
      childSessionId,
      findingsHash,
      bindingMode: attestationInfo.hasValidAttestation ? 'attestation' : 'tool_fallback',
      ...(hostConstantDivergence.length > 0 ? { hostConstantDivergence } : {}),
    },
  };
}

type PendingReviewRecord =
  SessionEnforcementState['pendingReviews'] extends Map<unknown, infer V> ? V : never;

function latestBindableReviewRecord(state: SessionEnforcementState):
  | {
      latest: PendingReviewRecord;
      childSessionId: string;
      obligationType: ReviewObligation['obligationType'];
      rawFindings: Record<string, unknown>;
    }
  | HostTaskBindResult {
  const allPending = [...state.pendingReviews.values()];
  const matched = allPending.filter(
    (p) => p.subagentCalled && p.subagentRecord !== null && p.capturedFindings?.rawFindings,
  );
  if (matched.length === 0) return noMatchedRecord(allPending);
  const latest = matched.sort((a, b) =>
    (b.subagentRecord?.completedAt ?? '').localeCompare(a.subagentRecord?.completedAt ?? ''),
  )[0]!;
  const childSessionId = latest.subagentRecord?.sessionId;
  if (!childSessionId) return noChildSession(latest.tool);
  const obligationType =
    latest.tool === TOOL_FLOWGUARD_REVIEW ? 'review' : obligationTypeForTool(latest.tool);
  if (!obligationType) return noObligationType(latest.tool);
  const rawFindings = latest.capturedFindings?.rawFindings;
  if (!rawFindings) return noFindings(latest.tool, childSessionId);
  return { latest, childSessionId, obligationType, rawFindings };
}

function noMatchedRecord(allPending: PendingReviewRecord[]): HostTaskBindResult {
  return {
    evidence: null,
    bindOutcome: 'no_matched_record',
    diagnostic: {
      pendingCount: allPending.length,
      calledCount: allPending.filter((p) => p.subagentCalled).length,
    },
  };
}

function noChildSession(tool: string): HostTaskBindResult {
  return { evidence: null, bindOutcome: 'no_child_session', diagnostic: { tool } };
}

function noObligationType(tool: string): HostTaskBindResult {
  return { evidence: null, bindOutcome: 'no_obligation_type', diagnostic: { tool } };
}

function noFindings(tool: string, childSessionId: string): HostTaskBindResult {
  return { evidence: null, bindOutcome: 'no_findings', diagnostic: { tool, childSessionId } };
}

function resolveAttestationInfo(attestation: Record<string, unknown> | undefined): {
  attestedObligationId: string | null;
  hasValidAttestation: boolean;
} {
  const attestedObligationId =
    typeof attestation?.toolObligationId === 'string' ? attestation.toolObligationId : null;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return {
    attestedObligationId,
    hasValidAttestation: !!attestedObligationId && uuidRe.test(attestedObligationId),
  };
}

function matchBindableObligation(
  obligations: ReviewObligation[],
  obligationType: ReviewObligation['obligationType'],
  attestationInfo: ReturnType<typeof resolveAttestationInfo>,
): { obligation: ReviewObligation } | HostTaskBindResult {
  const obligation = attestationInfo.hasValidAttestation
    ? obligations.find((o) =>
        isMatchingAttestedObligation(o, obligationType, attestationInfo.attestedObligationId),
      )
    : latestToolMatchedObligation(obligations, obligationType);
  return obligation
    ? { obligation }
    : noMatchingObligation(obligations, obligationType, attestationInfo);
}

function isMatchingAttestedObligation(
  obligation: ReviewObligation,
  obligationType: ReviewObligation['obligationType'],
  attestedObligationId: string | null,
): boolean {
  return (
    obligation.obligationId === attestedObligationId &&
    obligation.obligationType === obligationType &&
    obligation.status !== 'consumed' &&
    obligation.consumedAt === null
  );
}

function latestToolMatchedObligation(
  obligations: ReviewObligation[],
  obligationType: ReviewObligation['obligationType'],
): ReviewObligation | undefined {
  return obligations
    .filter(
      (o) =>
        o.obligationType === obligationType && o.status !== 'consumed' && o.consumedAt === null,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function noMatchingObligation(
  obligations: ReviewObligation[],
  obligationType: ReviewObligation['obligationType'],
  attestationInfo: ReturnType<typeof resolveAttestationInfo>,
): HostTaskBindResult {
  return {
    evidence: null,
    bindOutcome: 'no_matching_obligation',
    diagnostic: {
      attestedObligationId: attestationInfo.attestedObligationId,
      obligationType,
      availableObligations: obligations.length,
      bindingMode: attestationInfo.hasValidAttestation ? 'attestation' : 'tool_fallback',
    },
  };
}

function checkBindingFieldMismatch(
  rawFindings: Record<string, unknown>,
  obligation: ReviewObligation,
  attestationInfo: ReturnType<typeof resolveAttestationInfo>,
): HostTaskBindResult | null {
  const mismatchFields = bindingMismatchFields(rawFindings, obligation);
  if (mismatchFields.length === 0) return null;
  return {
    evidence: null,
    bindOutcome: 'field_mismatch',
    diagnostic: {
      attestedObligationId: attestationInfo.attestedObligationId,
      mismatchFields,
      bindingMode: attestationInfo.hasValidAttestation ? 'attestation' : 'tool_fallback',
    },
  };
}

/**
 * Fatal binding fields. Only the cycle-binding fields (iteration/planVersion) are checked:
 * they prove which review cycle the reviewer addressed and the reviewer echoes them
 * reliably. Host-only constants are handled separately and host-authoritatively (see
 * {@link hostConstantDivergentFields}).
 */
function bindingMismatchFields(
  rawFindings: Record<string, unknown>,
  obligation: ReviewObligation,
): string[] {
  const fields: string[] = [];
  if (rawFindings.iteration !== obligation.iteration) fields.push('iteration');
  if (rawFindings.planVersion !== obligation.planVersion) fields.push('planVersion');
  return fields;
}

/**
 * Host-only attestation constants the reviewer is asked to echo but does not choose.
 * In host-task capture mode these are authoritative on the host (installed-mandate
 * digest, criteria version, reviewer identity) and are enforced by install-time hash
 * guards — not by the reviewer's echo. A divergence means the reviewer confabulated a
 * value it was never given; it is advisory (diagnostics only), never fatal.
 */
function hostConstantDivergentFields(
  obligation: ReviewObligation,
  attestation: Record<string, unknown> | undefined,
): string[] {
  if (!attestation) return [];
  const fields: string[] = [];
  if (attestation.mandateDigest !== obligation.mandateDigest) fields.push('mandateDigest');
  if (attestation.criteriaVersion !== obligation.criteriaVersion) fields.push('criteriaVersion');
  if (attestation.reviewedBy !== REVIEWER_SUBAGENT_TYPE) fields.push('reviewedBy');
  return fields;
}

/**
 * Overwrite reviewer-authored provenance with host-authoritative values (F8).
 *
 * The reviewer subagent (an LLM) MUST NOT be an authority for the review
 * execution time or its own session identity. It routinely confabulates both
 * (e.g. reviewedAt="...T00:00:00Z", reviewedBy.sessionId="flowguard-reviewer-session").
 * The host owns the truthful values: the real invocation timestamp (`now`) and
 * the resolved child session id. We stamp those and preserve the original
 * (untrusted) reviewer claims in `reviewerClaimedAt` / `reviewerClaimedBy` for
 * diagnostics only.
 *
 * Host-only attestation constants (mandateDigest/criteriaVersion/reviewedBy
 * literal) are overwritten with the obligation's canonical values, while the
 * reviewer-reliable binding anchors (toolObligationId, iteration, planVersion)
 * are preserved as-is.
 */
function normalizeHostTaskFindings(
  rawFindings: Record<string, unknown>,
  obligation: ReviewObligation,
  hasValidAttestation: boolean,
  childSessionId: string,
  now: string,
): Record<string, unknown> {
  const provenance = applyHostProvenance(rawFindings, childSessionId, now);
  if (!hasValidAttestation) {
    const { attestation: _omit, ...rest } = provenance;
    return rest;
  }
  const attestation = (provenance.attestation ?? {}) as Record<string, unknown>;
  return {
    ...provenance,
    attestation: {
      ...attestation,
      mandateDigest: obligation.mandateDigest,
      criteriaVersion: obligation.criteriaVersion,
      reviewedBy: REVIEWER_SUBAGENT_TYPE,
    },
  };
}

/**
 * Replace model-authored `reviewedAt` / `reviewedBy` with host-authoritative
 * values, retaining the model's originals as untrusted `reviewerClaimedAt` /
 * `reviewerClaimedBy` diagnostics (F8).
 *
 * The ENTIRE reviewedBy block is host-constructed — not just sessionId. A model
 * that echoes the real child session id could otherwise still fabricate actorId,
 * actorSource, or actorAssurance (e.g. actorSource="verified_identity",
 * actorAssurance="cryptographic") and have them persisted as canonical
 * provenance. reviewerClaimedBy always preserves the complete original model
 * block whenever the model supplied one, independent of any field comparison.
 */
function applyHostProvenance(
  rawFindings: Record<string, unknown>,
  childSessionId: string,
  now: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...rawFindings };

  const claimedAt = rawFindings.reviewedAt;
  if (typeof claimedAt === 'string' && claimedAt && claimedAt !== now) {
    result.reviewerClaimedAt = claimedAt;
  }
  result.reviewedAt = now;

  const claimedBy = rawFindings.reviewedBy;
  // Preserve the complete original model block whenever one was supplied — not
  // only when the claimed sessionId diverges. actorId/actorSource/actorAssurance
  // can be confabulated even when the sessionId happens to match.
  if (claimedBy && typeof claimedBy === 'object' && !Array.isArray(claimedBy)) {
    result.reviewerClaimedBy = claimedBy;
  }
  result.reviewedBy = buildHostReviewedBy(childSessionId);

  return result;
}

/**
 * Build the fully host-authoritative `reviewedBy` block. Every field is a
 * host-known value; NOTHING is carried over from the model payload. When the
 * host has no independently-resolved reviewer identity, neutral truthful values
 * are used that describe exactly what the host knows: the reviewer is the
 * flowguard-reviewer subagent bound to the resolved child session, with an
 * unverified (best-effort) identity assurance.
 *
 * - actorId: the canonical reviewer subagent type (host-known).
 * - actorSource: 'unknown' — the host did not independently verify the actor's
 *   identity source (the ReviewActorInfo enum has no dedicated host-task value;
 *   'unknown' is the truthful neutral choice rather than an invented one).
 * - actorAssurance: 'best_effort' — session-bound but not identity-verified.
 */
function buildHostReviewedBy(childSessionId: string): Record<string, unknown> {
  return {
    sessionId: childSessionId,
    actorId: REVIEWER_SUBAGENT_TYPE,
    actorSource: 'unknown',
    actorAssurance: 'best_effort',
  };
}

function checkDuplicateHostTaskEvidence(
  invocations: ReviewInvocationEvidence[],
  obligation: ReviewObligation,
  childSessionId: string,
  findingsHash: string,
): HostTaskBindResult | null {
  const duplicate = invocations.some(
    (inv) =>
      inv.obligationId === obligation.obligationId &&
      inv.childSessionId === childSessionId &&
      inv.findingsHash === findingsHash,
  );
  return duplicate
    ? {
        evidence: null,
        bindOutcome: 'duplicate_evidence',
        diagnostic: { childSessionId, findingsHash, obligationId: obligation.obligationId },
      }
    : null;
}
