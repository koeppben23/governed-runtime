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
  fulfillObligation,
  hasEvidenceReuse,
  updateAttemptStatus,
} from './assurance.js';
import { completeReviewDispatch } from '../../state/review-continuation.js';
import { hasAuthorizedDispatch } from '../../state/review-dispatch.js';
import { updateObligation } from './obligation-state.js';
import type { ReviewerSuccessResult } from './orchestrator.js';
import type { EvidenceRecordResult, OrchestratorDeps } from './pipeline-types.js';
import type { PipelineContext } from './pipeline-types.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import { validatePreBindFindings, type PreBindFindingsResult } from './pre-bind-findings.js';

type SdkEvidenceParams = {
  obligationId: string;
  obligationType: ReviewObligationType;
  sessionId: string;
  childSessionId: string;
  /**
   * Host call identity of the reviewer dispatch. For SDK child sessions this is
   * the child session id; it must have an `authorized` durable dispatch entry
   * that this recording completes atomically.
   */
  hostCallId: string;
  attemptId: string;
  promptHash: string;
  findingsHash: string;
  invokedAt: string;
  fulfilledAt: string;
  reviewerResult: Omit<
    Pick<
      ReviewerSuccessResult,
      | 'sessionId'
      | 'reviewOutputMode'
      | 'structuredOutputUsed'
      | 'reviewAssuranceLevel'
      | 'findings'
    >,
    'findings'
  > & { findings: Record<string, unknown> };
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
  preBindFailure?: Exclude<PreBindFindingsResult, { readonly ok: true }>;
};

export type SdkEvidenceRecordResult =
  EvidenceRecordResult | Exclude<PreBindFindingsResult, { readonly ok: true }>;

export function buildSdkEvidenceAuditIntents(input: {
  ctx: PipelineContext;
  result: EvidenceRecordResult;
  obligationType: string;
  promptHash: string;
  findingsHash: string;
  reviewerResult: Pick<
    ReviewerSuccessResult,
    'sessionId' | 'reviewOutputMode' | 'structuredOutputUsed' | 'reviewAssuranceLevel'
  >;
  state: SessionState;
  occurredAt: string;
  reviewProfile: string;
}): readonly SemanticAuditIntent[] {
  const {
    ctx,
    result,
    obligationType,
    promptHash,
    findingsHash,
    reviewerResult,
    state,
    occurredAt,
    reviewProfile,
  } = input;
  const { sessionId, reviewCtx } = ctx;
  const detail =
    result === 'reused'
      ? { obligationId: reviewCtx.obligationId, code: 'SUBAGENT_EVIDENCE_REUSED' }
      : {
          obligationId: reviewCtx.obligationId,
          obligationType,
          parentSessionId: sessionId,
          childSessionId: reviewerResult.sessionId,
          agentType: REVIEWER_SUBAGENT_TYPE,
          promptHash,
          mandateDigest: reviewCtx.mandateDigest,
          criteriaVersion: reviewCtx.criteriaVersion,
          findingsHash,
          reviewOutputMode: reviewerResult.reviewOutputMode,
          structuredOutputUsed: reviewerResult.structuredOutputUsed,
          reviewAssuranceLevel: reviewerResult.reviewAssuranceLevel,
          reviewProfile,
        };
  const first: SemanticAuditIntent = {
    phase: state.phase,
    event: result === 'reused' ? 'review:obligation_blocked' : 'review:subagent_invoked',
    occurredAt,
    detail,
  };
  return result === 'fulfilled'
    ? [
        first,
        {
          phase: state.phase,
          event: 'review:obligation_fulfilled',
          occurredAt,
          detail: {
            obligationId: reviewCtx.obligationId,
            childSessionId: reviewerResult.sessionId,
          },
        },
      ]
    : [first];
}

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
    promptHash: params.promptHash,
    findingsHash: params.findingsHash,
    invokedAt: params.invokedAt,
    fulfilledAt: params.fulfilledAt,
    attemptId: params.attemptId,
    capturedRawFindings: params.reviewerResult.findings,
  });
}

/**
 * The attempt must be the exact created, unbound successor of the obligation,
 * and the host call must carry a still-`authorized` durable dispatch for that
 * attempt. No evidence exists without a prior dispatch release.
 */
function resolveEvidenceLineage(
  assurance: ReturnType<typeof ensureReviewAssurance>,
  obligation: { obligationId: string; obligationType: ReviewObligationType; subjectDigest: string },
  params: SdkEvidenceParams,
): { attemptId: string } | null {
  const attempt = assurance.attempts.find((item) => item.attemptId === params.attemptId);
  const lineageMatches =
    attempt?.obligationId === obligation.obligationId &&
    attempt.obligationType === obligation.obligationType &&
    attempt.subjectDigest === obligation.subjectDigest &&
    attempt.status === 'created' &&
    attempt.childSessionId === undefined;
  if (!lineageMatches || !attempt) return null;
  if (!hasAuthorizedDispatch(assurance, params.hostCallId, attempt.attemptId)) {
    return null;
  }
  return { attemptId: attempt.attemptId };
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
  const lineage = resolveEvidenceLineage(assurance, obligation, params);
  if (!lineage) {
    flags.lineageUnavailable = true;
    return state;
  }
  const attempt = assurance.attempts.find((item) => item.attemptId === lineage.attemptId);
  if (!attempt) {
    flags.lineageUnavailable = true;
    return state;
  }
  const preBind = validatePreBindFindings({
    findings: params.reviewerResult.findings,
    obligation,
    attempt,
    childSessionId: params.childSessionId,
  });
  if (!preBind.ok) {
    flags.preBindFailure = preBind;
    return state;
  }

  const invocation = buildSdkSessionInvocation(params, obligation);
  const boundAssurance = updateAttemptStatus(
    assurance,
    lineage.attemptId,
    'bound',
    params.fulfilledAt,
    { childSessionId: params.childSessionId },
  );
  // Attempt binding, invocation evidence, dispatch completion, and obligation
  // fulfillment are ONE mutation: the ledger can never diverge from evidence.
  const withInvocation = {
    ...state,
    reviewAssurance: completeReviewDispatch(
      appendInvocationEvidence(boundAssurance, invocation),
      params.hostCallId,
      params.fulfilledAt,
    ),
  };
  return {
    ...withInvocation,
    reviewAssurance: fulfillObligation(
      withInvocation.reviewAssurance,
      params.obligationId,
      invocation.invocationId,
      now,
    ),
  };
}

function resultFromFlags(flags: MutationFlags): SdkEvidenceRecordResult {
  if (flags.preBindFailure) return flags.preBindFailure;
  if (flags.missing) return 'missing';
  if (flags.lineageUnavailable) return 'lineage_unavailable';
  if (flags.reused) return 'reused';
  return 'fulfilled';
}

export async function recordEvidenceOrBlockReuse(
  deps: OrchestratorDeps,
  sessDir: string,
  params: SdkEvidenceParams,
): Promise<SdkEvidenceRecordResult> {
  const flags: MutationFlags = { reused: false, missing: false, lineageUnavailable: false };
  await deps.updateReviewAssurance(
    sessDir,
    (state, now) => applyEvidenceMutation(state, now, params, flags),
    (state, now) => {
      const result = resultFromFlags(flags);
      return typeof result !== 'string' ||
        result === 'missing' ||
        result === 'lineage_unavailable' ||
        !params.semanticIntents
        ? []
        : params.semanticIntents(result, state, now);
    },
  );
  return resultFromFlags(flags);
}
