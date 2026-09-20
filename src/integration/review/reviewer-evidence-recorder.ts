/**
 * @module integration/review/reviewer-evidence-recorder
 * @description Atomic persistence of reviewer evidence and attempt lineage.
 *
 * The mutation authority is transport-neutral but bound to the visible native
 * Task lifecycle: callers supply the exact host execution facts observed at the
 * Task before/after boundary.
 */

import type { ReviewObligationType } from '../../state/evidence.js';
import type { ReviewInvocationEvidence } from '../../state/evidence-review-invocation.js';
import {
  appendInvocationEvidence,
  consumeReviewObligation,
  buildInvocationEvidence,
  ensureReviewAssurance,
  fulfillObligation,
  hasEvidenceReuse,
  updateAttemptStatus,
} from './assurance.js';
import {
  completeReviewDispatch,
  rebindReviewDispatchHostCall,
} from '../../state/review-continuation.js';
import { hasAuthorizedDispatch } from '../../state/review-dispatch.js';
import { updateObligation } from './obligation-state.js';
import type { ReviewerSuccessResult } from './types.js';
import type { SemanticAuditIntent } from '../audit-outbox.js';
import type { SessionState } from '../../state/schema.js';
import type { EvidenceRecordResult, OrchestratorDeps } from './pipeline-types.js';
import { validatePreBindFindings, type PreBindFindingsResult } from './pre-bind-findings.js';

type AuditableEvidenceRecordResult = Extract<EvidenceRecordResult, 'fulfilled' | 'reused'>;

type SdkEvidenceParams = {
  obligationId: string;
  obligationType: ReviewObligationType;
  sessionId: string;
  childSessionId: string;
  /** Bound host call identity (child session) whose dispatch this evidence closes. */
  hostCallId: string;
  /**
   * Pre-release host call identity the dispatch was authorized under when it
   * differs from the final child session identity (native Task call ID). The
   * binding mutation rebinds the authorized dispatch to `hostCallId`.
   */
  authorizedHostCallId?: string;
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
    result: AuditableEvidenceRecordResult,
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

function buildReviewInvocation(
  params: SdkEvidenceParams,
  obligation: { mandateDigest: string; criteriaVersion: string },
): ReviewInvocationEvidence {
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
  const authorizedHostCallId = params.authorizedHostCallId ?? params.hostCallId;
  if (!hasAuthorizedDispatch(assurance, authorizedHostCallId, attempt.attemptId)) {
    return null;
  }
  return { attemptId: attempt.attemptId };
}

function settleBoundEvidence(
  assurance: ReturnType<typeof ensureReviewAssurance>,
  obligation: Parameters<typeof consumeReviewObligation>[1],
  params: SdkEvidenceParams,
  invocationId: string,
  now: string,
): ReturnType<typeof ensureReviewAssurance> {
  const unableToReview =
    params.obligationType === 'review' &&
    params.reviewerResult.findings.overallVerdict === 'unable_to_review';
  return unableToReview
    ? consumeReviewObligation(assurance, obligation, now, invocationId)
    : fulfillObligation(assurance, params.obligationId, invocationId, now);
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

  const invocation = buildReviewInvocation(params, obligation);
  const boundAssurance = updateAttemptStatus(
    assurance,
    lineage.attemptId,
    'bound',
    params.fulfilledAt,
    { childSessionId: params.childSessionId },
  );
  // Attempt binding, invocation evidence, and dispatch completion are ONE
  // mutation: the ledger can never diverge from evidence.
  const withBoundDispatch = params.authorizedHostCallId
    ? rebindReviewDispatchHostCall(boundAssurance, params.authorizedHostCallId, params.hostCallId)
    : boundAssurance;
  const withInvocation = {
    ...state,
    reviewAssurance: completeReviewDispatch(
      appendInvocationEvidence(withBoundDispatch, invocation),
      params.hostCallId,
      params.fulfilledAt,
    ),
  };
  return {
    ...withInvocation,
    reviewAssurance: settleBoundEvidence(
      withInvocation.reviewAssurance,
      obligation,
      params,
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
