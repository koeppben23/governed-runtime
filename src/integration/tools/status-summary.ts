/**
 * @module integration/tools/status-summary
 * @description Review summary projections shared by the status tool.
 *
 * Extracted from status-tool.ts to keep the status builder within the
 * production file-size budget. The `iteration` field keeps the host-authoritative
 * semantics (hostIteration ?? findings.iteration); the additive forensic fields
 * (reviewerIteration, reviewedPlanVersion, reviewedDigest, reviewedObligationId)
 * come from the findings-based provenance resolver and are omitted when the
 * producer identity cannot be resolved.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import type { ReviewFindings, ReviewObligationType } from '../../state/evidence.js';
import {
  resolveReviewedArtifactIdentity,
  reviewedIdentityFields,
} from '../review/reviewed-digest.js';

export function latestReviewSummary(
  findings: ReadonlyArray<ReviewFindings> | null | undefined,
  opts: {
    includePlanVersion: boolean;
    hostIteration?: number;
    assurance?: SessionState['reviewAssurance'];
    obligationType?: ReviewObligationType;
  },
): Record<string, unknown> | null {
  if (!findings || findings.length === 0) return null;
  const latest = findings.at(-1);
  if (!latest) return null;
  const identity = opts.obligationType
    ? resolveReviewedArtifactIdentity(opts.assurance, opts.obligationType, latest)
    : undefined;
  return {
    iteration: opts.hostIteration ?? latest.iteration,
    ...(opts.includePlanVersion ? { planVersion: latest.planVersion } : {}),
    overallVerdict: latest.overallVerdict,
    blockingIssueCount: latest.blockingIssues.length,
    majorRiskCount: latest.majorRisks.length,
    missingVerificationCount: latest.missingVerification.length,
    reviewMode: latest.reviewMode,
    reviewedAt: latest.reviewedAt,
    ...reviewedIdentityFields(identity),
  };
}
