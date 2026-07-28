/**
 * @module integration/tools/review-validation-host-task
 * @description Host-task review findings resolution — reads captured raw
 *              findings from invocation evidence for host_task_required mode.
 *
 * Extracted from review-validation.ts. The final acceptance/rejection
 * authority remains there. Imports only from state, shared, and the
 * leaf acceptance module — no dependency on the core validation module.
 *
 * @version v1
 */

import type { ReviewFindings } from '../../state/evidence.js';
import { ReviewFindings as ReviewFindingsSchema } from '../../state/evidence.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import type {
  ReviewAssuranceState,
  ReviewObligation,
  ReviewInvocationEvidence,
} from '../../state/evidence.js';
import {
  getReviewFindingsAcceptanceRejection,
  withHostTaskPath,
  type HostTaskFindingsAcceptanceRejection,
} from './review-validation-acceptance.js';
import { validateChallengeConsistency } from '../review/enforcement/challenge-consistency.js';
import { validateReviewFindingsConsistency } from '../review/enforcement/findings-consistency.js';

/**
 * Result of resolving review findings from host-task invocation evidence.
 */
export interface ResolvedHostTaskFindings {
  /** Parsed ReviewFindings from the evidence's capturedRawFindings. */
  readonly findings: ReviewFindings;
  /** Invocation evidence record used for direct obligation consumption. */
  readonly invocation: ReviewInvocationEvidence;
  /** InvocationId of the evidence record. */
  readonly invocationId: string;
}

export type HostTaskFindingsResolution =
  | ({ readonly kind: 'resolved' } & ResolvedHostTaskFindings)
  | { readonly kind: 'rejected'; readonly rejection: HostTaskFindingsAcceptanceRejection }
  | { readonly kind: 'unparseable'; readonly detail: string }
  | {
      readonly kind: 'incoherent';
      readonly code: string;
      readonly details: Record<string, unknown>;
      /** Compatibility projection for the original verdict/blocker invariant. */
      readonly blockingIssueCount?: number;
    }
  | { readonly kind: 'not_found' };

/**
 * Resolve review findings from host-task invocation evidence.
 *
 * For `host_task_required` mode, the plugin stores the complete raw findings
 * in the invocation evidence (`capturedRawFindings`). This function reads and
 * validates them, eliminating agent-side reconstruction of the ReviewFindings
 * object — the primary remaining failure point after Stufe 1.
 *
 * The returned `invocationId` is used for direct obligation consumption,
 * bypassing `findAcceptedInvocationForFindings` (which would require hash
 * comparison against the Zod-parsed object, reintroducing the key-order problem).
 *
 * @param assurance - Review assurance state with obligations and invocations
 * @param obligation - The pending/fulfilled obligation to resolve findings for
 * @returns Parsed findings + invocationId, or null if evidence is unavailable
 */
// The resolver enumerates every persisted capture so an unusable record cannot
// mask a later coherent retry; its branches are the explicit fail-closed states.
// eslint-disable-next-line complexity, max-lines-per-function
export function resolveHostTaskFindings(
  assurance: ReviewAssuranceState | undefined,
  obligation: ReviewObligation | null,
  unresolvedImplementationChallengeIds?: readonly string[],
  allowedChallengeEvidenceRefs?: readonly unknown[],
  unaddressedPriorFailIds?: readonly string[],
  previouslyUsedChallengeIds?: readonly string[],
): HostTaskFindingsResolution {
  if (!obligation || !assurance) return { kind: 'not_found' };

  const obligationRejection = getReviewFindingsAcceptanceRejection({ obligation });
  if (obligationRejection) {
    return { kind: 'rejected', rejection: withHostTaskPath(obligationRejection) };
  }

  const matchingInvocations = assurance.invocations.filter(
    (inv) =>
      inv.obligationId === obligation.obligationId &&
      inv.invocationMode === 'host_subagent_task' &&
      inv.hostVisible === true &&
      inv.capturedRawFindings != null,
  );
  // Track the first unparseable capture so the caller can emit a DISTINCT
  // HOST_TASK_FINDINGS_UNPARSEABLE block instead of a generic "no evidence"
  // REVIEW_FINDINGS_REQUIRED. Without this, a garbled host capture is
  // indistinguishable from "no evidence at all" in the tool output (both
  // historically degraded to not_found), which is exactly the confusing
  // failure operators hit when the reviewer ran but its findings were corrupt.
  let unparseableDetail: string | null = null;
  let incoherent: { code: string; details: Record<string, unknown> } | null = null;
  // An unusable earlier capture must not deadlock a later coherent retry. The
  // earlier evidence remains persisted for audit while this loop continues to
  // consider subsequent captures for the same obligation.
  for (const invocation of matchingInvocations) {
    const invocationRejection = getReviewFindingsAcceptanceRejection({ obligation, invocation });
    if (invocationRejection) {
      return { kind: 'rejected', rejection: withHostTaskPath(invocationRejection) };
    }

    // Parse through ReviewFindings schema for type safety and validation.
    // safeParse: if the raw findings are malformed (missing required fields,
    // invalid types), surface it as `unparseable` so the caller falls back to
    // a distinct BLOCKED code (not silent not_found).
    const parsed = ReviewFindingsSchema.safeParse(invocation.capturedRawFindings);
    if (parsed.success) {
      // F12: coherence of the host-captured record. An `accept` verdict that
      // still carries blocking issues is self-contradictory and must fail closed
      // before the findings are treated as valid evidence — this is the host-task
      // ingestion boundary (verdict-only submission never reaches the tool-layer
      // validateReviewFindings coherence check). Canonical rule in
      // findings-consistency.ts.
      const consistency = validateReviewFindingsConsistency({
        overallVerdict: parsed.data.overallVerdict,
        blockingIssueCount: parsed.data.blockingIssues.length,
      });
      if (!consistency.ok) {
        incoherent ??= { code: consistency.code, details: consistency.details };
        continue;
      }
      const challengeConsistency = validateChallengeConsistency({
        overallVerdict: parsed.data.overallVerdict,
        requiredChallengeCount: obligation.requiredChallengeCount ?? 0,
        requiredChallengeKind: obligation.requiredChallengeKind ?? 'implementation_challenge',
        challenges: parsed.data.challenges,
        expectedObligationId: obligation.obligationId,
        allowedEvidenceRefs: allowedChallengeEvidenceRefs,
        resolutionVerdicts: parsed.data.challengeResolutionVerdicts,
        unresolvedImplementationChallengeIds,
        unaddressedPriorFailIds,
        previouslyUsedChallengeIds,
      });
      if (!challengeConsistency.ok) {
        incoherent ??= { code: challengeConsistency.code, details: challengeConsistency.details };
        continue;
      }
      return {
        kind: 'resolved',
        findings: parsed.data,
        invocation,
        invocationId: invocation.invocationId,
      };
    }
    // Diagnostic for error analysis: captured findings are PRESENT (filter above
    // requires capturedRawFindings != null) but FAIL schema validation. Surface it.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 8);
    unparseableDetail = issues.join('; ') || 'unknown schema validation failure';
    getAdapterLogger().warn(
      'flowguard_review',
      'host-task captured findings present but unparseable; treated as unparseable',
      {
        obligationId: obligation.obligationId,
        invocationId: invocation.invocationId,
        issues,
      },
    );
  }

  if (unparseableDetail !== null) {
    return { kind: 'unparseable', detail: unparseableDetail };
  }
  if (incoherent !== null) {
    return {
      kind: 'incoherent',
      code: incoherent.code,
      details: incoherent.details,
      ...(typeof incoherent.details.blockingIssueCount === 'number'
        ? { blockingIssueCount: incoherent.details.blockingIssueCount }
        : {}),
    };
  }
  return { kind: 'not_found' };
}
