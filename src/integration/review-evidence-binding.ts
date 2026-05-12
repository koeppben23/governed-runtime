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

import type { ReviewInvocationEvidence, ReviewObligation } from '../state/evidence.js';
import type { SessionEnforcementState, HostTaskBindResult } from './review-enforcement-types.js';
import { REVIEWER_SUBAGENT_TYPE, TOOL_FLOWGUARD_REVIEW } from './tool-names.js';
import { obligationTypeForTool } from './review-obligation-tools.js';
import { buildInvocationEvidence, hashFindings, hashText } from './review-assurance.js';

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
  const allPending = [...state.pendingReviews.values()];
  const matched = allPending.filter(
    (p) => p.subagentCalled && p.subagentRecord !== null && p.capturedFindings?.rawFindings,
  );
  if (matched.length === 0) {
    return {
      evidence: null,
      bindOutcome: 'no_matched_record',
      diagnostic: {
        pendingCount: allPending.length,
        calledCount: allPending.filter((p) => p.subagentCalled).length,
      },
    };
  }

  const latest = matched.sort((a, b) =>
    (b.subagentRecord?.completedAt ?? '').localeCompare(a.subagentRecord?.completedAt ?? ''),
  )[0]!;

  const childSessionId = latest.subagentRecord!.sessionId;
  if (!childSessionId) {
    return {
      evidence: null,
      bindOutcome: 'no_child_session',
      diagnostic: { tool: latest.tool },
    };
  }

  const oType =
    latest.tool === TOOL_FLOWGUARD_REVIEW ? 'review' : obligationTypeForTool(latest.tool);
  if (!oType) {
    return {
      evidence: null,
      bindOutcome: 'no_obligation_type',
      diagnostic: { tool: latest.tool },
    };
  }

  const rawFindings = latest.capturedFindings?.rawFindings;
  if (!rawFindings) {
    return {
      evidence: null,
      bindOutcome: 'no_findings',
      diagnostic: { tool: latest.tool, childSessionId },
    };
  }
  const attestation = rawFindings.attestation as Record<string, unknown> | undefined;
  const attestedObligationId =
    typeof attestation?.toolObligationId === 'string' ? attestation.toolObligationId : null;

  // BUG-20: Validate attestation contains a proper UUID.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const hasValidAttestation = attestedObligationId !== null && UUID_RE.test(attestedObligationId);

  let matchedObligation: ReviewObligation | undefined;

  if (hasValidAttestation) {
    // Primary path: attestation-based matching (SDK path, well-behaved reviewers).
    matchedObligation = obligations.find(
      (o) =>
        o.obligationId === attestedObligationId &&
        o.obligationType === oType &&
        o.status !== 'consumed' &&
        o.consumedAt === null,
    );
    if (!matchedObligation) {
      return {
        evidence: null,
        bindOutcome: 'no_matching_obligation',
        diagnostic: {
          attestedObligationId,
          obligationType: oType,
          availableObligations: obligations.length,
          bindingMode: 'attestation',
        },
      };
    }
  } else {
    // BUG-20 Fallback: tool-based obligation matching when attestation is absent or invalid.
    matchedObligation = obligations
      .filter((o) => o.obligationType === oType && o.status !== 'consumed' && o.consumedAt === null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!matchedObligation) {
      return {
        evidence: null,
        bindOutcome: 'no_matching_obligation',
        diagnostic: {
          attestedObligationId,
          obligationType: oType,
          availableObligations: obligations.length,
          bindingMode: 'tool_fallback',
        },
      };
    }
  }

  // Field consistency checks — verify findings match the obligation's context.
  const mismatchFields: string[] = [];
  if (rawFindings.iteration !== matchedObligation.iteration) mismatchFields.push('iteration');
  if (rawFindings.planVersion !== matchedObligation.planVersion) mismatchFields.push('planVersion');
  // BUG-20: Only check attestation-specific fields when a valid attestation is present.
  if (hasValidAttestation) {
    if (attestation?.mandateDigest !== matchedObligation.mandateDigest)
      mismatchFields.push('mandateDigest');
    if (attestation?.criteriaVersion !== matchedObligation.criteriaVersion)
      mismatchFields.push('criteriaVersion');
    if (attestation?.reviewedBy !== REVIEWER_SUBAGENT_TYPE) mismatchFields.push('reviewedBy');
  }
  if (mismatchFields.length > 0) {
    return {
      evidence: null,
      bindOutcome: 'field_mismatch',
      diagnostic: {
        attestedObligationId,
        mismatchFields,
        bindingMode: hasValidAttestation ? 'attestation' : 'tool_fallback',
      },
    };
  }

  // BUG-20b: Normalize raw findings before hash computation and storage.
  const normalizedFindings = hasValidAttestation
    ? rawFindings
    : (() => {
        const { attestation: _, ...rest } = rawFindings;
        return rest;
      })();

  const findingsHash = hashFindings(normalizedFindings);
  if (
    invocations.some(
      (inv) =>
        inv.obligationId === matchedObligation.obligationId &&
        inv.childSessionId === childSessionId &&
        inv.findingsHash === findingsHash,
    )
  ) {
    return {
      evidence: null,
      bindOutcome: 'duplicate_evidence',
      diagnostic: {
        childSessionId,
        findingsHash,
        obligationId: matchedObligation.obligationId,
      },
    };
  }

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
      bindingMode: hasValidAttestation ? 'attestation' : 'tool_fallback',
    },
  };
}
