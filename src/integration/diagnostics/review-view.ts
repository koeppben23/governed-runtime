/**
 * @module integration/diagnostics/review-view
 * @description Read-only review-view content shell.
 *
 * The view displays the exact persisted subject revision and digest, reviewer
 * verdict, findings and review-assurance bindings. It never implies approval
 * authority and never exposes a decision control.
 */

import type { DiagnosticWarning } from '../../adapters/diagnostics/export-schema.js';
import { resolveSessionAuthority } from '../../adapters/session-authority.js';
import { buildProofApprovalProjection } from '../proofgraph/approval-projection.js';
import { projectReviewLinks } from './review-links.js';
import {
  DEFAULT_MAX_SUBJECT_BYTES,
  sanitizedWarning,
  selectSubject,
  unavailableSubject,
} from './review-subject.js';
import type { ReviewSubjectView, ReviewView } from './types.js';

export interface ReviewViewRequest {
  readonly root: string;
  readonly sessionId: string;
  /** Bound for the verbatim subject content shown in the command output. */
  readonly maxSubjectBytes?: number;
  /** Deterministic test seam; production uses the current clock. */
  readonly now?: () => Date;
}

function reviewStatus(
  subject: ReviewSubjectView,
  warnings: readonly DiagnosticWarning[],
): 'COMPLETE' | 'PARTIAL' | 'NOT_VERIFIED' {
  if (subject.kind === 'unavailable') return 'NOT_VERIFIED';
  const partial =
    warnings.length > 0 ||
    subject.subjectBinding === 'mismatch' ||
    subject.contentVerified === 'mismatch' ||
    subject.contentTruncated ||
    subject.findingsTruncated;
  return partial ? 'PARTIAL' : 'COMPLETE';
}

/** Build the read-only review-view projection for the requested session. */
export async function buildReviewView(request: ReviewViewRequest): Promise<ReviewView> {
  const generatedAt = (request.now ?? (() => new Date()))().toISOString();
  const maxSubjectBytes = request.maxSubjectBytes ?? DEFAULT_MAX_SUBJECT_BYTES;
  const warnings: DiagnosticWarning[] = [];
  const resolution = await resolveSessionAuthority({
    root: request.root,
    sessionId: request.sessionId,
  });

  if (resolution.status !== 'resolved') {
    warnings.push(
      sanitizedWarning(
        resolution.status === 'absent' ? 'SESSION_STATE_ABSENT' : `SESSION_${resolution.code}`,
        resolution.status === 'absent'
          ? 'No FlowGuard state exists for this session.'
          : `Session state could not be resolved: ${resolution.reason}`,
        request.sessionId,
        'state',
      ),
    );
    return {
      schemaVersion: 'diagnostic-view.v1',
      kind: 'review',
      rootSessionId: request.sessionId,
      generatedAt,
      status: 'NOT_VERIFIED',
      phase: null,
      subject: unavailableSubject(),
      reviewLinks: null,
      proof: null,
      decisionAuthority: 'not_granted',
      warnings,
    };
  }

  const state = resolution.state;
  const subject =
    (await selectSubject(state, resolution.sessDir, warnings, maxSubjectBytes)) ??
    unavailableSubject();
  const reviewLinks = projectReviewLinks(state, warnings);
  const status = reviewStatus(subject, warnings);

  return {
    schemaVersion: 'diagnostic-view.v1',
    kind: 'review',
    rootSessionId: request.sessionId,
    generatedAt,
    status,
    phase: state.phase,
    subject,
    reviewLinks,
    proof: buildProofApprovalProjection(state),
    decisionAuthority: 'not_granted',
    warnings,
  };
}
