/**
 * @module integration/review/validation/review-validation-failure
 * @description Domain failure contract and adapter serializer for review
 * findings validation and structured resolution.
 *
 * The validation authorities return domain verdicts only. This module owns the
 * mapping from resolution variants to a single failure contract and the one
 * serializer that turns a failure into the external blocked envelope. Operator
 * diagnostics travel alongside the failure (independent of the final
 * resolution result) and are replayed into the injected logger — they are
 * never serialized into the envelope.
 */

import type { ReviewFindingsConsistencyResult } from '../enforcement/findings-consistency.js';
import type { ReviewFindingsScopeResult } from '../enforcement/findings-consistency.js';
import { formatBlocked } from '../../blocked-result.js';
import { TOOL_FLOWGUARD_REVIEW } from '../../tool-names.js';
import type { ReviewDiagnosticLogger } from '../review-logger-port.js';
import {
  acceptanceRejectionVars,
  type ReviewFindingsAcceptanceRejectionReason,
} from './review-validation-acceptance.js';
import type {
  StructuredFindingsResolution,
  StructuredIncoherenceCode,
  StructuredResolutionDiagnostics,
} from './review-validation-structured-evidence.js';

/**
 * Blocked codes the review validation boundary can produce. Derived from the
 * emitting review authorities; not a second reason registry.
 */
export type ReviewBlockedCode =
  | ReviewFindingsAcceptanceRejectionReason
  | Extract<ReviewFindingsConsistencyResult, { readonly ok: false }>['code']
  | Extract<ReviewFindingsScopeResult, { readonly ok: false }>['code']
  | StructuredIncoherenceCode
  | 'REVIEW_MODE_SELF_NOT_ALLOWED'
  | 'SUBAGENT_UNABLE_TO_REVIEW'
  | 'REVIEW_PLAN_VERSION_MISMATCH'
  | 'REVIEW_ITERATION_MISMATCH'
  | 'REVIEW_EVIDENCE_NOT_OBSERVED'
  | 'PLUGIN_ENFORCEMENT_UNAVAILABLE'
  | 'SUBAGENT_EVIDENCE_MISSING'
  | 'REVIEW_SELF_APPROVAL_DENIED'
  | 'SUBAGENT_MANDATE_MISSING'
  | 'SUBAGENT_MANDATE_MISMATCH'
  | 'REVIEW_FINDINGS_SESSION_MISMATCH'
  | 'REVIEW_FINDINGS_HASH_MISMATCH'
  | 'REVIEW_ATTEMPT_LINEAGE_UNAVAILABLE'
  | 'INVALID_REVIEW_TOOL_SEQUENCE'
  | 'REVIEWER_UNAVAILABLE_STRICT';

/**
 * Domain failure of review findings validation. Adapters serialize it through
 * {@link formatReviewValidationFailure}; diagnostics stay outside the blocked
 * envelope.
 */
export interface ReviewValidationFailure {
  readonly code: ReviewBlockedCode;
  readonly vars: Readonly<Record<string, string>>;
  /** Operator-only diagnostics; never serialized into the blocked envelope. */
  readonly diagnostics?: readonly StructuredResolutionDiagnostics[];
}

type ResolutionFailureCore = Pick<ReviewValidationFailure, 'code' | 'vars' | 'diagnostics'>;

function resolutionFailureCore(
  resolution: Exclude<StructuredFindingsResolution, { kind: 'resolved' }>,
): ResolutionFailureCore {
  if (resolution.kind === 'rejected') {
    return {
      code: resolution.rejection.reason,
      vars: acceptanceRejectionVars(resolution.rejection),
    };
  }
  if (resolution.kind === 'incoherent') {
    return {
      code: resolution.code,
      vars: Object.fromEntries(
        Object.entries(resolution.details).map(([key, value]) => [key, String(value)]),
      ),
    };
  }
  if (resolution.kind === 'attempt_lineage_unavailable') {
    return {
      code: 'REVIEW_ATTEMPT_LINEAGE_UNAVAILABLE',
      vars: { invocationId: resolution.invocationId, obligationId: resolution.obligationId },
    };
  }
  if (resolution.kind === 'unparseable') {
    return {
      code: 'SUBAGENT_EVIDENCE_MISSING',
      vars: { reason: resolution.detail },
      diagnostics: [resolution.diagnostics],
    };
  }
  if (resolution.kind === 'not_found') {
    return {
      code: 'SUBAGENT_EVIDENCE_MISSING',
      vars: { reason: 'no matching structured capture' },
    };
  }
  return { code: resolution.code, vars: { obligationId: resolution.obligationId } };
}

/**
 * Pure mapping: structured resolution variant → domain failure. Collected
 * diagnostics win over the variant's own diagnostic so a discarded capture
 * surfaces even when the final resolution variant is not `unparseable`.
 */
export function structuredResolutionFailure(
  resolution: Exclude<StructuredFindingsResolution, { kind: 'resolved' }>,
  diagnostics: readonly StructuredResolutionDiagnostics[] = [],
): ReviewValidationFailure {
  const failure = resolutionFailureCore(resolution);
  const resolvedDiagnostics = diagnostics.length > 0 ? diagnostics : failure.diagnostics;
  return resolvedDiagnostics === undefined
    ? { code: failure.code, vars: failure.vars }
    : { code: failure.code, vars: failure.vars, diagnostics: resolvedDiagnostics };
}

/**
 * Replay collected operator diagnostics into the injected logger. Adapters call
 * this for RESOLVED results as well: a discarded unusable capture is still
 * operator-relevant even when a later retry resolves.
 */
export function logStructuredResolutionDiagnostics(
  logger: ReviewDiagnosticLogger,
  diagnostics: readonly StructuredResolutionDiagnostics[],
): void {
  for (const diagnostic of diagnostics) {
    logger.warn(
      TOOL_FLOWGUARD_REVIEW,
      'structured captured findings present but unparseable; treated as unparseable',
      {
        obligationId: diagnostic.obligationId,
        invocationId: diagnostic.invocationId,
        issues: diagnostic.issues,
      },
    );
  }
}

/**
 * Adapter-facing serializer: replays operator diagnostics into the injected
 * logger, then renders the single blocked envelope for the failure. This is
 * the only place a review-validation failure becomes an external result.
 */
export function formatReviewValidationFailure(
  logger: ReviewDiagnosticLogger,
  failure: ReviewValidationFailure,
): string {
  logStructuredResolutionDiagnostics(logger, failure.diagnostics ?? []);
  return formatBlocked(failure.code, { ...failure.vars });
}
