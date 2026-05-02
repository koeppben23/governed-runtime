/**
 * @module integration/review-assurance
 * @description SSOT helpers for strict independent-review obligations and evidence.
 */

import { createHash, randomUUID } from 'node:crypto';

import type {
  ReviewAssuranceState,
  ReviewFindings,
  ReviewInvocationEvidence,
  ReviewObligation,
  ReviewObligationType,
} from '../state/evidence.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';

// Static import - mandate content is a constant in ESM
import { REVIEWER_AGENT } from '../templates/mandates.js';

export const REVIEW_CRITERIA_VERSION = 'p35-v1';

// Mandate digest - computed from actual REVIEWER_AGENT template at module load
// No fallback: if the import fails, the module fails fast (desired for governance)
export const REVIEW_MANDATE_DIGEST = createHash('sha256')
  .update(REVIEWER_AGENT, 'utf-8')
  .digest('hex');

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
  metadata?: Record<string, unknown>;
}): ReviewObligation {
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
    metadata: input.metadata,
  };
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
    },
    reviewObligationId: obligation.obligationId,
    reviewObligationIteration: obligation.iteration,
    reviewObligationPlanVersion: obligation.planVersion,
    reviewCriteriaVersion: obligation.criteriaVersion,
    reviewMandateDigest: obligation.mandateDigest,
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
 * Used when analysisFindings carry attestation.toolObligationId — the
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

export function consumeReviewObligation(
  assurance: ReviewAssuranceState,
  obligation: ReviewObligation | null,
  now: string,
): ReviewAssuranceState {
  if (!obligation) return assurance;
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
      if (invocation.invocationId !== obligation.invocationId) return invocation;
      return {
        ...invocation,
        consumedByObligationId: obligation.obligationId,
      };
    }),
  };
}

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

export function hashFindings(findings: Record<string, unknown>): string {
  return hashText(JSON.stringify(findings));
}

export function buildInvocationEvidence(input: {
  obligationId: string;
  obligationType: ReviewObligationType;
  parentSessionId: string;
  childSessionId: string;
  promptHash: string;
  findingsHash: string;
  invokedAt: string;
  fulfilledAt: string;
  source?: 'host-orchestrated' | 'agent-submitted-attested';
}): ReviewInvocationEvidence {
  return {
    invocationId: randomUUID(),
    obligationId: input.obligationId,
    obligationType: input.obligationType,
    parentSessionId: input.parentSessionId,
    childSessionId: input.childSessionId,
    agentType: REVIEWER_SUBAGENT_TYPE,
    promptHash: input.promptHash,
    mandateDigest: REVIEW_MANDATE_DIGEST,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    findingsHash: input.findingsHash,
    invokedAt: input.invokedAt,
    fulfilledAt: input.fulfilledAt,
    consumedByObligationId: null,
    source: input.source,
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
