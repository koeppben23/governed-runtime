/**
 * @module integration/review-evidence-binding
 * @description Host-task evidence binding for review enforcement.
 *
 * Pure function — reads enforcement state but does not mutate it.
 */

import type {
  ReviewInvocationEvidence,
  ReviewObligation,
  ReviewAttempt,
} from '../../state/evidence.js';
import type { SessionEnforcementState, HostTaskBindResult } from './enforcement/types.js';
import { TOOL_FLOWGUARD_REVIEW } from '../tool-names.js';
import { obligationTypeForTool } from './obligation-tools.js';
import { buildInvocationEvidence, hashFindings, hashText } from './assurance.js';
import { getBranchProvenanceFields } from './review-provenance.js';
import {
  checkChallengeContract,
  bindCanonicalEvidenceRefs,
} from './enforcement/challenge-binding.js';
import {
  prepareReviewerFindingsForValidation,
  resolveAttestationInfo,
} from './enforcement/prepare-findings.js';
import {
  validateReviewFindingsConsistency,
  validateReviewFindingsScope,
  type FindingWithRelation,
} from './enforcement/findings-consistency.js';
import { bindRepositoryEvidenceLocations } from './observation-binding.js';

/** Transport contract for captured findings: recovered findings downgrade assurance. */
function transportContract(latest: PendingReviewRecord) {
  return latest.capturedFindings?.extractionMethod === 'recovered_block'
    ? {
        reviewAssuranceLevel: 'structured_recovered' as const,
        reviewOutputMode: 'text_compat' as const,
        structuredOutputUsed: false,
        extractionMethod: 'outermost_braces' as const,
      }
    : { reviewAssuranceLevel: 'structured_high' as const };
}

/** Mark an attempt as spent so a later callback from it is hard-rejected. */
function staleAttempt(attempt: ReviewAttempt, now: string): ReviewAttempt {
  return { ...attempt, status: 'rejected' as const, completedAt: now };
}

/** A rejection that also stales the attempt that produced it. */
function attemptRejection(
  attempt: ReviewAttempt,
  now: string,
  bindOutcome: HostTaskBindResult['bindOutcome'],
  diagnostic: Record<string, unknown>,
): HostTaskBindResult & { attempt: ReviewAttempt; obligation?: undefined } {
  return {
    evidence: null,
    bindOutcome,
    diagnostic,
    attempt: staleAttempt(attempt, now),
  };
}

/**
 * Validate that `attempt` may carry evidence for the obligation it names.
 *
 * Returns a rejection block, or the obligation the attempt is bound to. Kept
 * separate from the binding body so each fail-closed rule stays individually
 * readable: attempt-first resolution is the security boundary of this module.
 */
function resolveObligationForAttempt(
  attempt: ReviewAttempt,
  obligations: ReviewObligation[],
  oType: ReviewObligation['obligationType'],
  attestationInfo: AttestationInfo,
  now: string,
):
  | { obligation: ReviewObligation }
  | (HostTaskBindResult & { attempt?: ReviewAttempt; obligation?: undefined }) {
  const bindingMode = bindingModeOf(attestationInfo);
  const obligation = obligations.find((o) => o.obligationId === attempt.obligationId);
  if (!obligation) {
    return attemptRejection(attempt, now, 'no_matching_obligation', {
      attemptId: attempt.attemptId,
      obligationId: attempt.obligationId,
      attestedObligationId: attestationInfo.attestedObligationId,
      obligationType: oType,
      availableObligations: obligations.length,
      bindingMode,
      message: 'Attempt references an obligation that does not exist in the current state.',
    });
  }

  // A consumed obligation has already been decided; attaching further evidence
  // to it would let a late or repeated callback reopen a closed review.
  if (obligation.status === 'consumed') {
    return attemptRejection(attempt, now, 'no_matching_obligation', {
      attemptId: attempt.attemptId,
      obligationId: obligation.obligationId,
      obligationStatus: obligation.status,
      bindingMode,
      message: 'Attempt references an obligation that was already consumed.',
    });
  }

  // An attempt for a 'plan' obligation cannot bind evidence from an
  // 'implementation' tool invocation.
  if (obligation.obligationType !== oType) {
    return attemptRejection(attempt, now, 'field_mismatch', {
      attemptId: attempt.attemptId,
      attemptObligationType: attempt.obligationType,
      enforcementObligationType: oType,
      bindingMode,
      message: 'Attempt obligation type does not match the enforcement tool type.',
    });
  }

  // If the reviewer attested to a specific obligation, it must be the one the
  // attempt was created for.
  if (
    attestationInfo.hasValidAttestation &&
    attestationInfo.attestedObligationId !== attempt.obligationId
  ) {
    return attemptRejection(attempt, now, 'field_mismatch', {
      attemptId: attempt.attemptId,
      attestedObligationId: attestationInfo.attestedObligationId,
      attemptObligationId: attempt.obligationId,
      bindingMode,
      message: 'Reviewer attested to a different obligation than the one bound to this attempt.',
    });
  }

  // Subject-digest binding: the attempt's frozen subject digest must name the
  // same artifact as the obligation, preventing cross-artifact attachment.
  if (attempt.subjectDigest !== obligation.subjectDigest) {
    return subjectMismatchBlock(
      obligation.subjectDigest,
      attempt.subjectDigest,
      obligation.obligationId,
      attempt,
      now,
    );
  }

  return { obligation };
}

export function buildHostTaskEvidence(
  state: SessionEnforcementState,
  sessionId: string,
  now: string,
  records: {
    readonly obligations: ReviewObligation[];
    readonly invocations: ReviewInvocationEvidence[];
    readonly attempts: readonly ReviewAttempt[];
    readonly allowedEvidenceRefs?: readonly unknown[];
  },
): HostTaskBindResult & { attempt?: ReviewAttempt } {
  const { obligations, invocations, attempts, allowedEvidenceRefs } = records;
  const latestResult = latestBindableReviewRecord(state);
  if ('bindOutcome' in latestResult) return latestResult;
  const { latest, childSessionId, obligationType: oType, rawFindings } = latestResult;
  const attestation = rawFindings.attestation as Record<string, unknown> | undefined;
  const attestationInfo = resolveAttestationInfo(attestation);

  // Attempt is the primary binding authority — resolve it FIRST by childSessionId.
  // The obligation is then loaded from the attempt, not matched heuristically.
  const resolvedAttempt = resolveAttemptBySession(attempts, childSessionId);
  if ('bindOutcome' in resolvedAttempt) return resolvedAttempt;
  const attempt = resolvedAttempt.attempt;

  const obligationResult = resolveObligationForAttempt(
    attempt,
    obligations,
    oType,
    attestationInfo,
    now,
  );
  if (!obligationResult.obligation) return obligationResult;
  const matchedObligation = obligationResult.obligation;

  // Cycle-binding fields (iteration/planVersion) are reviewer-reliable and stay fatal.
  const fieldMismatch = checkBindingFieldMismatch(rawFindings, matchedObligation, attestationInfo);
  if (fieldMismatch) return { ...fieldMismatch, attempt: staleAttempt(attempt, now) };

  const prepared = prepareBindableFindings({
    rawFindings,
    obligation: matchedObligation,
    childSessionId,
    attempt,
    now,
    allowedEvidenceRefs,
  });
  if ('bindOutcome' in prepared) {
    const rejectedAttempt =
      prepared.bindOutcome === 'findings_incoherent'
        ? { ...attempt, status: 'rejected' as const, completedAt: now }
        : staleAttempt(attempt, now);
    return { ...prepared, attempt: rejectedAttempt };
  }
  const normalizedFindings = prepared.findings;

  const findingsHash = hashFindings(normalizedFindings);
  const duplicate = checkDuplicateHostTaskEvidence(
    invocations,
    matchedObligation,
    childSessionId,
    findingsHash,
  );
  if (duplicate) return { ...duplicate, attempt };

  return assembleBoundEvidence({
    latest,
    sessionId,
    childSessionId,
    oType,
    attempt,
    obligation: matchedObligation,
    normalizedFindings,
    findingsHash,
    attestationInfo,
    now,
  });
}

/** Build the bound invocation evidence once every fail-closed check has passed. */
function assembleBoundEvidence(input: {
  latest: PendingReviewRecord;
  sessionId: string;
  childSessionId: string;
  oType: ReviewObligation['obligationType'];
  attempt: ReviewAttempt;
  obligation: ReviewObligation;
  normalizedFindings: Record<string, unknown>;
  findingsHash: string;
  attestationInfo: AttestationInfo;
  now: string;
  allowedEvidenceRefs?: readonly unknown[];
}): HostTaskBindResult & { attempt?: ReviewAttempt } {
  const { latest, childSessionId, oType, obligation, findingsHash, now } = input;
  const promptHash = hashText(`${oType}:${obligation.iteration}:${obligation.planVersion}`);

  const evidence = buildInvocationEvidence({
    obligationId: obligation.obligationId,
    obligationType: oType,
    mandateDigest: obligation.mandateDigest,
    criteriaVersion: obligation.criteriaVersion,
    parentSessionId: input.sessionId,
    childSessionId,
    invocationMode: 'host_subagent_task',
    hostVisible: true,
    promptHash,
    findingsHash,
    invokedAt: now,
    source: 'host-orchestrated',
    attemptId: input.attempt.attemptId,
    ...transportContract(latest),
    capturedVerdict: latest.capturedFindings?.overallVerdict,
    capturedRawFindings: input.normalizedFindings,
    ...getBranchProvenanceFields(obligation),
  });

  return {
    evidence,
    bindOutcome: 'bound',
    attempt: input.attempt,
    diagnostic: {
      obligationId: obligation.obligationId,
      childSessionId,
      findingsHash,
      bindingMode: bindingModeOf(input.attestationInfo),
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

function resolveAttemptBySession(
  existingAttempts: readonly ReviewAttempt[],
  childSessionId: string,
): { attempt: ReviewAttempt } | HostTaskBindResult {
  const existing = existingAttempts.find((a) => a.childSessionId === childSessionId);
  if (!existing) {
    return {
      evidence: null,
      bindOutcome: 'unknown_attempt',
      diagnostic: {
        childSessionId,
        message:
          'No attempt record found for this child session. The child session must be bound to an attempt at Task-start time — callbacks without a known invocation are rejected.',
      },
    };
  }
  // Already bound or rejected: idempotent — no re-binding.
  if (existing.status === 'bound' || existing.status === 'rejected') {
    return {
      evidence: null,
      bindOutcome: existing.status === 'bound' ? 'idempotent_bound' : 'idempotent_rejected',
      diagnostic: { attemptId: existing.attemptId, status: existing.status },
    };
  }
  // Stale or expired: refuse binding.
  if (existing.status === 'stale' || existing.status === 'expired') {
    return {
      evidence: null,
      bindOutcome: 'stale_attempt',
      diagnostic: { attemptId: existing.attemptId, status: existing.status },
    };
  }
  return { attempt: existing };
}

/** Reviewer-supplied attestation, reduced to what binding decisions depend on. */
type AttestationInfo = ReturnType<typeof resolveAttestationInfo>;

/**
 * Which provenance carried this binding.
 *
 * The obligation itself is always resolved from the recorded invocation attempt
 * — this value does NOT say how the obligation was chosen. It records whether
 * the reviewer additionally presented a valid self-attestation naming its
 * obligation (`attestation`), or whether the binding rested solely on the
 * host-observed Task correlation (`tool_fallback`).
 *
 * It is emitted on EVERY outcome decided after attestation resolution, not just
 * on success: when a bind fails, knowing whether the reviewer attested at all is
 * the first thing needed to diagnose it.
 */
function bindingModeOf(
  attestationInfo: ReturnType<typeof resolveAttestationInfo>,
): 'attestation' | 'tool_fallback' {
  return attestationInfo.hasValidAttestation ? 'attestation' : 'tool_fallback';
}

function subjectMismatchBlock(
  obligationSubject: string,
  expectedSubject: string,
  obligationId: string,
  attempt: ReviewAttempt | undefined,
  /** Injected host time. No audit outcome of this state machine reads the clock. */
  now: string,
): HostTaskBindResult {
  return {
    evidence: null,
    bindOutcome: 'subject_mismatch',
    diagnostic: {
      obligationId,
      obligationSubject,
      expectedSubject,
      message: 'Obligation subject digest does not match the expected artifact digest',
    },
    ...(attempt ? { attempt: staleAttempt(attempt, now) } : {}),
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
      bindingMode: bindingModeOf(attestationInfo),
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
 * Host provenance stamping, attestation host-constant stamping, challenge
 * identity minting, and the canonical schema gate all live in the single
 * authority `prepareReviewerFindingsForValidation`
 * (enforcement/prepare-findings.ts). This module consumes it and adds only
 * bind-time authorization on top: canonical evidence-ref binding, coherence,
 * the frozen challenge contract, and scope.
 */

/**
 * Turn raw reviewer output into findings that may be persisted as evidence.
 *
 * Ordering is a correctness contract, not a preference:
 *  1. `prepareReviewerFindingsForValidation` — host-owned mechanical
 *     normalization plus the canonical schema gate (single authority on
 *     payload validity).
 *  2. Bind-time authorization: canonical evidence-ref binding
 *     (`challenge_evidence_unknown` is a governance rejection, not a schema
 *     error).
 *  3. Verdict coherence is checked, so internally incoherent evidence never
 *     consumes the attempt.
 *  4. The obligation's frozen challenge contract is checked, so evidence that
 *     the verdict is guaranteed to reject never consumes the attempt.
 *
 * @returns The bindable findings, or the rejection that stops the bind.
 */
function prepareBindableFindings(input: {
  rawFindings: Record<string, unknown>;
  obligation: ReviewObligation;
  childSessionId: string;
  attempt: ReviewAttempt;
  now: string;
  allowedEvidenceRefs?: readonly unknown[];
}): { findings: Record<string, unknown> } | HostTaskBindResult {
  const { rawFindings, obligation, childSessionId, attempt, now, allowedEvidenceRefs } = input;

  const prepared = prepareReviewerFindingsForValidation({
    rawFindings,
    obligationId: obligation.obligationId,
    hostConstants: {
      mandateDigest: obligation.mandateDigest,
      criteriaVersion: obligation.criteriaVersion,
    },
    hostProvenance: { childSessionId, reviewedAt: now },
  });
  if (!prepared.ok)
    return preparedFailureToBindResult(prepared, obligation.obligationId, childSessionId);

  let findings = prepared.findings;
  if (allowedEvidenceRefs) {
    const challenges = Array.isArray(findings.challenges)
      ? (findings.challenges as readonly Record<string, unknown>[])
      : [];
    const canonical = bindCanonicalEvidenceRefs(
      challenges,
      allowedEvidenceRefs,
      obligation.obligationId,
      childSessionId,
    );
    if ('bindOutcome' in canonical) return canonical;
    findings = { ...findings, challenges: canonical.challenges };
  }

  const overallVerdict = findings.overallVerdict;
  const blockingIssues = findings.blockingIssues;
  if (typeof overallVerdict === 'string' && Array.isArray(blockingIssues)) {
    const consistency = validateReviewFindingsConsistency({
      overallVerdict,
      blockingIssueCount: blockingIssues.length,
    });
    if (!consistency.ok) {
      return {
        evidence: null,
        bindOutcome: 'findings_incoherent',
        diagnostic: {
          childSessionId,
          obligationId: obligation.obligationId,
          code: consistency.code,
          ...consistency.details,
          message: 'Reviewer findings are internally incoherent and the attempt was rejected.',
        },
      };
    }
  }
  const contractCheck = checkChallengeContract(findings, obligation, childSessionId);
  if (contractCheck) return contractCheck;
  const scopeResult = validateReviewFindingsScope({
    findings: relationFindings(findings),
    reviewSubjectScope: obligation.reviewSubjectScope,
    repositoryRevisionProvenance: obligation.repositoryRevisionProvenance,
  });
  if (!scopeResult.ok) return scopeFailure(scopeResult, childSessionId, obligation.obligationId);
  return bindEvidenceOrReturn(findings, obligation, attempt, childSessionId);
}

/**
 * Canonical evidence authorization: every cited repository evidenceLocation
 * must match an authoritative Observation of THIS attempt/session against the
 * exact frozen target. Governance rejection — never schema_invalid, never
 * output-repairable.
 */
function bindEvidenceOrReturn(
  findings: Record<string, unknown>,
  obligation: ReviewObligation,
  attempt: ReviewAttempt,
  childSessionId: string,
): { findings: Record<string, unknown> } | HostTaskBindResult {
  const evidenceBinding = bindRepositoryEvidenceLocations({
    findings: relationFindings(findings),
    obligation,
    attempt,
    childSessionId,
  });
  if (!evidenceBinding.ok) {
    return {
      evidence: null,
      bindOutcome: 'repository_evidence_unbound',
      diagnostic: {
        childSessionId,
        obligationId: obligation.obligationId,
        failingIndexes: [...evidenceBinding.failingIndexes],
        reasons: [...evidenceBinding.reasons],
        message:
          'Repository evidenceLocations have no matching authoritative observation for this reviewer attempt.',
      },
    };
  }
  return { findings };
}

/**
 * Map the shared authority's rejection onto the bind-path outcomes with
 * byte-identical diagnostics to the pre-authority contract.
 */
function preparedFailureToBindResult(
  prepared: Exclude<ReturnType<typeof prepareReviewerFindingsForValidation>, { readonly ok: true }>,
  obligationId: string,
  childSessionId: string,
): HostTaskBindResult {
  if (prepared.code === 'client_reference_invalid') {
    return {
      evidence: null,
      bindOutcome: 'client_reference_invalid',
      diagnostic: {
        childSessionId,
        obligationId,
        clientReference: prepared.details.clientReference,
        challengeIndex: prepared.details.index,
        message: `Duplicate clientReference "${prepared.details.clientReference}" in reviewer challenges. Each challenge needs a unique reference.`,
      },
    };
  }
  return {
    evidence: null,
    bindOutcome: 'schema_invalid',
    diagnostic: {
      childSessionId,
      obligationId,
      schemaErrors: [...prepared.issues].slice(0, 10),
      ...(prepared.issueKeys ? { schemaIssueKeys: prepared.issueKeys } : {}),
      message: 'Reviewer output failed schema validation before binding',
    },
  };
}

function relationFindings(findings: Record<string, unknown>): FindingWithRelation[] {
  const relationFindings: FindingWithRelation[] = [];
  [findings.blockingIssues, findings.majorRisks].forEach((arr) => {
    if (Array.isArray(arr))
      arr.forEach((item) => {
        if (item && typeof item === 'object') relationFindings.push(item as FindingWithRelation);
      });
  });
  return relationFindings;
}

function scopeFailure(
  scopeResult: Exclude<ReturnType<typeof validateReviewFindingsScope>, { readonly ok: true }>,
  childSessionId: string,
  obligationId: string,
): HostTaskBindResult {
  const outOfScope = scopeResult.code === 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE';
  return {
    evidence: null,
    bindOutcome: outOfScope ? 'review_finding_out_of_scope' : 'review_finding_scope_unverifiable',
    diagnostic: {
      childSessionId,
      obligationId,
      code: scopeResult.code,
      ...scopeResult.details,
      message: outOfScope
        ? 'Reviewer findings do not relate to the reviewed subject scope.'
        : 'Review finding relation could not be verified for this obligation.',
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
