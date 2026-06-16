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
    capturedVerdict: latest.capturedFindings?.overallVerdict,
    capturedRawFindings: normalizedFindings,
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

function normalizeHostTaskFindings(
  rawFindings: Record<string, unknown>,
  obligation: ReviewObligation,
  hasValidAttestation: boolean,
): Record<string, unknown> {
  if (!hasValidAttestation) {
    const { attestation: _omit, ...rest } = rawFindings;
    return rest;
  }
  // Overwrite reviewer-echoed host constants with the obligation's canonical values so
  // persisted evidence is truthful rather than confabulated. The reviewer-reliable
  // binding anchors (toolObligationId, iteration, planVersion) are preserved as-is.
  const attestation = (rawFindings.attestation ?? {}) as Record<string, unknown>;
  return {
    ...rawFindings,
    attestation: {
      ...attestation,
      mandateDigest: obligation.mandateDigest,
      criteriaVersion: obligation.criteriaVersion,
      reviewedBy: REVIEWER_SUBAGENT_TYPE,
    },
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
