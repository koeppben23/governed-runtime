/**
 * @module integration/tools/review-validation-structured-evidence
 * @description Structured review findings resolution from SDK invocation evidence.
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
  ReviewAttempt,
  ReviewObligation,
  ReviewInvocationEvidence,
} from '../../state/evidence.js';
import {
  getReviewFindingsAcceptanceRejection,
  hasValidStructuredInvocationContract,
  type ReviewFindingsAcceptanceRejection,
} from './review-validation-acceptance.js';
import { validateChallengeConsistency } from '../review/enforcement/challenge-consistency.js';
import { validateReviewFindingsConsistency } from '../review/enforcement/findings-consistency.js';
import { hashFindings } from '../review/findings-hash.js';
import { bindCanonicalEvidenceRefs } from '../review/enforcement/challenge-binding.js';

/**
 * Result of resolving review findings from structured invocation evidence.
 */
export interface ResolvedStructuredFindings {
  /** Parsed ReviewFindings from the evidence's capturedRawFindings. */
  readonly findings: ReviewFindings;
  /** Invocation evidence record used for direct obligation consumption. */
  readonly invocation: ReviewInvocationEvidence;
  /** InvocationId of the evidence record. */
  readonly invocationId: string;
}

export type StructuredFindingsResolution =
  | ({ readonly kind: 'resolved' } & ResolvedStructuredFindings)
  | { readonly kind: 'rejected'; readonly rejection: ReviewFindingsAcceptanceRejection }
  | { readonly kind: 'unparseable'; readonly detail: string }
  | {
      readonly kind: 'incoherent';
      readonly code: string;
      readonly details: Record<string, unknown>;
      readonly invocationId: string;
      readonly attemptId: string;
      /** Current diagnostic projection of the findings consistency failure. */
      readonly blockingIssueCount?: number;
    }
  | {
      readonly kind: 'invalid';
      readonly code: 'REVIEW_FINDINGS_HASH_MISMATCH' | 'SUBAGENT_EVIDENCE_MISSING';
      readonly obligationId: string;
    }
  | {
      readonly kind: 'attempt_lineage_unavailable';
      readonly invocationId: string;
      readonly obligationId: string;
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
// eslint-disable-next-line complexity, max-lines-per-function
export function resolveStructuredFindings(
  assurance: ReviewAssuranceState | undefined,
  obligation: ReviewObligation | null,
  ...[
    unresolvedImplementationChallengeIds,
    allowedChallengeEvidenceRefs,
    unaddressedPriorFailIds,
    previouslyUsedChallengeIds,
    parentSessionId,
  ]: readonly [
    (readonly string[] | undefined)?,
    (readonly unknown[] | undefined)?,
    (readonly string[] | undefined)?,
    (readonly string[] | undefined)?,
    (string | undefined)?,
  ]
): StructuredFindingsResolution {
  if (!obligation || !assurance) return { kind: 'not_found' };

  const obligationRejection = getReviewFindingsAcceptanceRejection({ obligation });
  if (obligationRejection) {
    return { kind: 'rejected', rejection: obligationRejection };
  }

  const matchingInvocations = assurance.invocations.filter(
    (inv) =>
      inv.obligationId === obligation.obligationId &&
      inv.invocationMode === 'sdk_session_prompt' &&
      inv.capturedRawFindings != null,
  );
  // Track the first unparseable capture so the caller can emit a DISTINCT
  // HOST_TASK_FINDINGS_UNPARSEABLE block instead of a generic "no evidence"
  // REVIEW_FINDINGS_REQUIRED. Without this, a garbled host capture is
  // indistinguishable from "no evidence at all" in the tool output (both
  // historically degraded to not_found), which is exactly the confusing
  // failure operators hit when the reviewer ran but its findings were corrupt.
  let unparseableDetail: string | null = null;
  let incoherent: {
    code: string;
    details: Record<string, unknown>;
    invocationId: string;
    attemptId: string;
  } | null = null;
  let unavailableLineage: {
    invocationId: string;
    obligationId: string;
  } | null = null;
  // An unusable earlier capture must not deadlock a later coherent retry. The
  // earlier evidence remains persisted for audit while this loop continues to
  // consider subsequent captures for the same obligation.
  for (const invocation of matchingInvocations) {
    const capturedRawFindings = invocation.capturedRawFindings;
    if (!capturedRawFindings) continue;
    const invocationRejection = getReviewFindingsAcceptanceRejection({ obligation, invocation });
    if (invocationRejection) {
      return { kind: 'rejected', rejection: invocationRejection };
    }

    if (!hasValidStructuredInvocationContract({ obligation, invocation, parentSessionId })) {
      continue;
    }

    if (!hasExactBoundAttempt(assurance.attempts, obligation, invocation)) {
      unavailableLineage ??= {
        invocationId: invocation.invocationId,
        obligationId: obligation.obligationId,
      };
      continue;
    }

    // Parse through ReviewFindings schema for type safety and validation.
    // safeParse: if the raw findings are malformed (missing required fields,
    // invalid types), surface it as `unparseable` so the caller falls back to
    // a distinct BLOCKED code (not silent not_found).
    const parsed = ReviewFindingsSchema.safeParse(capturedRawFindings);
    if (parsed.success) {
      if (hashFindings(capturedRawFindings) !== invocation.findingsHash) {
        return {
          kind: 'invalid',
          code: 'REVIEW_FINDINGS_HASH_MISMATCH',
          obligationId: obligation.obligationId,
        };
      }
      if (
        invocation.capturedVerdict !== undefined &&
        invocation.capturedVerdict !== parsed.data.overallVerdict
      ) {
        return {
          kind: 'invalid',
          code: 'REVIEW_FINDINGS_HASH_MISMATCH',
          obligationId: obligation.obligationId,
        };
      }
      if (parsed.data.reviewedBy.sessionId !== invocation.childSessionId) {
        return {
          kind: 'invalid',
          code: 'SUBAGENT_EVIDENCE_MISSING',
          obligationId: obligation.obligationId,
        };
      }
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
        incoherent ??= {
          code: consistency.code,
          details: consistency.details,
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
        };
        continue;
      }
      // Host-authoritative evidence identity. This path validates the RAW
      // reviewer submission (`capturedRawFindings`) against the frozen
      // challenge contract by exact canonical JSON, unlike the review binding
      // seam which first rebinds refs to the host's canonical copies. A
      // `plan_adr_section` ref carries presentation-only fields —
      // `sectionPath[].headingText` and `excerptDigest` — that add no locating
      // power, because `artifactDigest` plus heading depth and sibling index
      // already identify the section. Comparing them exactly meant a heading
      // reproduced without its backticks failed as `evidence_mismatch` and
      // killed the session. Rebind through the same canonical authority the
      // binding seam uses. A ref genuinely outside the contract does not
      // rebind; the raw refs are then kept so the unchanged exact check below
      // still rejects it.
      const challengesForConsistency = ((): typeof parsed.data.challenges => {
        if (!allowedChallengeEvidenceRefs) {
          return parsed.data.challenges;
        }
        const rebound = bindCanonicalEvidenceRefs(
          parsed.data.challenges,
          allowedChallengeEvidenceRefs,
          obligation.obligationId,
          // Only used for a rejection diagnostic, which this path discards in
          // favour of the unchanged consistency check below.
          parentSessionId ?? '',
        );
        return 'bindOutcome' in rebound
          ? parsed.data.challenges
          : (rebound.challenges as typeof parsed.data.challenges);
      })();
      const challengeConsistency = validateChallengeConsistency({
        overallVerdict: parsed.data.overallVerdict,
        requiredChallengeCount: obligation.requiredChallengeCount,
        requiredChallengeKind: obligation.requiredChallengeKind ?? 'implementation_challenge',
        challenges: challengesForConsistency,
        expectedObligationId: obligation.obligationId,
        allowedEvidenceRefs: allowedChallengeEvidenceRefs,
        resolutionVerdicts: parsed.data.challengeResolutionVerdicts,
        unresolvedImplementationChallengeIds,
        unaddressedPriorFailIds,
        previouslyUsedChallengeIds,
      });
      if (!challengeConsistency.ok) {
        incoherent ??= {
          code: challengeConsistency.code,
          details: challengeConsistency.details,
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
        };
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
      'structured captured findings present but unparseable; treated as unparseable',
      {
        obligationId: obligation.obligationId,
        invocationId: invocation.invocationId,
        issues,
      },
    );
  }

  if (unavailableLineage !== null) {
    return {
      kind: 'attempt_lineage_unavailable',
      invocationId: unavailableLineage.invocationId,
      obligationId: unavailableLineage.obligationId,
    };
  }
  if (incoherent !== null) {
    return {
      kind: 'incoherent',
      code: incoherent.code,
      details: incoherent.details,
      invocationId: incoherent.invocationId,
      attemptId: incoherent.attemptId,
      ...(typeof incoherent.details.blockingIssueCount === 'number'
        ? { blockingIssueCount: incoherent.details.blockingIssueCount }
        : {}),
    };
  }
  if (unparseableDetail !== null) {
    return { kind: 'unparseable', detail: unparseableDetail };
  }
  if (matchingInvocations.length > 0) {
    return {
      kind: 'invalid',
      code: 'SUBAGENT_EVIDENCE_MISSING',
      obligationId: obligation.obligationId,
    };
  }
  return { kind: 'not_found' };
}

/**
 * The evidence consumer must independently verify the binding minted by the
 * structured-capture boundary. Never recover an invocation by searching for a
 * merely compatible attempt: invocation.attemptId is the authority key.
 */
function hasExactBoundAttempt(
  attempts: readonly ReviewAttempt[],
  obligation: ReviewObligation,
  invocation: ReviewInvocationEvidence,
): boolean {
  const attempt = attempts.find((item) => item.attemptId === invocation.attemptId);
  return (
    invocation.obligationType === obligation.obligationType &&
    attempt?.status === 'bound' &&
    attempt.obligationId === obligation.obligationId &&
    attempt.obligationType === obligation.obligationType &&
    attempt.subjectDigest === obligation.subjectDigest &&
    attempt.childSessionId === invocation.childSessionId
  );
}
