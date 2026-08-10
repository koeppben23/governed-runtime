/**
 * @module integration/review/report-coherence
 * @description Canonical authority for validating whether a persisted ReviewReport
 * matches the current session snapshot. Consumers must not define their own
 * coherence rules.
 */

import type { SessionState } from '../../state/schema.js';
import type { ReviewReport } from '../../state/evidence.js';

export type ReviewReportResolutionReason =
  'foreign_session' | 'phase_mismatch' | 'stale_plan_digest' | 'stale_impl_digest';

export type ReviewReportResolution =
  | {
      readonly status: 'current';
      readonly report: ReviewReport;
    }
  | {
      readonly status: 'stale' | 'foreign' | 'incoherent';
      readonly reasonCode: ReviewReportResolutionReason;
    };

/**
 * Determine whether a persisted ReviewReport matches the current session snapshot.
 *
 * A stale or incoherent report must not be used as a recommendation authority.
 * Consumers project the resolution; they do not invent their own coherence rules.
 */
export function resolveCurrentReviewReport(
  state: SessionState,
  report: ReviewReport,
): ReviewReportResolution {
  if (report.sessionId !== state.id) {
    return { status: 'foreign', reasonCode: 'foreign_session' };
  }
  if (report.phase !== state.phase) {
    return { status: 'incoherent', reasonCode: 'phase_mismatch' };
  }
  if (report.planDigest !== (state.plan?.current.digest ?? null)) {
    return { status: 'stale', reasonCode: 'stale_plan_digest' };
  }
  if (report.implDigest !== (state.implementation?.candidate.candidateDigest ?? null)) {
    return { status: 'stale', reasonCode: 'stale_impl_digest' };
  }
  return { status: 'current', report };
}
