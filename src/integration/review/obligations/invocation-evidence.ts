/**
 * Canonical invocation-evidence constructor. It writes only the current native
 * generation (6, `native_subagent_message_json`, with mandatory terminal-capture
 * provenance). Historical generation-5 evidence remains readable for archive
 * verification but can never be created again.
 */
import { randomUUID } from 'node:crypto';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import type { ReviewInvocationEvidence } from '../../../state/evidence-review-invocation.js';
import type { ReviewObligationType } from '../../../state/evidence.js';

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
  nativeProvenance: NonNullable<ReviewInvocationEvidence['nativeProvenance']>;
  resolvedBranchSha?: string | null;
  resolvedBaseSha?: string | null;
  reviewedContentDigest?: string | null;
  attemptId: string;
}): ReviewInvocationEvidence {
  const capturedVerdict = input.capturedRawFindings.overallVerdict;
  return {
    invocationId: randomUUID(),
    obligationId: input.obligationId,
    obligationType: input.obligationType,
    parentSessionId: input.parentSessionId,
    childSessionId: input.childSessionId,
    agentType: REVIEWER_SUBAGENT_TYPE,
    invocationMode: 'native_subagent_message_json',
    transportVersion: 6,
    capture: input.capture,
    nativeProvenance: input.nativeProvenance,
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
