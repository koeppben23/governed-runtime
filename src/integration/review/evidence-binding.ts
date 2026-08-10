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
import { REVIEWER_SUBAGENT_TYPE, TOOL_FLOWGUARD_REVIEW } from '../tool-names.js';
import { obligationTypeForTool } from './obligation-tools.js';
import { buildInvocationEvidence, hashFindings, hashText } from './assurance.js';
import { getBranchProvenanceFields } from './review-provenance.js';
import {
  checkChallengeContract,
  normalizeFindingsChallenges,
} from './enforcement/challenge-binding.js';
import {
  validateReviewFindingsConsistency,
  validateReviewFindingsScope,
  type FindingWithRelation,
} from './enforcement/findings-consistency.js';
import {
  ReviewActorInfo,
  ReviewFindings as ReviewFindingsSchema,
} from '../../state/evidence-review.js';

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

  // Host-only constants (mandateDigest/criteriaVersion/reviewedBy) are installed-mandate
  // values the host already owns; they are NOT reviewer-chosen. The LLM reviewer cannot
  // reliably echo a 64-hex digest it was never given and tends to confabulate it, so we
  // bind host-authoritatively and overwrite them — mirroring how reviewedBy.sessionId is
  // overwritten in orchestrator.structuredReviewerResult. Divergence is surfaced for
  // diagnostics rather than fatally rejected.
  const hostConstantDivergence = hostConstantDivergentFields(matchedObligation, attestation);

  const prepared = prepareBindableFindings({
    rawFindings,
    obligation: matchedObligation,
    hasValidAttestation: attestationInfo.hasValidAttestation,
    childSessionId,
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
    hostConstantDivergence,
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
  hostConstantDivergence: readonly string[];
  attestationInfo: AttestationInfo;
  now: string;
  allowedEvidenceRefs?: readonly unknown[];
}): HostTaskBindResult & { attempt?: ReviewAttempt } {
  const { latest, childSessionId, oType, obligation, findingsHash, now } = input;
  const promptHash = hashText(`${oType}:${obligation.iteration}:${obligation.planVersion}`);

  const evidence = buildInvocationEvidence({
    obligationId: obligation.obligationId,
    obligationType: oType,
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
      ...(input.hostConstantDivergence.length > 0
        ? { hostConstantDivergence: input.hostConstantDivergence }
        : {}),
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
interface AttestationInfo {
  attestedObligationId: string | null;
  hasValidAttestation: boolean;
}

function resolveAttestationInfo(attestation: Record<string, unknown> | undefined): AttestationInfo {
  const attestedObligationId =
    typeof attestation?.toolObligationId === 'string' ? attestation.toolObligationId : null;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return {
    attestedObligationId,
    hasValidAttestation: !!attestedObligationId && uuidRe.test(attestedObligationId),
  };
}

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
 * Host-only attestation constants the reviewer is asked to echo but does not choose.
 * In host-task capture mode these are authoritative on the host (installed-mandate
 * digest, criteria version, reviewer identity) and are enforced by install-time hash
 * guards — not by the reviewer's echo. A divergence means the reviewer confabulated a
 * value it was never given; it is advisory (diagnostics only), never fatal.
 */
function hostConstantDivergentFields(
  obligation: ReviewObligation,
  attestation: Record<string, unknown> | undefined,
): string[] {
  if (!attestation) return [];
  const fields: string[] = [];
  if (attestation.mandateDigest !== obligation.mandateDigest) fields.push('mandateDigest');
  if (attestation.criteriaVersion !== obligation.criteriaVersion) fields.push('criteriaVersion');
  if (attestation.reviewedBy !== REVIEWER_SUBAGENT_TYPE) fields.push('reviewedBy');
  return fields;
}

/**
 * Overwrite reviewer-authored provenance with host-authoritative values (F8).
 *
 * The reviewer subagent (an LLM) MUST NOT be an authority for the review
 * execution time or its own session identity. It routinely confabulates both
 * (e.g. reviewedAt="...T00:00:00Z", reviewedBy.sessionId="flowguard-reviewer-session").
 * The host owns the truthful values: the real invocation timestamp (`now`) and
 * the resolved child session id. We stamp those and preserve the original
 * (untrusted) reviewer claims in `reviewerClaimedAt` / `reviewerClaimedBy` for
 * diagnostics only.
 *
 * Host-only attestation constants (mandateDigest/criteriaVersion/reviewedBy
 * literal) are overwritten with the obligation's canonical values, while the
 * reviewer-reliable binding anchors (toolObligationId, iteration, planVersion)
 * are preserved as-is.
 */
function normalizeHostTaskFindings(
  rawFindings: Record<string, unknown>,
  obligation: ReviewObligation,
  hasValidAttestation: boolean,
  childSessionId: string,
  now: string,
): Record<string, unknown> {
  const provenance = applyHostProvenance(rawFindings, childSessionId, now);
  if (!hasValidAttestation) {
    const { attestation: _omit, ...rest } = provenance;
    return rest;
  }
  const attestation = (provenance.attestation ?? {}) as Record<string, unknown>;
  return {
    ...provenance,
    attestation: {
      ...attestation,
      mandateDigest: obligation.mandateDigest,
      criteriaVersion: obligation.criteriaVersion,
      reviewedBy: REVIEWER_SUBAGENT_TYPE,
    },
  };
}

/**
 * Replace model-authored `reviewedAt` / `reviewedBy` with host-authoritative
 * values, retaining the model's originals as untrusted `reviewerClaimedAt` /
 * `reviewerClaimedBy` diagnostics (F8).
 *
 * The ENTIRE reviewedBy block is host-constructed — not just sessionId. A model
 * that echoes the real child session id could otherwise still fabricate actorId,
 * actorSource, or actorAssurance (e.g. actorSource="verified_identity",
 * actorAssurance="cryptographic") and have them persisted as canonical
 * provenance. reviewerClaimedBy always preserves the complete original model
 * block whenever the model supplied one, independent of any field comparison.
 */
function applyHostProvenance(
  rawFindings: Record<string, unknown>,
  childSessionId: string,
  now: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...rawFindings };

  const claimedAt = rawFindings.reviewedAt;
  if (typeof claimedAt === 'string' && claimedAt && claimedAt !== now) {
    result.reviewerClaimedAt = claimedAt;
  }
  result.reviewedAt = now;

  const claimedBy = rawFindings.reviewedBy;
  // Preserve the complete original model block whenever one was supplied — not
  // only when the claimed sessionId diverges. actorId/actorSource/actorAssurance
  // can be confabulated even when the sessionId happens to match.
  //
  // `reviewerClaimedBy` is diagnostics-only and never audit authority, so it must
  // never be able to fail the bind: a reviewer that emits a malformed block (for
  // example `reviewedBy: {}`) would otherwise make the whole invocation
  // schema_invalid even though the host-authoritative `reviewedBy` below is
  // correct. Retain it only when it actually satisfies the actor shape.
  if (claimedBy && typeof claimedBy === 'object' && !Array.isArray(claimedBy)) {
    if (ReviewActorInfo.safeParse(claimedBy).success) {
      result.reviewerClaimedBy = claimedBy;
    } else {
      delete result.reviewerClaimedBy;
    }
  }
  result.reviewedBy = buildHostReviewedBy(childSessionId);

  return result;
}

/**
 * Build the fully host-authoritative `reviewedBy` block. Every field is a
 * host-known value; NOTHING is carried over from the model payload. When the
 * host has no independently-resolved reviewer identity, neutral truthful values
 * are used that describe exactly what the host knows: the reviewer is the
 * flowguard-reviewer subagent bound to the resolved child session, with an
 * unverified (best-effort) identity assurance.
 *
 * - actorId: the canonical reviewer subagent type (host-known).
 * - actorSource: 'unknown' — the host did not independently verify the actor's
 *   identity source (the ReviewActorInfo enum has no dedicated host-task value;
 *   'unknown' is the truthful neutral choice rather than an invented one).
 * - actorAssurance: 'best_effort' — session-bound but not identity-verified.
 */
function buildHostReviewedBy(childSessionId: string): Record<string, unknown> {
  return {
    sessionId: childSessionId,
    actorId: REVIEWER_SUBAGENT_TYPE,
    actorSource: 'unknown',
    actorAssurance: 'best_effort',
  };
}

/**
 * Turn raw reviewer output into findings that may be persisted as evidence.
 *
 * Ordering is a correctness contract, not a preference:
 *  1. Host provenance overwrites reviewer-authored identity and timestamps.
 *  2. Challenge identity is minted host-side. The canonical prompt asks for a
 *     `clientReference` slug and never for a `challengeId`, so skipping this
 *     makes EVERY prompt-compliant reviewer output `schema_invalid`.
 *  3. The canonical schema gate runs — the single authority on payload validity.
 *  4. The obligation's frozen challenge contract is checked, so evidence that
 *     the verdict is guaranteed to reject never consumes the attempt.
 *
 * @returns The bindable findings, or the rejection that stops the bind.
 */
function prepareBindableFindings(input: {
  rawFindings: Record<string, unknown>;
  obligation: ReviewObligation;
  hasValidAttestation: boolean;
  childSessionId: string;
  now: string;
  allowedEvidenceRefs?: readonly unknown[];
}): { findings: Record<string, unknown> } | HostTaskBindResult {
  const { rawFindings, obligation, hasValidAttestation, childSessionId, now, allowedEvidenceRefs } =
    input;

  const provenanceFindings = normalizeHostTaskFindings(
    rawFindings,
    obligation,
    hasValidAttestation,
    childSessionId,
    now,
  );

  const normalization = normalizeFindingsChallenges(
    provenanceFindings,
    obligation.obligationId,
    childSessionId,
    allowedEvidenceRefs,
  );
  if ('bindOutcome' in normalization) return normalization;
  const schemaCheck = validateNormalizedFindings(
    normalization.findings,
    obligation.obligationId,
    childSessionId,
  );
  if ('bindOutcome' in schemaCheck) return schemaCheck;
  const findings = schemaCheck.findings;

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
  });
  if (!scopeResult.ok) return scopeFailure(scopeResult, childSessionId, obligation.obligationId);
  return { findings };
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

function validateNormalizedFindings(
  normalizedFindings: Record<string, unknown>,
  obligationId: string,
  childSessionId: string,
): HostTaskBindResult | { findings: Record<string, unknown> } {
  const schemaResult = ReviewFindingsSchema.safeParse(normalizedFindings);
  if (!schemaResult.success) {
    const issues = schemaResult.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    return {
      evidence: null,
      bindOutcome: 'schema_invalid',
      diagnostic: {
        childSessionId,
        obligationId,
        schemaErrors: issues.slice(0, 10),
        message: 'Reviewer output failed schema validation before binding',
      },
    };
  }
  return { findings: schemaResult.data };
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
