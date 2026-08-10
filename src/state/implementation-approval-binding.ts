/**
 * @module implementation-approval-binding
 * @description Central approval binding authority for implementation final approval.
 *
 * SSOT: validateImplementationApprovalBinding() answers:
 *   "Is the current implementation candidate fully authorized for human final
 *    approval by the evidence currently in state?"
 *
 * It is a pure function — does not mutate state, does not access Git.
 * The integration layer resolves the live candidate observation and passes
 * it as host-authoritative input.
 *
 * @version v1
 */

import type { SessionState } from './schema.js';
import type { ImplementationApprovalCertificate } from './evidence-implementation-approval.js';
import { hashText } from '../shared/hashing.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';

// ─── Result Types ──────────────────────────────────────────────────────────────

export interface ValidImplementationApprovalBinding {
  readonly candidateDigest: string;
  readonly contentDigest: string;
  readonly validationAttemptIds: readonly string[];
  readonly reviewObligationId: string;
  readonly reviewAttemptId: string;
  readonly reviewEvidenceDigest: string;
}

export type ImplementationApprovalBindingFailureCode =
  | 'IMPLEMENTATION_CANDIDATE_MISSING'
  | 'IMPLEMENTATION_CANDIDATE_STALE'
  | 'IMPLEMENTATION_VALIDATION_BINDING_INVALID'
  | 'IMPLEMENTATION_REVIEW_BINDING_INVALID'
  | 'IMPLEMENTATION_APPROVAL_BINDING_INVALID';

export interface ImplementationApprovalBindingFailure {
  readonly ok: false;
  readonly code: ImplementationApprovalBindingFailureCode;
  readonly reason: string;
  readonly details?: Record<string, unknown>;
}

export type ImplementationApprovalBindingResult =
  | { readonly ok: true; readonly binding: ValidImplementationApprovalBinding }
  | ImplementationApprovalBindingFailure;

// ─── Observation ───────────────────────────────────────────────────────────────

export interface ImplementationApprovalObservation {
  readonly candidateDigest: string;
  readonly contentDigest: string;
}

// ─── Validation Evidence Resolver ──────────────────────────────────────────────

export interface ValidationBindingResult {
  readonly attemptIds: readonly string[];
}

export interface ValidationBindingFailure {
  readonly missingCheckIds: readonly string[];
}

/**
 * Resolve which immutable validation attempts support the given contentDigest.
 *
 * Only passes validation attempts whose scope is 'implementation' and whose
 * implementationDigest equals contentDigest are authoritative. Attempts for a
 * different contentDigest are historical audit evidence but do not authorize
 * the current candidate.
 */
export function resolveImplementationValidationBinding(
  state: SessionState,
  contentDigest: string,
): ValidationBindingResult | ValidationBindingFailure {
  const validAttempts = state.validationAttempts.filter(
    (a) =>
      a.scope === 'implementation' && a.implementationDigest === contentDigest && a.result.passed,
  );

  const attemptIds = validAttempts.map((a) => a.attemptId);

  if (state.activeChecks.length === 0) {
    return { attemptIds };
  }

  const passedCheckIds = new Set(validAttempts.map((a) => a.result.checkId));
  const missing = state.activeChecks.filter((id) => !passedCheckIds.has(id));

  if (missing.length > 0) {
    return { missingCheckIds: missing };
  }

  return { attemptIds };
}

// ─── Review Lineage Resolver ───────────────────────────────────────────────────

export interface ReviewBindingResult {
  readonly obligationId: string;
  readonly attemptId: string;
  readonly evidenceDigest: string;
}

/**
 * Resolve exact independent review lineage for the given candidateDigest.
 *
 * Requires:
 *  - An obligation with obligationType='implement' and subjectDigest=candidateDigest
 *  - A completed attempt for that obligation with subjectDigest=candidateDigest
 *  - Invocation evidence binding the attempt and obligation
 *
 * No latest-obligation fallback. No timestamp heuristics. Exact match or fail-closed.
 */
export function resolveImplementationReviewBinding(
  state: SessionState,
  candidateDigest: string,
): ReviewBindingResult | null {
  const assurance = state.reviewAssurance;
  if (!assurance) return null;

  const relevantObligations = assurance.obligations.filter(
    (o) =>
      o.obligationType === 'implement' &&
      o.subjectDigest === candidateDigest &&
      (o.status === 'fulfilled' || o.status === 'consumed'),
  );

  if (relevantObligations.length === 0) return null;

  const obligation = relevantObligations[relevantObligations.length - 1]!;

  const relevantAttempts = (obligation.attemptIds ?? [])
    .map((id) => assurance.attempts.find((a) => a.attemptId === id))
    .filter((a): a is NonNullable<typeof a> => a !== undefined)
    .filter(
      (a) => a.subjectDigest === candidateDigest && a.obligationId === obligation.obligationId,
    );

  const completedAttempt = relevantAttempts.find(
    (a) => a.status === 'bound' || a.status === 'captured',
  );

  if (!completedAttempt) return null;

  const invocation = assurance.invocations.find(
    (i) => i.obligationId === obligation.obligationId && i.attemptId === completedAttempt.attemptId,
  );

  if (!invocation) return null;

  return {
    obligationId: obligation.obligationId,
    attemptId: completedAttempt.attemptId,
    evidenceDigest: invocation.findingsHash,
  };
}

// ─── Central Approval Binding Validator ────────────────────────────────────────

/**
 * Validate that the current implementation candidate is fully authorized for
 * human final approval.
 *
 * Checks:
 *  1. Implementation candidate exists in state
 *  2. Live observation matches persisted candidate (candidateDigest)
 *  3. Required validation attempts exist for current contentDigest
 *  4. Independent review obligation + attempt lineage binds current candidateDigest
 *  5. No fallback or heuristic — exact match or fail-closed
 */
export function validateImplementationApprovalBinding(input: {
  readonly state: SessionState;
  readonly observedCandidate?: ImplementationApprovalObservation;
}): ImplementationApprovalBindingResult {
  const { state, observedCandidate } = input;

  const candidate = state.implementationCandidate;
  if (!candidate) {
    return {
      ok: false,
      code: 'IMPLEMENTATION_CANDIDATE_MISSING',
      reason:
        'No implementation candidate is recorded. Run /implement to capture the current candidate.',
    };
  }

  if (!observedCandidate) {
    return {
      ok: false,
      code: 'IMPLEMENTATION_CANDIDATE_STALE',
      reason:
        'Cannot verify that the current repository still matches the recorded candidate. Candidate re-observation is required for final approval.',
    };
  }

  if (observedCandidate.candidateDigest !== candidate.candidateDigest) {
    return {
      ok: false,
      code: 'IMPLEMENTATION_CANDIDATE_STALE',
      reason:
        'The repository has changed since the implementation candidate was recorded. The recorded review evidence does not authorize the current repository state.',
      details: {
        recordedCandidate: candidate.candidateDigest,
        observedCandidate: observedCandidate.candidateDigest,
        recovery: 'Run /implement to record the current candidate and repeat the evidence chain.',
      },
    };
  }

  const contentDigest = candidate.contentDigest;

  const validationBinding = resolveImplementationValidationBinding(state, contentDigest);
  if ('missingCheckIds' in validationBinding && validationBinding.missingCheckIds.length > 0) {
    return {
      ok: false,
      code: 'IMPLEMENTATION_VALIDATION_BINDING_INVALID',
      reason:
        'Not all required validation checks have passing evidence for the current implementation content. Validation evidence must be re-run against the current candidate.',
      details: {
        missingCheckIds: validationBinding.missingCheckIds,
      },
    };
  }

  const reviewBinding = resolveImplementationReviewBinding(state, candidate.candidateDigest);
  if (!reviewBinding) {
    return {
      ok: false,
      code: 'IMPLEMENTATION_REVIEW_BINDING_INVALID',
      reason:
        'No completed independent review obligation binds the current implementation candidate. The implementation must be independently reviewed at its current identity before final approval.',
      details: {
        candidateDigest: candidate.candidateDigest,
      },
    };
  }

  return {
    ok: true,
    binding: {
      candidateDigest: candidate.candidateDigest,
      contentDigest,
      validationAttemptIds: 'attemptIds' in validationBinding ? validationBinding.attemptIds : [],
      reviewObligationId: reviewBinding.obligationId,
      reviewAttemptId: reviewBinding.attemptId,
      reviewEvidenceDigest: reviewBinding.evidenceDigest,
    },
  };
}

// ─── Certificate Construction ──────────────────────────────────────────────────

/**
 * Construct an immutable ImplementationApprovalCertificate from the validated
 * binding and the human decision attestation.
 *
 * The certificateId is a deterministic digest of canonical certificate fields.
 */
export function createImplementationApprovalCertificate(params: {
  readonly binding: ValidImplementationApprovalBinding;
  readonly decision: {
    readonly verdict: string;
    readonly rationale: string;
    readonly decidedAt: string;
    readonly decidedBy: string;
  };
}): ImplementationApprovalCertificate {
  const decisionAttestationDigest = hashText(
    canonicalJsonStringify({
      verdict: params.decision.verdict,
      rationale: params.decision.rationale,
      decidedAt: params.decision.decidedAt,
      decidedBy: params.decision.decidedBy,
    }),
  );

  const sortedAttemptIds = [...params.binding.validationAttemptIds].sort();

  const certificateId = hashText(
    canonicalJsonStringify({
      flow: 'implementation',
      candidateDigest: params.binding.candidateDigest,
      contentDigest: params.binding.contentDigest,
      decisionAttestationDigest,
      reviewObligationId: params.binding.reviewObligationId,
      reviewAttemptId: params.binding.reviewAttemptId,
      reviewEvidenceDigest: params.binding.reviewEvidenceDigest,
      validationAttemptIds: sortedAttemptIds,
      approvedAt: params.decision.decidedAt,
      approvedBy: params.decision.decidedBy,
    }),
  );

  return {
    flow: 'implementation',
    candidateDigest: params.binding.candidateDigest,
    contentDigest: params.binding.contentDigest,
    decisionAttestationDigest,
    reviewObligationId: params.binding.reviewObligationId,
    reviewAttemptId: params.binding.reviewAttemptId,
    reviewEvidenceDigest: params.binding.reviewEvidenceDigest,
    validationAttemptIds: sortedAttemptIds,
    approvedAt: params.decision.decidedAt,
    approvedBy: params.decision.decidedBy,
    certificateId,
  };
}

// ─── Certificate Validity Helper ───────────────────────────────────────────────

/**
 * Whether the current implementation approval certificate remains authoritative
 * for the current implementation candidate.
 */
export function hasCurrentImplementationApprovalCertificate(state: SessionState): boolean {
  if (!state.implementationApproval || !state.implementationCandidate) return false;
  return (
    state.implementationApproval.candidateDigest ===
      state.implementationCandidate.candidateDigest &&
    state.implementationApproval.contentDigest === state.implementationCandidate.contentDigest
  );
}
