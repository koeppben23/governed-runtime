/**
 * @module integration/review/validation/review-validation-failure
 * @description Domain failure contract and adapter serializer for structured
 * review-findings resolution.
 *
 * The resolution authorities return domain verdicts only. This module owns the
 * mapping from resolution variants to a single failure contract and the one
 * serializer that turns a failure into the external blocked envelope. Operator
 * diagnostics travel alongside the failure and are replayed into the injected
 * logger — they are never serialized into the envelope.
 */

import type { ReviewFindingsConsistencyResult } from '../enforcement/findings-consistency.js';
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
 * Blocked codes the structured-resolution boundary can produce. Derived from
 * the emitting review authorities; not a second reason registry.
 */
export type ReviewBlockedCode =
  | ReviewFindingsAcceptanceRejectionReason
  | Extract<ReviewFindingsConsistencyResult, { readonly ok: false }>['code']
  | StructuredIncoherenceCode
  | 'REVIEW_ATTEMPT_LINEAGE_UNAVAILABLE'
  | 'SUBAGENT_EVIDENCE_MISSING'
  | 'REVIEW_FINDINGS_HASH_MISMATCH'
  | 'INVALID_REVIEW_TOOL_SEQUENCE'
  | 'REVIEWER_UNAVAILABLE_STRICT';

/**
 * Domain failure of the structured-evidence resolution. Adapters serialize it
 * through {@link formatStructuredResolutionFailure}; diagnostics stay outside
 * the blocked envelope.
 */
export interface ReviewValidationFailure {
  readonly code: ReviewBlockedCode;
  readonly vars: Readonly<Record<string, string>>;
  /** Operator-only diagnostics; never serialized into the blocked envelope. */
  readonly diagnostics?: StructuredResolutionDiagnostics;
}

/** Pure mapping: structured resolution variant → domain failure. */
export function structuredResolutionFailure(
  resolution: Exclude<StructuredFindingsResolution, { kind: 'resolved' }>,
): ReviewValidationFailure {
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
      diagnostics: resolution.diagnostics,
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
 * Adapter-facing serializer: replays operator diagnostics into the injected
 * logger, then renders the single blocked envelope for the failure. This is
 * the only place a structured-resolution failure becomes an external result.
 */
export function formatStructuredResolutionFailure(
  logger: ReviewDiagnosticLogger,
  failure: ReviewValidationFailure,
): string {
  if (failure.diagnostics) {
    logger.warn(
      TOOL_FLOWGUARD_REVIEW,
      'structured captured findings present but unparseable; treated as unparseable',
      {
        obligationId: failure.diagnostics.obligationId,
        invocationId: failure.diagnostics.invocationId,
        issues: failure.diagnostics.issues,
      },
    );
  }
  return formatBlocked(failure.code, { ...failure.vars });
}
