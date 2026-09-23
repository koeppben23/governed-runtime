/**
 * @module integration/review/validation/review-validation
 * @description Shared validation logic for independent review findings.
 *
 * Single authority for all review-findings validation rules shared by the
 * governed tools. Fail-closed: returns a domain failure on any policy or
 * binding violation, or null when valid. Serialization happens only at the
 * adapter boundary (`review-validation-failure.ts`).
 *
 * Findings are never accepted from the agent: `resolveStructuredEffectiveFindings`
 * always resolves the host-captured structured evidence bound to the active
 * obligation. This module's `validateReviewFindings` remains the internal
 * evidence-validation authority for a concrete ReviewFindings record.
 *
 * Validation rules:
 * - reviewMode=self is rejected
 * - planVersion mismatch → BLOCKED
 * - iteration mismatch → BLOCKED
 * - unable_to_review → BLOCKED (no tool-submit path consumes it)
 */

import type { ReviewFindings } from '../../../state/evidence.js';
import { findLatestObligation, validateStrictAttestation } from '../obligations/assurance.js';
import { hashFindings } from '../findings-hash.js';
import type {
  ReviewAssuranceState,
  ReviewObligationType,
  ReviewObligation,
  ReviewInvocationEvidence,
} from '../../../state/evidence.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import {
  acceptanceRejectionVars,
  getReviewFindingsAcceptanceRejection,
  hasValidStructuredInvocationContract,
} from './review-validation-acceptance.js';
import {
  resolveStructuredFindings,
  type StructuredResolutionDiagnostics,
} from './review-validation-structured-evidence.js';
import {
  structuredResolutionFailure,
  type ReviewValidationFailure,
} from './review-validation-failure.js';
import {
  validateChallengeConsistency,
  type ChallengeConsistencyInput,
} from '../enforcement/challenge-consistency.js';
import {
  validateReviewFindingsConsistency,
  validateReviewFindingsScope,
  type FindingWithRelation,
} from '../enforcement/findings-consistency.js';
import { evaluateRepositoryEvidenceBinding } from '../observations/review-validation-evidence.js';

// ─── Validation Context ───────────────────────────────────────────────────────

/** Policy and binding context required for review-findings validation. */
export interface ReviewFindingsValidationContext {
  /** Expected plan version (history.length + 1). */
  readonly expectedPlanVersion: number;
  /** Expected iteration number for the current mode/phase. */
  readonly expectedIteration: number;
  /** Strict assurance store from state. */
  readonly assurance?: ReviewAssuranceState;
  /** Obligation type for strict checks. */
  readonly obligationType?: ReviewObligationType;
  /** Parent OpenCode session expected in invocation evidence. */
  readonly reviewParentSessionId?: string;
  /** Author-proposed implementation resolutions requiring independent verdicts. */
  readonly unresolvedImplementationChallengeIds?: readonly string[];
  /**
   * Prior failing implementation challenges with NO valid author resolution for
   * the current digest. Acceptance fails closed while this set is non-empty
   * (#747: an author must record a resolution before the reviewer can close a
   * prior challenge; author resolutions never act as closure).
   */
  readonly unaddressedPriorFailIds?: readonly string[];
  /**
   * Canonical challenge evidence references the active obligation permits. When
   * set, submitted challenge evidenceRefs must be a subset of these. Applies to
   * any challenge-bearing obligation; for an `implementation_challenge` this is
   * what binds it to a passing validation attempt for the CURRENT implementation
   * digest (freshness). Absent on non-challenge paths.
   */
  readonly allowedEvidenceRefs?: readonly unknown[];
  /**
   * Active obligation id. When set, every submitted challenge's `obligationId`
   * must equal it — obligation-scoping applies to all challenge-bearing
   * obligation types (plan/architecture/implement/review), not implement alone.
   */
  readonly expectedObligationId?: string;
  /** Challenge IDs already persisted in this session's review-findings history. */
  readonly previouslyUsedChallengeIds?: readonly string[];
}

// ─── Core Validation ──────────────────────────────────────────────────────────

/**
 * Validate review findings against policy and binding constraints.
 *
 * @returns domain failure if validation fails, null if valid.
 */
export function validateReviewFindings(
  findings: ReviewFindings,
  ctx: ReviewFindingsValidationContext,
): ReviewValidationFailure | null {
  const modeBlock = checkReviewMode(findings);
  if (modeBlock) return modeBlock;

  // P1.3 slice 4e: third-verdict tool-layer assertion.
  // The schema (slice 1) accepts overallVerdict='unable_to_review' so
  // that the subagent can declare the artifact unreviewable. However,
  // there is NO legitimate tool-submit path that consumes such findings:
  // - In strict mode, the plugin orchestrator (slice 4c) routes
  //   unable_to_review to BLOCKED before the tool ever sees the findings.
  // - In non-strict / submit-driven flows, a caller passing such findings
  //   would otherwise cause rails to advance state on a 2-valued
  //   reviewVerdict ('accept' or 'changes_requested') while the
  //   findings declare the verdict unreviewable — a fabrication-of-
  //   convergence bypass.
  // Per Decision C (obligation IS consumed via SUBAGENT_UNABLE_TO_REVIEW)
  // and Decision G (BLOCKED is the only legitimate outcome on this
  // verdict), this layer fail-closes with the SSOT reason from slice 2.
  const verdictBlock = checkUnreviewableVerdict(findings, ctx);
  if (verdictBlock) return verdictBlock;

  // F12: verdict/blocking-issues coherence. An `accept` verdict that still
  // carries blocking issues is internally self-contradictory and must fail
  // closed regardless of anti-tampering (the reviewer honestly reporting a
  // contradiction must still be stopped). Canonical rule lives in
  // findings-consistency.ts; this boundary passes the submitted array length.
  const consistencyBlock = checkFindingsConsistency(findings);
  if (consistencyBlock) return consistencyBlock;

  const obligation = ctx.assurance
    ? findLatestObligation(
        ctx.assurance.obligations,
        ctx.obligationType ?? 'review',
        ctx.expectedIteration,
        ctx.expectedPlanVersion,
      )
    : null;

  // Rule 3 (planVersion binding) and Rule 4 (iteration binding).
  const versionBlock = checkFindingsVersionBinding(findings, ctx);
  if (versionBlock) return versionBlock;

  const challengeBlock = checkChallengeConsistency(findings, ctx, obligation);
  if (challengeBlock) return challengeBlock;

  const scopeBlock = checkReviewFindingsScope(findings, obligation);
  if (scopeBlock) return scopeBlock;

  const evidenceBlock = checkRepositoryEvidenceBinding(findings, obligation, ctx);
  if (evidenceBlock) return evidenceBlock;

  return validateStrictReviewFindings(findings, ctx);
}

function checkReviewMode(findings: ReviewFindings): ReviewValidationFailure | null {
  const reviewMode = (findings as { reviewMode?: unknown }).reviewMode;
  if (reviewMode === 'subagent') return null;
  return {
    code: 'REVIEW_MODE_SELF_NOT_ALLOWED',
    vars: {
      action: 'submit non-subagent review findings',
      policyHint: `mandatory ${REVIEWER_SUBAGENT_TYPE} subagent review required`,
    },
  };
}

function checkUnreviewableVerdict(
  findings: ReviewFindings,
  ctx: ReviewFindingsValidationContext,
): ReviewValidationFailure | null {
  if ((findings as { overallVerdict?: unknown }).overallVerdict !== 'unable_to_review') return null;
  return {
    code: 'SUBAGENT_UNABLE_TO_REVIEW',
    vars: { obligationId: ctx.obligationType ?? 'review' },
  };
}

function checkFindingsConsistency(findings: ReviewFindings): ReviewValidationFailure | null {
  const consistency = validateReviewFindingsConsistency({
    overallVerdict: findings.overallVerdict,
    blockingIssueCount: findings.blockingIssues.length,
  });
  if (consistency.ok) return null;
  return {
    code: consistency.code,
    vars: { count: String(consistency.details.blockingIssueCount) },
  };
}

function checkFindingsVersionBinding(
  findings: ReviewFindings,
  ctx: ReviewFindingsValidationContext,
): ReviewValidationFailure | null {
  if (findings.planVersion !== ctx.expectedPlanVersion) {
    return {
      code: 'REVIEW_PLAN_VERSION_MISMATCH',
      vars: {
        provided: String(findings.planVersion),
        expected: String(ctx.expectedPlanVersion),
      },
    };
  }
  if (findings.iteration !== ctx.expectedIteration) {
    return {
      code: 'REVIEW_ITERATION_MISMATCH',
      vars: {
        provided: String(findings.iteration),
        expected: String(ctx.expectedIteration),
      },
    };
  }
  return null;
}

function challengeOptionalInputFields(
  findings: ReviewFindings,
  ctx: ReviewFindingsValidationContext,
): Partial<ChallengeConsistencyInput> {
  return {
    ...(ctx.allowedEvidenceRefs !== undefined
      ? { allowedEvidenceRefs: ctx.allowedEvidenceRefs }
      : {}),
    ...(findings.challengeResolutionVerdicts !== undefined
      ? { resolutionVerdicts: findings.challengeResolutionVerdicts }
      : {}),
    ...(ctx.unresolvedImplementationChallengeIds !== undefined
      ? { unresolvedImplementationChallengeIds: ctx.unresolvedImplementationChallengeIds }
      : {}),
    ...(ctx.unaddressedPriorFailIds !== undefined
      ? { unaddressedPriorFailIds: ctx.unaddressedPriorFailIds }
      : {}),
    ...(ctx.previouslyUsedChallengeIds !== undefined
      ? { previouslyUsedChallengeIds: ctx.previouslyUsedChallengeIds }
      : {}),
  };
}

function buildChallengeConsistencyInput(
  findings: ReviewFindings,
  ctx: ReviewFindingsValidationContext,
  obligation: ReviewObligation | null,
  expectedObligationId: string | undefined,
): ChallengeConsistencyInput {
  return {
    overallVerdict: findings.overallVerdict,
    requiredChallengeCount: obligation?.requiredChallengeCount ?? 0,
    requiredChallengeKind: obligation?.requiredChallengeKind ?? 'implementation_challenge',
    challenges: findings.challenges,
    ...(expectedObligationId !== undefined ? { expectedObligationId } : {}),
    ...challengeOptionalInputFields(findings, ctx),
  };
}

function checkChallengeConsistency(
  findings: ReviewFindings,
  ctx: ReviewFindingsValidationContext,
  obligation: ReviewObligation | null,
): ReviewValidationFailure | null {
  const expectedObligationId = ctx.expectedObligationId ?? obligation?.obligationId;
  const challengeConsistency = validateChallengeConsistency(
    buildChallengeConsistencyInput(findings, ctx, obligation, expectedObligationId),
  );
  if (challengeConsistency.ok) return null;
  return {
    code: challengeConsistency.code,
    vars: Object.fromEntries(
      Object.entries(challengeConsistency.details).map(([key, value]) => [key, String(value)]),
    ),
  };
}

function checkReviewFindingsScope(
  findings: ReviewFindings,
  obligation: ReviewObligation | null,
): ReviewValidationFailure | null {
  const scopeRelations: FindingWithRelation[] = [];
  [...(findings.blockingIssues ?? []), ...(findings.majorRisks ?? [])].forEach((item) => {
    if (item && typeof item === 'object') scopeRelations.push(item);
  });
  if (scopeRelations.length === 0) return null;
  if (!obligation) {
    return { code: 'REVIEW_SUBJECT_SCOPE_UNAVAILABLE', vars: { obligationId: 'unresolved' } };
  }
  const scopeResult = validateReviewFindingsScope({
    findings: scopeRelations,
    reviewSubjectScope: obligation.reviewSubjectScope,
    ...(obligation.repositoryRevisionProvenance !== undefined
      ? { repositoryRevisionProvenance: obligation.repositoryRevisionProvenance }
      : {}),
  });
  if (!scopeResult.ok) {
    return {
      code: scopeResult.code,
      vars: {
        findingIndex: scopeResult.details.outOfScopeFindingIndexes.join(', '),
        obligationId: obligation.obligationId,
      },
    };
  }
  return null;
}

function checkRepositoryEvidenceBinding(
  findings: ReviewFindings,
  obligation: ReviewObligation | null,
  ctx: ReviewFindingsValidationContext,
): ReviewValidationFailure | null {
  const binding = evaluateRepositoryEvidenceBinding(findings, obligation, ctx);
  return binding.ok
    ? null
    : {
        code: binding.code,
        vars: Object.fromEntries(
          Object.entries(binding.details).map(([key, value]) => [key, String(value)]),
        ),
      };
}

interface StrictReviewBinding {
  readonly obligation: ReviewObligation;
  readonly invocation: ReviewInvocationEvidence;
  readonly submittedFindingsHash: string;
}

function validateStrictReviewFindings(
  findings: ReviewFindings,
  ctx: ReviewFindingsValidationContext,
): ReviewValidationFailure | null {
  const binding = resolveStrictReviewBinding(findings, ctx);
  if (!('obligation' in binding)) return binding;
  return (
    validateStrictReviewRejections(binding) ??
    validateStrictReviewIdentity(findings, ctx, binding) ??
    validateStrictReviewAcceptance(binding) ??
    validateStrictReviewAttestation(findings, ctx, binding.obligation) ??
    validateStrictReviewInvocationBinding(findings, ctx, binding)
  );
}

function resolveStrictReviewBinding(
  findings: ReviewFindings,
  ctx: ReviewFindingsValidationContext,
): StrictReviewBinding | ReviewValidationFailure {
  if (!ctx.assurance || !ctx.obligationType) {
    return {
      code: 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      vars: { required: 'strict review assurance state' },
    };
  }
  const obligation = findLatestObligation(
    ctx.assurance.obligations,
    ctx.obligationType,
    ctx.expectedIteration,
    ctx.expectedPlanVersion,
  );
  if (!obligation) return missingStrictObligation(ctx);
  const submittedFindingsHash = hashFindings(findings);
  const invocation = findStrictInvocation(ctx, obligation, findings, submittedFindingsHash);
  if (!invocation) {
    return {
      code: 'SUBAGENT_EVIDENCE_MISSING',
      vars: { obligationId: obligation.obligationId },
    };
  }
  return { obligation, invocation, submittedFindingsHash };
}

function missingStrictObligation(ctx: ReviewFindingsValidationContext): ReviewValidationFailure {
  return {
    code: 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
    vars: {
      obligationType: ctx.obligationType ?? 'review',
      iteration: String(ctx.expectedIteration),
      planVersion: String(ctx.expectedPlanVersion),
    },
  };
}

function findStrictInvocation(
  ctx: ReviewFindingsValidationContext,
  obligation: ReviewObligation,
  findings: ReviewFindings,
  submittedFindingsHash: string,
): ReviewInvocationEvidence | undefined {
  return ctx.assurance?.invocations.find((item) =>
    obligation.invocationId
      ? item.invocationId === obligation.invocationId
      : item.obligationId === obligation.obligationId &&
        item.childSessionId === findings.reviewedBy.sessionId &&
        item.findingsHash === submittedFindingsHash,
  );
}

function validateStrictReviewRejections(
  binding: StrictReviewBinding,
): ReviewValidationFailure | null {
  const obligationRejection = getReviewFindingsAcceptanceRejection({
    obligation: binding.obligation,
  });
  if (obligationRejection) {
    return {
      code: obligationRejection.reason,
      vars: acceptanceRejectionVars(obligationRejection),
    };
  }
  const invocationRejection = getReviewFindingsAcceptanceRejection({
    obligation: binding.obligation,
    invocation: binding.invocation,
  });
  return invocationRejection
    ? { code: invocationRejection.reason, vars: acceptanceRejectionVars(invocationRejection) }
    : null;
}

function validateStrictReviewIdentity(
  findings: ReviewFindings,
  ctx: ReviewFindingsValidationContext,
  binding: StrictReviewBinding,
): ReviewValidationFailure | null {
  const { obligation, invocation } = binding;
  const selfSession =
    invocation.childSessionId === ctx.reviewParentSessionId ||
    findings.reviewedBy.sessionId === ctx.reviewParentSessionId;
  return selfSession
    ? {
        code: 'REVIEW_SELF_APPROVAL_DENIED',
        vars: { obligationId: obligation.obligationId },
      }
    : null;
}

function validateStrictReviewAcceptance(
  binding: StrictReviewBinding,
): ReviewValidationFailure | null {
  const { obligation } = binding;
  return obligation.status === 'fulfilled'
    ? null
    : {
        code: 'SUBAGENT_EVIDENCE_MISSING',
        vars: { obligationId: obligation.obligationId },
      };
}

function validateStrictReviewAttestation(
  findings: ReviewFindings,
  ctx: ReviewFindingsValidationContext,
  obligation: ReviewObligation,
): ReviewValidationFailure | null {
  const attestationError = validateStrictAttestation(findings, {
    obligationId: obligation.obligationId,
    iteration: ctx.expectedIteration,
    planVersion: ctx.expectedPlanVersion,
  });
  return attestationError
    ? { code: attestationError, vars: { obligationId: obligation.obligationId } }
    : null;
}

function validateStrictReviewInvocationBinding(
  findings: ReviewFindings,
  ctx: ReviewFindingsValidationContext,
  binding: StrictReviewBinding,
): ReviewValidationFailure | null {
  return (
    validateInvocationObligationId(binding) ??
    validateInvocationSessionId(findings, binding) ??
    validateInvocationFindingsHash(findings, binding) ??
    validateStructuredInvocationContract(ctx, binding)
  );
}

function validateInvocationObligationId(
  binding: StrictReviewBinding,
): ReviewValidationFailure | null {
  const { obligation, invocation } = binding;
  return invocation.obligationId !== obligation.obligationId
    ? { code: 'SUBAGENT_MANDATE_MISMATCH', vars: { obligationId: obligation.obligationId } }
    : null;
}

function validateInvocationSessionId(
  findings: ReviewFindings,
  binding: StrictReviewBinding,
): ReviewValidationFailure | null {
  if (findings.reviewedBy.sessionId === binding.invocation.childSessionId) return null;
  return {
    code: 'REVIEW_FINDINGS_SESSION_MISMATCH',
    vars: {
      provided: findings.reviewedBy.sessionId,
      expected: binding.invocation.childSessionId,
    },
  };
}

function validateInvocationFindingsHash(
  findings: ReviewFindings,
  binding: StrictReviewBinding,
): ReviewValidationFailure | null {
  const { obligation, invocation, submittedFindingsHash } = binding;
  return submittedFindingsHash === invocation.findingsHash
    ? null
    : {
        code: 'REVIEW_FINDINGS_HASH_MISMATCH',
        vars: { obligationId: obligation.obligationId },
      };
}

function validateStructuredInvocationContract(
  ctx: ReviewFindingsValidationContext,
  binding: StrictReviewBinding,
): ReviewValidationFailure | null {
  return hasValidStructuredInvocationContract({
    obligation: binding.obligation,
    invocation: binding.invocation,
    ...(ctx.reviewParentSessionId !== undefined
      ? { parentSessionId: ctx.reviewParentSessionId }
      : {}),
  })
    ? null
    : {
        code: 'SUBAGENT_EVIDENCE_MISSING',
        vars: {
          obligationId: binding.obligation.obligationId,
          reason: `expected structured ${REVIEWER_SUBAGENT_TYPE} evidence bound to the active session, mandate, criteria, child session, and findings hash`,
        },
      };
}

// ─── Structured Findings Resolution ───────────────────────────────────────────

interface StructuredResolutionContext {
  readonly pendingObligation: ReviewObligation | null;
  readonly expected: {
    readonly obligationType: ReviewObligationType;
    readonly iteration: number;
    readonly planVersion: number;
  };
  readonly input: {
    readonly reviewerUnavailable?: boolean | undefined;
    readonly verdict?: string | undefined;
  };
  readonly state: {
    readonly assurance?: ReviewAssuranceState | undefined;
    readonly sessionId: string;
    readonly unresolvedImplementationChallengeIds?: readonly string[] | undefined;
    readonly unaddressedPriorFailIds?: readonly string[] | undefined;
    readonly allowedChallengeEvidenceRefs?: readonly unknown[] | undefined;
    readonly previouslyUsedChallengeIds?: readonly string[] | undefined;
  };
}

/**
 * Check whether reviewerUnavailable is a misuse: the reviewer WAS spawned
 * (invocations exist) but the parent is signalling unavailability.
 */
function checkReviewerUnavailableMisuse(
  ctx: StructuredResolutionContext,
): ReviewValidationFailure | null {
  if (ctx.input.reviewerUnavailable !== true) return null;
  const existingInvs =
    ctx.state.assurance?.invocations.filter(
      (inv) => inv.obligationId === ctx.pendingObligation?.obligationId,
    ) ?? [];
  if (existingInvs.length > 0) {
    return {
      code: 'INVALID_REVIEW_TOOL_SEQUENCE',
      vars: {
        obligationId: ctx.pendingObligation?.obligationId ?? 'unknown',
        reason:
          'reviewerUnavailable submitted but a host-structured reviewer invocation already exists for this obligation. Use its bound reviewVerdict instead.',
      },
    };
  }
  return {
    code: 'REVIEWER_UNAVAILABLE_STRICT',
    vars: {
      reason: 'reviewer unavailable; independent host-captured reviewer evidence remains required',
      recovery:
        'Invoke the structured reviewer transport; the host captures its findings bound to the active obligation. flowguard_decision does not replace review evidence.',
    },
  };
}

/**
 * Resolution result: findings come exclusively from host-captured structured
 * evidence, so a resolved result ALWAYS carries the effective findings and the
 * evidence invocation that produced them.
 */
export type StructuredResolutionResult =
  | {
      readonly kind: 'blocked';
      readonly failure: ReviewValidationFailure;
    }
  | {
      readonly kind: 'resolved';
      readonly effectiveFindings: ReviewFindings;
      readonly evidenceInvocationId: string;
      /**
       * Warnings collected from discarded unusable captures. Adapters replay
       * them even on the resolved path — a bad capture before a good retry is
       * still operator-relevant.
       */
      readonly diagnostics: readonly StructuredResolutionDiagnostics[];
    };

export function resolveStructuredEffectiveFindings(
  ctx: StructuredResolutionContext,
): StructuredResolutionResult {
  if (ctx.input.reviewerUnavailable === true) {
    const misuse = checkReviewerUnavailableMisuse(ctx);
    if (misuse) return { kind: 'blocked', failure: misuse };
  }
  return resolveCapturedEvidenceFindings(ctx);
}

/**
 * Host-observed verdict continuation: the reviewer's findings are never
 * resubmitted by the parent. Resolve the bound structured capture and use it
 * as the effective findings authority.
 */
function resolveCapturedEvidenceFindings(
  ctx: StructuredResolutionContext,
): StructuredResolutionResult {
  const { resolution, diagnostics } = resolveStructuredFindings(
    ctx.state.assurance,
    ctx.pendingObligation,
    ctx.state.unresolvedImplementationChallengeIds,
    ctx.state.allowedChallengeEvidenceRefs,
    ctx.state.unaddressedPriorFailIds,
    ctx.state.previouslyUsedChallengeIds,
    ctx.state.sessionId,
  );
  if (resolution.kind === 'resolved') {
    return {
      kind: 'resolved',
      effectiveFindings: resolution.findings,
      evidenceInvocationId: resolution.invocationId,
      diagnostics,
    };
  }
  return { kind: 'blocked', failure: structuredResolutionFailure(resolution, diagnostics) };
}
