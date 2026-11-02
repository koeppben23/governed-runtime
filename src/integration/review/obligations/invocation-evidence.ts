/** Canonical invocation-evidence constructor; transport generation stays explicit. */
import { randomUUID } from 'node:crypto';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import type { ReviewInvocationEvidence } from '../../../state/evidence-review-invocation.js';
import type { ReviewObligationType } from '../../../state/evidence.js';

/** Build canonical invocation evidence for the current review transport generation. */
export function buildInvocationEvidence(input: {
  obligationId: string;
  obligationType: ReviewObligationType;
  mandateDigest: string;
  criteriaVersion: string;
  parentSessionId: string;
  childSessionId: string;
  promptHash: string;
  canonicalPromptDigest?: string;
  modelPromptDigest?: string | null;
  findingsHash: string;
  invokedAt: string;
  fulfilledAt?: string;
  capturedRawFindings: Record<string, unknown>;
  capture: ReviewInvocationEvidence['capture'];
  nativeProvenance?: ReviewInvocationEvidence['nativeProvenance'];
  resolvedBranchSha?: string | null;
  resolvedBaseSha?: string | null;
  reviewedContentDigest?: string | null;
  attemptId: string;
}): ReviewInvocationEvidence {
  const capturedVerdict = input.capturedRawFindings.overallVerdict;
  const native = input.nativeProvenance !== undefined;
  return {
    invocationId: randomUUID(),
    obligationId: input.obligationId,
    obligationType: input.obligationType,
    parentSessionId: input.parentSessionId,
    childSessionId: input.childSessionId,
    agentType: REVIEWER_SUBAGENT_TYPE,
    // One native child; the transport generation names how its JSON was proven.
    invocationMode: native ? 'native_subagent_message_json' : 'native_task_message_json',
    transportVersion: native ? 6 : 5,
    capture: input.capture,
    ...(input.nativeProvenance !== undefined ? { nativeProvenance: input.nativeProvenance } : {}),
    hostVisible: true,
    transcriptNavigable: true,
    promptHash: input.promptHash,
    canonicalPromptDigest: input.canonicalPromptDigest,
    modelPromptDigest: input.modelPromptDigest,
    mandateDigest: input.mandateDigest,
    criteriaVersion: input.criteriaVersion,
    findingsHash: input.findingsHash,
    invokedAt: input.invokedAt,
    fulfilledAt: input.fulfilledAt ?? null,
    consumedByObligationId: null,
    capturedRawFindings: input.capturedRawFindings,
    ...(typeof capturedVerdict === 'string' ? { capturedVerdict } : {}),
    source: 'host-orchestrated',
    reviewOutputMode: 'validated_json',
    reviewAssuranceLevel: 'host_message_validated',
    resolvedBranchSha: input.resolvedBranchSha ?? null,
    resolvedBaseSha: input.resolvedBaseSha ?? null,
    reviewedContentDigest: input.reviewedContentDigest ?? null,
    attemptId: input.attemptId,
  };
}
