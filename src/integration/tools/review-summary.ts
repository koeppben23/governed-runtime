import type { ReviewFindings } from '../../state/evidence.js';

export function buildLatestImplementationReviewSummary(
  findings: ReviewFindings[],
): Record<string, string | number> | undefined {
  if (findings.length === 0) return undefined;
  const rf = findings.at(-1);
  if (!rf) return undefined;
  return {
    iteration: rf.iteration,
    reviewMode: rf.reviewMode,
    overallVerdict: rf.overallVerdict,
    blockingIssueCount: rf.blockingIssues.length,
    majorRiskCount: rf.majorRisks.length,
    missingVerificationCount: rf.missingVerification.length,
    reviewedAt: rf.reviewedAt,
  };
}
