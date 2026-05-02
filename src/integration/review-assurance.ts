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
import { REVIEWER_SUBAGENT_TYPE } from './tool-names.js';

export const REVIEW_CRITERIA_VERSION = 'p35-v1';

// Dynamic mandate digest - computed from actual REVIEWER_AGENT template
// This prevents failures when the template content changes
let _mandateDigest: string | null = null;

function computeReviewMandateDigest(): string {
  const defaultText = 'FlowGuard P35 strict mandate: each independent-review obligation must be fulfilled by exactly one flowguard-reviewer subagent invocation bound to obligationId/iteration/planVersion/criteriaVersion/mandateDigest. No fallback path is accepted in strict mode.';
  
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mandates = require('../templates/mandates.js');
    const REVIEWER_AGENT = mandates.REVIEWER_AGENT || defaultText;
    return createHash('sha256').update(REVIEWER_AGENT, 'utf-8').digest('hex');
  } catch (_err) {
    return createHash('sha256').update(defaultText, 'utf-8').digest('hex');
  }
}

export function getReviewMandateDigest(): string {
  if (_mandateDigest === null) {
    _mandateDigest = computeReviewMandateDigest();
  }
  return _mandateDigest;
}

// For backward compatibility - computed at first use
export const REVIEW_MANDATE_DIGEST = getReviewMandateDigest();

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
