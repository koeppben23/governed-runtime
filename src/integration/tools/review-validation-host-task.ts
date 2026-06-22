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
export function resolveHostTaskFindings(
  assurance: ReviewAssuranceState | undefined,
  obligation: ReviewObligation | null,
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
  for (const invocation of matchingInvocations) {
    const invocationRejection = getReviewFindingsAcceptanceRejection({ obligation, invocation });
    if (invocationRejection) {
      return { kind: 'rejected', rejection: withHostTaskPath(invocationRejection) };
    }

    // Parse through ReviewFindings schema for type safety and validation.
    // safeParse: if the raw findings are malformed (missing required fields,
    // invalid types), return not_found so the caller falls back to BLOCKED.
    const parsed = ReviewFindingsSchema.safeParse(invocation.capturedRawFindings);
    if (parsed.success) {
      return {
        kind: 'resolved',
        findings: parsed.data,
        invocation,
        invocationId: invocation.invocationId,
      };
    }
    // Diagnostic for error analysis: captured findings are PRESENT (filter above
    // requires capturedRawFindings != null) but FAIL schema validation. Without
    // this, a garbled host capture is indistinguishable from "no evidence at all"
    // (both degrade to not_found -> REVIEW_FINDINGS_REQUIRED). Surface it.
    getAdapterLogger().warn(
      'flowguard_review',
      'host-task captured findings present but unparseable; treated as not_found',
      {
        obligationId: obligation.obligationId,
        invocationId: invocation.invocationId,
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 8),
      },
    );
  }

  return { kind: 'not_found' };
}
