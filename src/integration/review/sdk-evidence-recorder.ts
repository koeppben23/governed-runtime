/**
 * @module integration/review/sdk-evidence-recorder
 * @description Atomic persistence of SDK reviewer evidence and attempt lineage.
 */

import type { ReviewObligationType } from '../../state/evidence.js';
import type { SessionState } from '../../state/schema.js';
import type { SemanticAuditIntent } from '../tools/audit-outbox.js';
import {
  appendInvocationEvidence,
  buildInvocationEvidence,
  ensureReviewAssurance,
  hasEvidenceReuse,
  updateAttemptStatus,
} from './assurance.js';
import { updateObligation } from './obligation-state.js';
import type { ReviewerSuccessResult } from './orchestrator.js';
import { EVIDENCE_SOURCE_HOST, INVOCATION_MODE_SDK_SESSION } from './pipeline-types.js';
import type { EvidenceRecordResult, OrchestratorDeps } from './pipeline-types.js';

type SdkEvidenceParams = {
  obligationId: string;
  obligationType: ReviewObligationType;
  sessionId: string;
  childSessionId: string;
  attemptId: string;
  promptHash: string;
  findingsHash: string;
  invokedAt: string;
  fulfilledAt: string;
  reviewerResult: Pick<
    ReviewerSuccessResult,
    | 'sessionId'
    | 'reviewOutputMode'
    | 'structuredOutputUsed'
    | 'reviewAssuranceLevel'
    | 'extractionMethod'
    | 'modelCapabilityError'
    | 'findings'
  >;
  semanticIntents?: (
    result: EvidenceRecordResult,
    state: SessionState,
    now: string,
  ) => readonly SemanticAuditIntent[];
};

type MutationFlags = {
  reused: boolean;
  missing: boolean;
  lineageUnavailable: boolean;
};

function buildSdkSessionInvocation(
  params: SdkEvidenceParams,
  obligation: { mandateDigest: string; criteriaVersion: string },
): ReturnType<typeof buildInvocationEvidence> {
  return buildInvocationEvidence({
    obligationId: params.obligationId,
    obligationType: params.obligationType,
    mandateDigest: obligation.mandateDigest,
    criteriaVersion: obligation.criteriaVersion,
    parentSessionId: params.sessionId,
    childSessionId: params.childSessionId,
    invocationMode: INVOCATION_MODE_SDK_SESSION,
    hostVisible: false,
    promptHash: params.promptHash,
    findingsHash: params.findingsHash,
    invokedAt: params.invokedAt,
    fulfilledAt: params.fulfilledAt,
    attemptId: params.attemptId,
    source: EVIDENCE_SOURCE_HOST,
    reviewOutputMode: params.reviewerResult.reviewOutputMode,
    structuredOutputUsed: params.reviewerResult.structuredOutputUsed,
    reviewAssuranceLevel: params.reviewerResult.reviewAssuranceLevel,
    extractionMethod: params.reviewerResult.extractionMethod,
    modelCapabilityError: params.reviewerResult.modelCapabilityError,
    capturedVerdict:
      params.reviewerResult.findings &&
      typeof params.reviewerResult.findings.overallVerdict === 'string'
        ? params.reviewerResult.findings.overallVerdict
        : undefined,
  });
}

function applyEvidenceMutation(
  state: SessionState,
  now: string,
  params: SdkEvidenceParams,
  flags: MutationFlags,
): SessionState {
  const assurance = ensureReviewAssurance(state.reviewAssurance);
  const obligation = assurance.obligations.find(
    (item) => item.obligationId === params.obligationId,
  );
  if (!obligation) {
    flags.missing = true;
    return state;
  }
  if (hasEvidenceReuse(assurance.invocations, params.childSessionId, params.findingsHash)) {
    flags.reused = true;
    return updateObligation(state, params.obligationId, (item) => ({
      ...item,
      status: 'blocked',
      blockedCode: 'SUBAGENT_EVIDENCE_REUSED',
    }));
  }
  const attempt = assurance.attempts.find((item) => item.attemptId === params.attemptId);
  const lineageMatches =
    attempt?.obligationId === obligation.obligationId &&
    attempt.obligationType === obligation.obligationType &&
    attempt.subjectDigest === obligation.subjectDigest &&
    attempt.status === 'created' &&
    attempt.childSessionId === undefined;
  if (!lineageMatches || !attempt) {
    flags.lineageUnavailable = true;
    return state;
  }

  const invocation = buildSdkSessionInvocation(params, obligation);
  const boundAssurance = updateAttemptStatus(
    assurance,
    attempt.attemptId,
    'bound',
    params.fulfilledAt,
    { childSessionId: params.childSessionId },
  );
  const withInvocation = {
    ...state,
    reviewAssurance: appendInvocationEvidence(boundAssurance, invocation),
  };
  return updateObligation(withInvocation, params.obligationId, (item) => ({
    ...item,
    status: 'fulfilled',
    invocationId: invocation.invocationId,
    fulfilledAt: now,
  }));
}

function resultFromFlags(flags: MutationFlags): EvidenceRecordResult {
  if (flags.missing) return 'missing';
  if (flags.lineageUnavailable) return 'lineage_unavailable';
  if (flags.reused) return 'reused';
  return 'fulfilled';
}

export async function recordEvidenceOrBlockReuse(
  deps: OrchestratorDeps,
  sessDir: string,
  params: SdkEvidenceParams,
): Promise<EvidenceRecordResult> {
  const flags: MutationFlags = { reused: false, missing: false, lineageUnavailable: false };
  await deps.updateReviewAssurance(
    sessDir,
    (state, now) => applyEvidenceMutation(state, now, params, flags),
    (state, now) => {
      const result = resultFromFlags(flags);
      return result === 'missing' || result === 'lineage_unavailable' || !params.semanticIntents
        ? []
        : params.semanticIntents(result, state, now);
    },
  );
  return resultFromFlags(flags);
}
