/**
 * @module integration/review/validation/review-validation-structured-evidence
 * @description Structured review findings resolution from native Task invocation evidence.
 *
 * Extracted from review-validation.ts. The final acceptance/rejection
 * authority remains there. Imports only from state, shared, and the
 * leaf acceptance module — no dependency on the core validation module.
 *
 * @version v1
 */

import type { ZodIssue } from 'zod';
import type { ReviewFindings } from '../../../state/evidence.js';
import { ReviewFindings as ReviewFindingsSchema } from '../../../state/evidence.js';
import type {
  ReviewAssuranceState,
  ReviewAttempt,
  ReviewObligation,
  ReviewInvocationEvidence,
} from '../../../state/evidence.js';
import {
  getReviewFindingsAcceptanceRejection,
  hasValidStructuredInvocationContract,
  type ReviewFindingsAcceptanceRejection,
} from './review-validation-acceptance.js';
import {
  validateChallengeConsistency,
  type ChallengeConsistencyCode,
  type ChallengeConsistencyInput,
} from '../enforcement/challenge-consistency.js';
import { validateReviewFindingsConsistency } from '../enforcement/findings-consistency.js';
import { hashFindings } from '../findings-hash.js';
import { bindCanonicalEvidenceRefs } from '../enforcement/challenge-binding.js';

/**
 * Result of resolving review findings from structured invocation evidence.
 */
export interface ResolvedStructuredFindings {
  /** Parsed ReviewFindings from the evidence's capturedRawFindings. */
  readonly findings: ReviewFindings;
  /** Invocation evidence record used for direct obligation consumption. */
  readonly invocation: ReviewInvocationEvidence;
  /** InvocationId of the evidence record. */
  readonly invocationId: string;
}

/**
 * Structured diagnostic data for an unparseable host capture. Never rendered
 * into the blocked envelope: adapters replay it into the diagnostic logger so
 * the operator sees the obligation/invocation identity and the exact schema
 * issues that failed.
 */
export interface StructuredResolutionDiagnostics {
  readonly obligationId: string;
  readonly invocationId: string;
  readonly issues: readonly string[];
}

/** Incoherence code emitted by the findings-consistency or challenge authority. */
export type StructuredIncoherenceCode =
  'SUBAGENT_VERDICT_FINDINGS_INCOHERENT' | ChallengeConsistencyCode;

export type StructuredFindingsResolution =
  | ({ readonly kind: 'resolved' } & ResolvedStructuredFindings)
  | { readonly kind: 'rejected'; readonly rejection: ReviewFindingsAcceptanceRejection }
  | {
      readonly kind: 'unparseable';
      readonly detail: string;
      readonly diagnostics: StructuredResolutionDiagnostics;
    }
  | {
      readonly kind: 'incoherent';
      readonly code: StructuredIncoherenceCode;
      readonly details: Record<string, unknown>;
      readonly invocationId: string;
      readonly attemptId: string;
      /** Current diagnostic projection of the findings consistency failure. */
      readonly blockingIssueCount?: number;
    }
  | {
      readonly kind: 'invalid';
      readonly code: 'REVIEW_FINDINGS_HASH_MISMATCH' | 'SUBAGENT_EVIDENCE_MISSING';
      readonly obligationId: string;
    }
  | {
      readonly kind: 'attempt_lineage_unavailable';
      readonly invocationId: string;
      readonly obligationId: string;
    }
  | { readonly kind: 'not_found' };

interface StructuredFindingsEvaluationContext {
  readonly assurance: ReviewAssuranceState;
  readonly obligation: ReviewObligation;
  readonly parentSessionId: string | undefined;
  readonly allowedChallengeEvidenceRefs: readonly unknown[] | undefined;
  readonly unresolvedImplementationChallengeIds: readonly string[] | undefined;
  readonly unaddressedPriorFailIds: readonly string[] | undefined;
  readonly previouslyUsedChallengeIds: readonly string[] | undefined;
}

interface UnavailableLineageDiagnostic {
  readonly invocationId: string;
  readonly obligationId: string;
}

interface IncoherentStructuredDiagnostic {
  readonly code: StructuredIncoherenceCode;
  readonly details: Record<string, unknown>;
  readonly invocationId: string;
  readonly attemptId: string;
}

interface DeferredUnparseableDiagnostic {
  readonly detail: string;
  readonly diagnostics: StructuredResolutionDiagnostics;
}

interface DeferredStructuredDiagnostics {
  /**
   * Every unusable capture encountered so far, in encounter order. The last
   * entry feeds the `unparseable` resolution variant; the whole list feeds the
   * operator diagnostics that travel independently of the final result.
   */
  readonly unparseables: readonly DeferredUnparseableDiagnostic[];
  readonly incoherent: IncoherentStructuredDiagnostic | null;
  readonly unavailableLineage: UnavailableLineageDiagnostic | null;
}

/** Resolution plus the operator diagnostics collected while resolving it. */
export interface StructuredFindingsResolutionResult {
  readonly resolution: StructuredFindingsResolution;
  readonly diagnostics: readonly StructuredResolutionDiagnostics[];
}

type DeferredStructuredDiagnostic =
  | { readonly kind: 'unusable_lineage'; readonly lineage: UnavailableLineageDiagnostic }
  | ({ readonly kind: 'incoherent' } & IncoherentStructuredDiagnostic)
  | ({ readonly kind: 'unparseable' } & DeferredUnparseableDiagnostic);

type StructuredInvocationEvaluation =
  | { readonly kind: 'skip' }
  | { readonly kind: 'terminal'; readonly resolution: StructuredFindingsResolution }
  | { readonly kind: 'deferred'; readonly diagnostic: DeferredStructuredDiagnostic };

/**
 * Resolve review findings from host-observed structured invocation evidence.
 *
 * The host stores the complete structured findings in the invocation evidence
 * (`capturedRawFindings`). This function reads and validates them, eliminating
 * agent-side reconstruction of the ReviewFindings object.
 *
 * The returned `invocationId` is used for direct obligation consumption,
 * bypassing `findAcceptedInvocationForFindings` (which would require hash
 * comparison against the Zod-parsed object, reintroducing the key-order problem).
 *
 * @param assurance - Review assurance state with obligations and invocations
 * @param obligation - The pending/fulfilled obligation to resolve findings for
 * @returns Parsed findings + invocationId, or null if evidence is unavailable
 */
export function resolveStructuredFindings(
  assurance: ReviewAssuranceState | undefined,
  obligation: ReviewObligation | null,
  ...[
    unresolvedImplementationChallengeIds,
    allowedChallengeEvidenceRefs,
    unaddressedPriorFailIds,
    previouslyUsedChallengeIds,
    parentSessionId,
  ]: readonly [
    (readonly string[] | undefined)?,
    (readonly unknown[] | undefined)?,
    (readonly string[] | undefined)?,
    (readonly string[] | undefined)?,
    (string | undefined)?,
  ]
): StructuredFindingsResolutionResult {
  if (!obligation || !assurance) {
    return { resolution: { kind: 'not_found' }, diagnostics: [] };
  }

  const obligationRejection = getReviewFindingsAcceptanceRejection({ obligation });
  if (obligationRejection) {
    return { resolution: { kind: 'rejected', rejection: obligationRejection }, diagnostics: [] };
  }

  const context: StructuredFindingsEvaluationContext = {
    assurance,
    obligation,
    parentSessionId,
    allowedChallengeEvidenceRefs,
    unresolvedImplementationChallengeIds,
    unaddressedPriorFailIds,
    previouslyUsedChallengeIds,
  };
  const matchingInvocations = assurance.invocations.filter(
    (inv) =>
      inv.obligationId === obligation.obligationId &&
      inv.invocationMode === 'native_task_structured_followup' &&
      inv.capturedRawFindings != null,
  );
  return resolveFromStructuredInvocations(context, matchingInvocations);
}

/**
 * An unusable earlier capture must not deadlock a later coherent retry. The
 * earlier evidence remains persisted for audit while this loop continues to
 * consider subsequent captures for the same obligation.
 */
function resolveFromStructuredInvocations(
  context: StructuredFindingsEvaluationContext,
  matchingInvocations: readonly ReviewInvocationEvidence[],
): StructuredFindingsResolutionResult {
  let deferred = emptyDeferredDiagnostics();
  for (const invocation of matchingInvocations) {
    const evaluation = evaluateStructuredInvocation(context, invocation);
    if (evaluation.kind === 'skip') continue;
    if (evaluation.kind === 'terminal') {
      // A resolved retry supersedes the unusable capture for the RESOLUTION,
      // but the warnings collected from earlier captures still reach the
      // adapter boundary.
      return { resolution: evaluation.resolution, diagnostics: deferredDiagnostics(deferred) };
    }
    deferred = mergeDeferredDiagnostics(deferred, evaluation.diagnostic);
  }
  return finalizeStructuredResolution(context, matchingInvocations, deferred);
}

function deferredDiagnostics(
  deferred: DeferredStructuredDiagnostics,
): readonly StructuredResolutionDiagnostics[] {
  return deferred.unparseables.map((item) => item.diagnostics);
}

function emptyDeferredDiagnostics(): DeferredStructuredDiagnostics {
  return { unparseables: [], incoherent: null, unavailableLineage: null };
}

function mergeDeferredDiagnostics(
  current: DeferredStructuredDiagnostics,
  incoming: DeferredStructuredDiagnostic,
): DeferredStructuredDiagnostics {
  if (incoming.kind === 'unusable_lineage') {
    return current.unavailableLineage === null
      ? { ...current, unavailableLineage: incoming.lineage }
      : current;
  }
  if (incoming.kind === 'incoherent') {
    return current.incoherent === null
      ? {
          ...current,
          incoherent: {
            code: incoming.code,
            details: incoming.details,
            invocationId: incoming.invocationId,
            attemptId: incoming.attemptId,
          },
        }
      : current;
  }
  return {
    ...current,
    unparseables: [...current.unparseables, incoming],
  };
}

function finalizeStructuredResolution(
  context: StructuredFindingsEvaluationContext,
  matchingInvocations: readonly ReviewInvocationEvidence[],
  deferred: DeferredStructuredDiagnostics,
): StructuredFindingsResolutionResult {
  const diagnostics = deferredDiagnostics(deferred);
  const lastUnparseable = deferred.unparseables.at(-1) ?? null;
  if (deferred.unavailableLineage !== null) {
    return {
      resolution: {
        kind: 'attempt_lineage_unavailable',
        invocationId: deferred.unavailableLineage.invocationId,
        obligationId: deferred.unavailableLineage.obligationId,
      },
      diagnostics,
    };
  }
  if (deferred.incoherent !== null) {
    return {
      resolution: {
        kind: 'incoherent',
        code: deferred.incoherent.code,
        details: deferred.incoherent.details,
        invocationId: deferred.incoherent.invocationId,
        attemptId: deferred.incoherent.attemptId,
        ...(typeof deferred.incoherent.details.blockingIssueCount === 'number'
          ? { blockingIssueCount: deferred.incoherent.details.blockingIssueCount }
          : {}),
      },
      diagnostics,
    };
  }
  if (lastUnparseable !== null) {
    return {
      resolution: {
        kind: 'unparseable',
        detail: lastUnparseable.detail,
        diagnostics: lastUnparseable.diagnostics,
      },
      diagnostics,
    };
  }
  if (matchingInvocations.length > 0) {
    return {
      resolution: {
        kind: 'invalid',
        code: 'SUBAGENT_EVIDENCE_MISSING',
        obligationId: context.obligation.obligationId,
      },
      diagnostics,
    };
  }
  return { resolution: { kind: 'not_found' }, diagnostics };
}

function evaluateStructuredInvocation(
  context: StructuredFindingsEvaluationContext,
  invocation: ReviewInvocationEvidence,
): StructuredInvocationEvaluation {
  const capturedRawFindings = invocation.capturedRawFindings;
  if (!capturedRawFindings) return { kind: 'skip' };

  const invocationRejection = getReviewFindingsAcceptanceRejection({
    obligation: context.obligation,
    invocation,
  });
  if (invocationRejection) {
    return {
      kind: 'terminal',
      resolution: { kind: 'rejected', rejection: invocationRejection },
    };
  }

  if (
    !hasValidStructuredInvocationContract({
      obligation: context.obligation,
      invocation,
      ...(context.parentSessionId !== undefined
        ? { parentSessionId: context.parentSessionId }
        : {}),
    })
  ) {
    return { kind: 'skip' };
  }

  if (!hasExactBoundAttempt(context.assurance.attempts, context.obligation, invocation)) {
    return {
      kind: 'deferred',
      diagnostic: {
        kind: 'unusable_lineage',
        lineage: {
          invocationId: invocation.invocationId,
          obligationId: context.obligation.obligationId,
        },
      },
    };
  }

  // Parse through ReviewFindings schema for type safety and validation.
  // safeParse: if the raw findings are malformed (missing required fields,
  // invalid types), surface it as `unparseable` so the caller falls back to
  // a distinct BLOCKED code (not silent not_found).
  const parsed = ReviewFindingsSchema.safeParse(capturedRawFindings);
  if (!parsed.success) {
    return {
      kind: 'deferred',
      diagnostic: {
        kind: 'unparseable',
        ...describeUnparseableFindings(context.obligation, invocation, parsed.error.issues),
      },
    };
  }
  return evaluateParsedStructuredFindings(context, invocation, capturedRawFindings, parsed.data);
}

function evaluateParsedStructuredFindings(
  context: StructuredFindingsEvaluationContext,
  invocation: ReviewInvocationEvidence,
  capturedRawFindings: Record<string, unknown>,
  findings: ReviewFindings,
): StructuredInvocationEvaluation {
  if (hashFindings(capturedRawFindings) !== invocation.findingsHash) {
    return invalidFindingsEvaluation('REVIEW_FINDINGS_HASH_MISMATCH', context.obligation);
  }
  if (
    invocation.capturedVerdict !== undefined &&
    invocation.capturedVerdict !== findings.overallVerdict
  ) {
    return invalidFindingsEvaluation('REVIEW_FINDINGS_HASH_MISMATCH', context.obligation);
  }
  if (findings.reviewedBy.sessionId !== invocation.childSessionId) {
    return invalidFindingsEvaluation('SUBAGENT_EVIDENCE_MISSING', context.obligation);
  }
  // F12: coherence of the host-captured record. An `accept` verdict that
  // still carries blocking issues is self-contradictory and must fail closed
  // before the findings are treated as valid evidence — this is the host-task
  // ingestion boundary (verdict-only submission never reaches the tool-layer
  // validateReviewFindings coherence check). Canonical rule in
  // findings-consistency.ts.
  const consistency = validateReviewFindingsConsistency({
    overallVerdict: findings.overallVerdict,
    blockingIssueCount: findings.blockingIssues.length,
  });
  if (!consistency.ok) {
    return incoherentFindingsEvaluation(invocation, consistency.code, consistency.details);
  }
  // Host-authoritative evidence identity. This path validates the RAW reviewer
  // submission (`capturedRawFindings`) against the frozen challenge contract by
  // exact canonical JSON, unlike the review binding seam which first rebinds
  // refs to the host's canonical copies. A `plan_adr_section` ref carries
  // presentation-only fields — `sectionPath[].headingText` and
  // `excerptDigest` — that add no locating power, because `artifactDigest` plus
  // heading depth and sibling index already identify the section. Comparing
  // them exactly meant a heading reproduced without its backticks failed as
  // `evidence_mismatch` and killed the session. Rebind through the same
  // canonical authority the binding seam uses. A ref genuinely outside the
  // contract does not rebind; the raw refs are then kept so the unchanged
  // exact check below still rejects it.
  const challenges = rebindChallengesForConsistency(context, findings);
  const challengeConsistency = validateChallengeConsistency(
    buildChallengeConsistencyInput(context, findings, challenges),
  );
  if (!challengeConsistency.ok) {
    return incoherentFindingsEvaluation(
      invocation,
      challengeConsistency.code,
      challengeConsistency.details,
    );
  }
  return {
    kind: 'terminal',
    resolution: {
      kind: 'resolved',
      findings,
      invocation,
      invocationId: invocation.invocationId,
    },
  };
}

function invalidFindingsEvaluation(
  code: 'REVIEW_FINDINGS_HASH_MISMATCH' | 'SUBAGENT_EVIDENCE_MISSING',
  obligation: ReviewObligation,
): StructuredInvocationEvaluation {
  return {
    kind: 'terminal',
    resolution: { kind: 'invalid', code, obligationId: obligation.obligationId },
  };
}

function incoherentFindingsEvaluation(
  invocation: ReviewInvocationEvidence,
  code: StructuredIncoherenceCode,
  details: Record<string, unknown>,
): StructuredInvocationEvaluation {
  return {
    kind: 'deferred',
    diagnostic: {
      kind: 'incoherent',
      code,
      details,
      invocationId: invocation.invocationId,
      attemptId: invocation.attemptId,
    },
  };
}

function rebindChallengesForConsistency(
  context: StructuredFindingsEvaluationContext,
  findings: ReviewFindings,
): ReviewFindings['challenges'] {
  if (!context.allowedChallengeEvidenceRefs) return findings.challenges;
  const rebound = bindCanonicalEvidenceRefs(
    findings.challenges,
    context.allowedChallengeEvidenceRefs,
    context.obligation.obligationId,
    // Only used for a rejection diagnostic, which this path discards in
    // favour of the unchanged consistency check below.
    context.parentSessionId ?? '',
  );
  return 'kind' in rebound
    ? findings.challenges
    : (rebound.challenges as ReviewFindings['challenges']);
}

function buildChallengeConsistencyInput(
  context: StructuredFindingsEvaluationContext,
  findings: ReviewFindings,
  challenges: ReviewFindings['challenges'],
): ChallengeConsistencyInput {
  return {
    overallVerdict: findings.overallVerdict,
    requiredChallengeCount: context.obligation.requiredChallengeCount,
    requiredChallengeKind: context.obligation.requiredChallengeKind ?? 'implementation_challenge',
    challenges,
    expectedObligationId: context.obligation.obligationId,
    ...(context.allowedChallengeEvidenceRefs !== undefined
      ? { allowedEvidenceRefs: context.allowedChallengeEvidenceRefs }
      : {}),
    ...(findings.challengeResolutionVerdicts !== undefined
      ? { resolutionVerdicts: findings.challengeResolutionVerdicts }
      : {}),
    ...(context.unresolvedImplementationChallengeIds !== undefined
      ? { unresolvedImplementationChallengeIds: context.unresolvedImplementationChallengeIds }
      : {}),
    ...(context.unaddressedPriorFailIds !== undefined
      ? { unaddressedPriorFailIds: context.unaddressedPriorFailIds }
      : {}),
    ...(context.previouslyUsedChallengeIds !== undefined
      ? { previouslyUsedChallengeIds: context.previouslyUsedChallengeIds }
      : {}),
  };
}

/**
 * Diagnostic for error analysis: captured findings are PRESENT (the invocation
 * filter requires capturedRawFindings != null) but FAIL schema validation.
 * Pure: the schema issues travel as diagnostic data; the adapter boundary
 * replays them into the diagnostic logger.
 */
function describeUnparseableFindings(
  obligation: ReviewObligation,
  invocation: ReviewInvocationEvidence,
  issues: readonly ZodIssue[],
): DeferredUnparseableDiagnostic {
  const formattedIssues = issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .slice(0, 8);
  return {
    detail: formattedIssues.join('; ') || 'unknown schema validation failure',
    diagnostics: {
      obligationId: obligation.obligationId,
      invocationId: invocation.invocationId,
      issues: formattedIssues,
    },
  };
}

/**
 * The evidence consumer must independently verify the binding minted by the
 * structured-capture boundary. Never recover an invocation by searching for a
 * merely compatible attempt: invocation.attemptId is the authority key.
 */
function hasExactBoundAttempt(
  attempts: readonly ReviewAttempt[],
  obligation: ReviewObligation,
  invocation: ReviewInvocationEvidence,
): boolean {
  const attempt = attempts.find((item) => item.attemptId === invocation.attemptId);
  return (
    invocation.obligationType === obligation.obligationType &&
    attempt?.status === 'bound' &&
    attempt.obligationId === obligation.obligationId &&
    attempt.obligationType === obligation.obligationType &&
    attempt.subjectDigest === obligation.subjectDigest &&
    attempt.childSessionId === invocation.childSessionId
  );
}
