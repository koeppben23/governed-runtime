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
 * The single candidate authority is state.implementation.candidate (PR #805).
 * No secondary candidate projection exists.
 *
 * @version v2
 */

import type { SessionState } from './schema.js';
import type { ImplementationApprovalCertificate } from './evidence-implementation-approval.js';
import type { ImplementationCandidate } from './evidence-candidate.js';
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

// ─── Candidate Authority Helper ────────────────────────────────────────────────

function resolveCandidateFromState(state: SessionState): ImplementationCandidate | null {
  return state.implementation?.candidate ?? null;
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
 *
 * When no active checks exist, no validation evidence is required and an empty
 * attemptIds set is returned. The certificate schema accepts this when the
 * policy layer has explicitly declared zero required checks for the flow.
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
 *  - The authoritative attempt (= highest ordinal) for that obligation,
 *    with subjectDigest=candidateDigest and status === 'bound'
 *  - Invocation evidence binding that exact attempt and obligation
 *
 * The latest attempt at the highest ordinal is the authoritative one (#797).
 * Only 'bound' is an admissible final state for approval authority; 'captured',
 * 'rejected', 'stale', and 'expired' are not.
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

  const attemptsForObligation = (obligation.attemptIds ?? [])
    .map((id) => assurance.attempts.find((a) => a.attemptId === id))
    .filter((a): a is NonNullable<typeof a> => a !== undefined)
    .filter(
      (a) => a.subjectDigest === candidateDigest && a.obligationId === obligation.obligationId,
    );

  if (attemptsForObligation.length === 0) return null;

  // Highest ordinal is the authoritative attempt (#797).
  const authoritativeAttempt = [...attemptsForObligation].sort((a, b) => b.ordinal - a.ordinal)[0]!;

  // Final approval authority requires a bound attempt. No other status
  // (created, captured, rejected, stale, expired) is admissible.
  if (authoritativeAttempt.status !== 'bound') return null;

  const invocation = assurance.invocations.find(
    (i) =>
      i.obligationId === obligation.obligationId && i.attemptId === authoritativeAttempt.attemptId,
  );

  if (!invocation) return null;

  return {
    obligationId: obligation.obligationId,
    attemptId: authoritativeAttempt.attemptId,
    evidenceDigest: invocation.findingsHash,
  };
}

// ─── Central Approval Binding Validator ────────────────────────────────────────

/**
 * Validate that the current implementation candidate is fully authorized for
 * human final approval.
 *
 * The single candidate authority is state.implementation.candidate.
 * Absence is fail-closed — no legacy bypass, no silent fallback.
 *
 * Checks:
 *  1. Implementation candidate exists in state (state.implementation.candidate)
 *  2. Live observation matches persisted candidate (candidateDigest)
 *  3. Required validation attempts exist for current contentDigest
 *  4. Independent review obligation + authoritative attempt lineage binds
 *     current candidateDigest (highest ordinal, status='bound')
 *  5. No fallback or heuristic — exact match or fail-closed
 */
export function validateImplementationApprovalBinding(input: {
  readonly state: SessionState;
  readonly observedCandidate?: ImplementationApprovalObservation;
}): ImplementationApprovalBindingResult {
  const { state, observedCandidate } = input;

  const candidate = resolveCandidateFromState(state);
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
        'Not all required validation checks have passing evidence for the current implementation content.',
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
        'No bound independent review attempt binds the current implementation candidate. The implementation must be independently reviewed at its current identity before final approval.',
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

// ─── Certificate Validity ──────────────────────────────────────────────────────

/**
 * Validate that an ImplementationApprovalCertificate is internally consistent
 * and that every piece of evidence it claims (review obligation, review attempt,
 * review invocation, validation attempts) still exists and binds the current
 * implementation candidate.
 *
 * This is a full state-lineage check, not merely a candidate-digest comparison.
 */
export function validateCurrentImplementationApprovalCertificate(
  state: SessionState,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const cert = state.implementationApproval;
  const candidate = state.implementation?.candidate ?? null;

  if (!cert) {
    return { ok: false, reason: 'No implementation approval certificate exists.' };
  }
  if (!candidate) {
    return { ok: false, reason: 'No implementation candidate exists.' };
  }

  // Candidate binding.
  if (cert.candidateDigest !== candidate.candidateDigest) {
    return { ok: false, reason: 'Certificate candidateDigest does not match current candidate.' };
  }
  if (cert.contentDigest !== candidate.contentDigest) {
    return { ok: false, reason: 'Certificate contentDigest does not match current candidate.' };
  }

  // Validation attempt lineage.
  for (const id of cert.validationAttemptIds) {
    const attempt = state.validationAttempts.find((a) => a.attemptId === id);
    if (!attempt) {
      return {
        ok: false,
        reason: `Validation attempt ${id} referenced by certificate does not exist.`,
      };
    }
    if (
      attempt.scope !== 'implementation' ||
      attempt.implementationDigest !== candidate.contentDigest
    ) {
      return { ok: false, reason: `Validation attempt ${id} does not bind current contentDigest.` };
    }
  }

  // Review obligation lineage.
  const assurance = state.reviewAssurance;
  if (!assurance) {
    return {
      ok: false,
      reason: 'No review assurance exists — certificate review lineage cannot be verified.',
    };
  }

  const obligation = assurance.obligations.find((o) => o.obligationId === cert.reviewObligationId);
  if (!obligation) {
    return {
      ok: false,
      reason: `Review obligation ${cert.reviewObligationId} referenced by certificate does not exist.`,
    };
  }
  if (obligation.subjectDigest !== candidate.candidateDigest) {
    return {
      ok: false,
      reason: 'Review obligation subjectDigest does not match current candidate.',
    };
  }

  // Review attempt lineage.
  const attempt = assurance.attempts.find((a) => a.attemptId === cert.reviewAttemptId);
  if (!attempt) {
    return {
      ok: false,
      reason: `Review attempt ${cert.reviewAttemptId} referenced by certificate does not exist.`,
    };
  }
  if (attempt.obligationId !== obligation.obligationId) {
    return { ok: false, reason: 'Review attempt does not belong to the referenced obligation.' };
  }
  if (attempt.subjectDigest !== candidate.candidateDigest) {
    return { ok: false, reason: 'Review attempt subjectDigest does not match current candidate.' };
  }

  // Review invocation evidence digest.
  const invocation = assurance.invocations.find(
    (i) => i.obligationId === obligation.obligationId && i.attemptId === attempt.attemptId,
  );
  if (!invocation) {
    return {
      ok: false,
      reason: 'No review invocation evidence binds the referenced obligation and attempt.',
    };
  }
  if (invocation.findingsHash !== cert.reviewEvidenceDigest) {
    return {
      ok: false,
      reason: 'Certificate reviewEvidenceDigest does not match current invocation evidence.',
    };
  }

  return { ok: true };
}

/**
 * Whether the current implementation approval certificate remains authoritative
 * for the current implementation candidate.
 *
 * Delegates to validateCurrentImplementationApprovalCertificate for full
 * structural validation. This is a convenience wrapper.
 */
export function hasCurrentImplementationApprovalCertificate(state: SessionState): boolean {
  return validateCurrentImplementationApprovalCertificate(state).ok;
}
