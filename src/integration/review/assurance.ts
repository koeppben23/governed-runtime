/**
 * @module integration/review-assurance
 * @description SSOT helpers for strict independent-review obligations and evidence.
 */

import { randomUUID } from 'node:crypto';
import { hashText } from '../../shared/hashing.js';
export { hashText };

import type {
  ReviewAssuranceState,
  ReviewFindings,
  ReviewInvocationEvidence,
  ReviewInvocationMode,
  ReviewObligation,
  ReviewObligationType,
  ReviewProfile,
  ReviewProfileSource,
  PolicySnapshot,
} from '../../state/evidence.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import { assessMinimumTaskClass } from '../phase-tool-gate.js';
import { challengeKindForObligation } from '../../config/policy-types.js';

// Static import - mandate content is a constant in ESM
import { REVIEWER_AGENT } from '../../templates/mandates.js';

export const REVIEW_CRITERIA_VERSION = 'p40-v1';

// Mandate digest - computed from actual REVIEWER_AGENT template at module load
// No fallback: if the import fails, the module fails fast (desired for governance)
export const REVIEW_MANDATE_DIGEST = hashText(REVIEWER_AGENT);

export function getReviewMandateDigest(): string {
  return REVIEW_MANDATE_DIGEST;
}

export function emptyReviewAssurance(): ReviewAssuranceState {
  return { obligations: [], invocations: [] };
}

export function ensureReviewAssurance(
  assurance: ReviewAssuranceState | undefined,
): ReviewAssuranceState {
  return assurance ?? emptyReviewAssurance();
}

export function createReviewObligation(input: {
  obligationType: ReviewObligationType;
  iteration: number;
  planVersion: number;
  now: string;
  /**
   * Mandatory review coverage profile frozen into the obligation at creation,
   * before any reviewer invocation. Defaults to the fail-closed 'core' baseline.
   */
  reviewProfile?: ReviewProfile;
  /** Provenance of the frozen profile. Defaults to 'policy_default'. */
  profileSource?: ReviewProfileSource;
  /** Frozen session policy; without its challenge policy, enforcement is disabled. */
  policySnapshot?: Pick<PolicySnapshot, 'challengePolicy'> | null;
  /** Runtime paths are classified by the canonical phase-tool gate. */
  changedFiles?: readonly string[];
  metadata?: Record<string, unknown>;
}): ReviewObligation {
  const challengePolicy = input.policySnapshot?.challengePolicy;
  const requirements = challengePolicy
    ? {
        requiredChallengeCount:
          challengePolicy.counts[assessMinimumTaskClass(input.changedFiles ?? []).minimumTaskClass],
        requiredChallengeKind: challengeKindForObligation(input.obligationType),
        challengePolicyVersion: challengePolicy.version,
      }
    : {};
  return {
    obligationId: randomUUID(),
    obligationType: input.obligationType,
    iteration: input.iteration,
    planVersion: input.planVersion,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    mandateDigest: REVIEW_MANDATE_DIGEST,
    createdAt: input.now,
    pluginHandshakeAt: null,
    status: 'pending',
    invocationId: null,
    blockedCode: null,
    fulfilledAt: null,
    consumedAt: null,
    // Fail-closed: freeze the mandatory 'core' baseline when no profile is
    // supplied. The profile is fixed here, before the reviewer is invoked.
    reviewProfile: input.reviewProfile ?? 'core',
    profileSource: input.profileSource ?? 'policy_default',
    ...requirements,
    metadata: input.metadata,
  };
}

/**
 * Resolve the frozen mandatory review profile from a policy snapshot shape.
 *
 * Fail-closed: any missing or invalid value resolves to the mandatory 'core'
 * baseline. 'core' is never operator-optional and has no 'off' mode. This is
 * the single resolver used by obligation-creation call sites so the frozen
 * profile is consistent across every review flow.
 */
export function resolveFrozenReviewProfile(
  policySnapshot: { reviewProfile?: string } | null | undefined,
): ReviewProfile {
  const raw = policySnapshot?.reviewProfile;
  return raw === 'core' || raw === 'full' ? raw : 'core';
}

export function appendReviewObligation(
  assurance: ReviewAssuranceState | undefined,
  obligation: ReviewObligation | null,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  if (!obligation) return base;
  return {
    obligations: [...base.obligations, obligation],
    invocations: base.invocations,
  };
}

export function reviewObligationResponseFields(
  obligation: ReviewObligation | null,
): Record<string, unknown> {
  if (!obligation) return {};
  return {
    reviewObligation: {
      obligationId: obligation.obligationId,
      obligationType: obligation.obligationType,
      iteration: obligation.iteration,
      planVersion: obligation.planVersion,
      criteriaVersion: obligation.criteriaVersion,
      mandateDigest: obligation.mandateDigest,
      requiredChallengeCount: obligation.requiredChallengeCount,
      requiredChallengeKind: obligation.requiredChallengeKind,
    },
    reviewObligationId: obligation.obligationId,
    reviewObligationIteration: obligation.iteration,
    reviewObligationPlanVersion: obligation.planVersion,
    reviewCriteriaVersion: obligation.criteriaVersion,
    reviewMandateDigest: obligation.mandateDigest,
    requiredChallengeCount: obligation.requiredChallengeCount,
    requiredChallengeKind: obligation.requiredChallengeKind,
  };
}

export function findLatestObligation(
  obligations: ReviewObligation[],
  obligationType: ReviewObligationType,
  iteration: number,
  planVersion: number,
): ReviewObligation | null {
  for (let i = obligations.length - 1; i >= 0; i--) {
    const item = obligations[i];
    if (
      item &&
      item.obligationType === obligationType &&
      item.iteration === iteration &&
      item.planVersion === planVersion
    ) {
      return item;
    }
  }
  return null;
}

/**
 * Find the latest pending obligation of a given type.
 *
 * When a `metadataFingerprint` is supplied, only obligations whose
 * `metadata.fingerprint` matches are returned. This prevents a /review
 * call for prNumber=42 from reusing an obligation created for prNumber=99.
 *
 * Used by standalone /review to reuse an existing pending obligation (retry-safe)
 * rather than creating a fresh one on every call.
 */
export function findLatestPendingReviewObligation(
  assurance: ReviewAssuranceState | undefined,
  obligationType: ReviewObligationType,
  metadataFingerprint?: string,
): ReviewObligation | null {
  const base = ensureReviewAssurance(assurance);
  const candidates = base.obligations.filter(
    (o) => o.obligationType === obligationType && o.status === 'pending',
  );
  // Fingerprint filter: when provided, only match obligations with the same
  // input fingerprint. For review obligations, fingerprinting is mandatory
  // because multiple review inputs can be pending simultaneously.
  // For plan/implement/architecture, there is at most one pending obligation
  // per type at a time, so broad matching is acceptable.
  if (metadataFingerprint) {
    return (
      candidates
        .filter((o) => o.metadata && o.metadata.fingerprint === metadataFingerprint)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .at(0) ?? null
    );
  }
  // Broad match: return the latest pending obligation of this type.
  // Only safe when fingerprinting is not required (plan, implement, architecture).
  const broad = candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return broad.at(0) ?? null;
}

/**
 * Find a review obligation by its exact UUID.
 *
 * Used when reviewFindings carry attestation.toolObligationId — the
 * obligation was either created by the blocked response (pending) or already
 * fulfilled by the plugin-orchestrator. Both states are valid for the final
 * submit; only 'consumed' obligations are rejected (single-use enforcement).
 */
export function findReviewObligationById(
  assurance: ReviewAssuranceState | undefined,
  obligationId: string,
): ReviewObligation | null {
  const base = ensureReviewAssurance(assurance);
  return base.obligations.find((o) => o.obligationId === obligationId) ?? null;
}

/**
 * Find the latest unconsumed obligation of a given type.
 * Matches both 'pending' and 'fulfilled' statuses — plugin-orchestrated
 * obligations are set to 'fulfilled' before the agent's Mode B submission.
 * Excludes 'consumed' obligations (single-use enforcement).
 *
 * Used by /architecture Mode B for consistency with the manual search that
 * previously matched status !== 'consumed' && consumedAt == null.
 */
export function findLatestUnconsumedObligation(
  assurance: ReviewAssuranceState | undefined,
  obligationType: ReviewObligationType,
): ReviewObligation | null {
  const base = ensureReviewAssurance(assurance);
  return (
    base.obligations
      .filter(
        (o) =>
          o.obligationType === obligationType && o.status !== 'consumed' && o.consumedAt === null,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .at(0) ?? null
  );
}

export function consumeReviewObligation(
  assurance: ReviewAssuranceState,
  obligation: ReviewObligation | null,
  now: string,
  acceptedInvocationId?: string | null,
): ReviewAssuranceState {
  if (!obligation) return assurance;
  const invocationId = acceptedInvocationId ?? obligation.invocationId;
  return {
    obligations: assurance.obligations.map((item) => {
      if (item.obligationId !== obligation.obligationId) return item;
      return {
        ...item,
        status: 'consumed' as const,
        consumedAt: now,
      };
    }),
    invocations: assurance.invocations.map((invocation) => {
      if (!invocationId || invocation.invocationId !== invocationId) {
        return invocation;
      }
      return {
        ...invocation,
        consumedByObligationId: obligation.obligationId,
      };
    }),
  };
}

export function findAcceptedInvocationForFindings(
  assurance: ReviewAssuranceState | undefined,
  obligation: ReviewObligation | null,
  findings: ReviewFindings | null | undefined,
): ReviewInvocationEvidence | null {
  if (!obligation || !findings) return null;
  const findingsHash = hashFindings(findings);
  const base = ensureReviewAssurance(assurance);

  if (obligation.invocationId) {
    return (
      base.invocations.find(
        (invocation) =>
          invocation.invocationId === obligation.invocationId &&
          invocation.obligationId === obligation.obligationId &&
          invocation.childSessionId === findings.reviewedBy.sessionId &&
          invocation.findingsHash === findingsHash &&
          invocation.consumedByObligationId === null,
      ) ?? null
    );
  }

  return (
    base.invocations.find(
      (invocation) =>
        invocation.obligationId === obligation.obligationId &&
        invocation.invocationMode === 'host_subagent_task' &&
        invocation.hostVisible === true &&
        invocation.childSessionId === findings.reviewedBy.sessionId &&
        invocation.findingsHash === findingsHash &&
        invocation.consumedByObligationId === null,
    ) ?? null
  );
}

export function hashFindings(findings: Record<string, unknown>): string {
  return hashText(JSON.stringify(findings));
}

export function buildInvocationEvidence(input: {
  obligationId: string;
  obligationType: ReviewObligationType;
  parentSessionId: string;
  childSessionId: string;
  invocationMode: ReviewInvocationMode;
  hostVisible: boolean;
  promptHash: string;
  findingsHash: string;
  invokedAt: string;
  fulfilledAt?: string;
  source?: 'host-orchestrated' | 'agent-submitted-attested';
  reviewOutputMode?: 'structured_output' | 'text_compat';
  structuredOutputUsed?: boolean;
  reviewAssuranceLevel?: 'structured_high' | 'structured_recovered' | 'text_compat_lower';
  extractionMethod?: 'direct_json' | 'json_fence' | 'outermost_braces';
  modelCapabilityError?: string;
  /** Captured verdict from the reviewer's actual output (host-task authoritative). */
  capturedVerdict?: string;
  /** Complete raw findings from the reviewer's output (host-task only).
   *  Enables evidence-based findings resolution without agent reconstruction. */
  capturedRawFindings?: Record<string, unknown>;
  /** Independent host-captured reviewer corroboration (native_subagent_attested only). */
  hostCapturedAgentId?: string;
  hostCapturedAgentType?: typeof REVIEWER_SUBAGENT_TYPE;
  hostCaptureSource?: 'subagent_stop_hook' | 'post_tool_use_hook';
  /** Resolved full head commit SHA (branch reviews only). */
  resolvedBranchSha?: string | null;
  /** Resolved full base commit SHA (branch reviews only). */
  resolvedBaseSha?: string | null;
  /** SHA-256 digest of the extracted/reviewed content (branch reviews only). */
  reviewedContentDigest?: string | null;
}): ReviewInvocationEvidence {
  const reviewOutputMode = input.reviewOutputMode ?? 'structured_output';
  const structuredOutputUsed =
    input.structuredOutputUsed ?? reviewOutputMode === 'structured_output';
  const reviewAssuranceLevel =
    input.reviewAssuranceLevel ??
    (reviewOutputMode === 'text_compat' ? 'text_compat_lower' : 'structured_high');
  return {
    invocationId: randomUUID(),
    obligationId: input.obligationId,
    obligationType: input.obligationType,
    parentSessionId: input.parentSessionId,
    childSessionId: input.childSessionId,
    agentType: REVIEWER_SUBAGENT_TYPE,
    invocationMode: input.invocationMode,
    hostVisible: input.hostVisible,
    promptHash: input.promptHash,
    mandateDigest: REVIEW_MANDATE_DIGEST,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    findingsHash: input.findingsHash,
    invokedAt: input.invokedAt,
    fulfilledAt: input.fulfilledAt ?? null,
    consumedByObligationId: null,
    source: input.source,
    reviewOutputMode,
    structuredOutputUsed,
    reviewAssuranceLevel,
    resolvedBranchSha: input.resolvedBranchSha ?? null,
    resolvedBaseSha: input.resolvedBaseSha ?? null,
    reviewedContentDigest: input.reviewedContentDigest ?? null,
    ...buildOptionalInvocationFields(input),
  };
}

function buildOptionalInvocationFields(input: {
  extractionMethod?: 'direct_json' | 'json_fence' | 'outermost_braces';
  modelCapabilityError?: string;
  capturedVerdict?: string;
  capturedRawFindings?: Record<string, unknown>;
  hostCapturedAgentId?: string;
  hostCapturedAgentType?: typeof REVIEWER_SUBAGENT_TYPE;
  hostCaptureSource?: 'subagent_stop_hook' | 'post_tool_use_hook';
}): Record<string, unknown> {
  return {
    ...(input.extractionMethod ? { extractionMethod: input.extractionMethod } : {}),
    ...(input.modelCapabilityError ? { modelCapabilityError: input.modelCapabilityError } : {}),
    ...(input.capturedVerdict ? { capturedVerdict: input.capturedVerdict } : {}),
    ...(input.capturedRawFindings ? { capturedRawFindings: input.capturedRawFindings } : {}),
    ...(input.hostCapturedAgentId ? { hostCapturedAgentId: input.hostCapturedAgentId } : {}),
    ...(input.hostCapturedAgentType ? { hostCapturedAgentType: input.hostCapturedAgentType } : {}),
    ...(input.hostCaptureSource ? { hostCaptureSource: input.hostCaptureSource } : {}),
  };
}

export function hasEvidenceReuse(
  invocations: ReviewInvocationEvidence[],
  childSessionId: string,
  findingsHash: string,
): boolean {
  return invocations.some(
    (item) => item.childSessionId === childSessionId || item.findingsHash === findingsHash,
  );
}

/**
 * Append a ReviewInvocationEvidence record to the assurance state.
 * Uses spread to preserve any future fields added to ReviewAssuranceState.
 */
export function appendInvocationEvidence(
  assurance: ReviewAssuranceState,
  invocation: ReviewInvocationEvidence,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  return { ...base, invocations: [...base.invocations, invocation] };
}

/**
 * Mark an obligation as fulfilled and bind it to an invocation.
 * Uses spread to preserve any future fields added to ReviewObligation.
 */
export function fulfillObligation(
  assurance: ReviewAssuranceState,
  obligationId: string,
  invocationId: string,
  now: string,
): ReviewAssuranceState {
  const base = ensureReviewAssurance(assurance);
  return {
    ...base,
    obligations: base.obligations.map((o) =>
      o.obligationId !== obligationId
        ? o
        : { ...o, status: 'fulfilled' as const, invocationId, fulfilledAt: now },
    ),
  };
}

export function validateStrictAttestation(
  findings: ReviewFindings,
  expected: {
    obligationId: string;
    iteration: number;
    planVersion: number;
  },
): 'SUBAGENT_MANDATE_MISSING' | 'SUBAGENT_MANDATE_MISMATCH' | null {
  const att = findings.attestation;
  if (!att) return 'SUBAGENT_MANDATE_MISSING';

  if (
    att.mandateDigest !== REVIEW_MANDATE_DIGEST ||
    att.criteriaVersion !== REVIEW_CRITERIA_VERSION ||
    att.toolObligationId !== expected.obligationId ||
    att.iteration !== expected.iteration ||
    att.planVersion !== expected.planVersion ||
    att.reviewedBy !== REVIEWER_SUBAGENT_TYPE
  ) {
    return 'SUBAGENT_MANDATE_MISMATCH';
  }

  return null;
}
