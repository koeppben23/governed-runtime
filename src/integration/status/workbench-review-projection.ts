/** Read-only, bounded native Desktop Review Workbench projection.
 * Reuses ADR-011 diagnostics; it neither grants decision authority nor emits audit.
 */
import { z } from 'zod';
import type { ReviewView } from '../diagnostics/types.js';

export const WorkbenchReviewRequest = z.object({ sessionID: z.string().min(1) }).strict();
export type WorkbenchReviewRequest = z.infer<typeof WorkbenchReviewRequest>;

const WorkbenchFinding = z
  .object({
    severity: z.string(),
    category: z.string(),
    message: z.string(),
  })
  .strict();

const WorkbenchClaim = z
  .object({
    statement: z.string(),
    critical: z.boolean(),
    verificationState: z.string().nullable(),
    evidenceCount: z.number().int().nonnegative(),
  })
  .strict();

export const WorkbenchReviewResult = z
  .object({
    schemaVersion: z.literal('workbench-review.v1'),
    sessionID: z.string().min(1),
    status: z.enum(['COMPLETE', 'PARTIAL', 'NOT_VERIFIED']),
    phase: z.string().nullable(),
    subject: z
      .object({
        kind: z.string(),
        label: z.string(),
        revision: z.string().nullable(),
        digest: z.string().nullable(),
        contentVerified: z.string(),
        subjectBinding: z.string(),
        reviewerVerdict: z.string().nullable(),
        reviewCompletion: z.string().nullable(),
        reviewedAt: z.string().nullable(),
        reviewedSubjectDigest: z.string().nullable(),
        reviewedObligationId: z.string().nullable(),
        findings: z.array(WorkbenchFinding),
        findingsTotal: z.number().int().nonnegative(),
        findingsTruncated: z.boolean(),
        missingVerification: z.array(z.string()),
        missingVerificationTruncated: z.boolean(),
        unboundReviewReason: z.string().nullable(),
        historicalReview: z.boolean(),
      })
      .strict(),
    proof: z
      .object({
        claimsTotal: z.number().int().nonnegative(),
        claims: z.array(WorkbenchClaim),
        claimsTruncated: z.boolean(),
        coverageGapCount: z.number().int().nonnegative(),
        certificateCount: z.number().int().nonnegative(),
      })
      .strict(),
    reviewAttempts: z.number().int().nonnegative(),
    warningCodes: z.array(z.string()),
    warningsTruncated: z.boolean(),
    decisionAuthority: z.literal('not_granted'),
  })
  .strict();
export type WorkbenchReviewResult = z.infer<typeof WorkbenchReviewResult>;

const MAX_FINDINGS = 20;
const MAX_CLAIMS = 20;
const MAX_MISSING = 20;
const MAX_WARNINGS = 20;
const MAX_MESSAGE_CHARS = 500;

function bounded(value: string, max = MAX_MESSAGE_CHARS): string {
  return value.length > max ? value.slice(0, max) + '...' : value;
}

/**
 * Project exact persisted review information with bounded UI payloads.
 * Suppress raw subject content and file paths. Missing and stale review evidence
 * remains explicit instead of being converted into a successful review.
 */
export function projectWorkbenchReview(view: ReviewView, sessionID: string): WorkbenchReviewResult {
  const subject = view.subject;
  const claims = view.proof?.claims ?? [];
  return WorkbenchReviewResult.parse({
    schemaVersion: 'workbench-review.v1',
    sessionID,
    status: view.status,
    phase: view.phase,
    subject: {
      kind: subject.kind,
      label: bounded(subject.label, 150),
      revision: subject.revision,
      digest: subject.digest,
      contentVerified: subject.contentVerified,
      subjectBinding: subject.subjectBinding,
      reviewerVerdict: subject.reviewerVerdict,
      reviewCompletion: subject.reviewCompletion,
      reviewedAt: subject.reviewedAt,
      reviewedSubjectDigest: subject.reviewedSubjectDigest,
      reviewedObligationId: subject.reviewedObligationId,
      findings: subject.findings.slice(0, MAX_FINDINGS).map((finding) => ({
        severity: bounded(finding.severity, 40),
        category: bounded(finding.category, 80),
        message: bounded(finding.message),
      })),
      findingsTotal: subject.findings.length,
      findingsTruncated: subject.findingsTruncated || subject.findings.length > MAX_FINDINGS,
      missingVerification: subject.missingVerification.slice(0, MAX_MISSING).map(bounded),
      missingVerificationTruncated: subject.missingVerification.length > MAX_MISSING,
      unboundReviewReason: subject.unboundReview?.reason ?? null,
      historicalReview: subject.historicalImplReview !== null,
    },
    proof: {
      claimsTotal: claims.length,
      claims: claims.slice(0, MAX_CLAIMS).map((claim) => ({
        statement: bounded(claim.statement),
        critical: claim.critical,
        verificationState: claim.verificationState,
        evidenceCount: claim.evidenceRefCount,
      })),
      claimsTruncated: claims.length > MAX_CLAIMS,
      coverageGapCount: view.proof?.coverageGaps.length ?? 0,
      certificateCount: view.proof?.certificates.length ?? 0,
    },
    reviewAttempts: view.reviewLinks?.attempts.length ?? 0,
    warningCodes: view.warnings.slice(0, MAX_WARNINGS).map((warning) => bounded(warning.code, 100)),
    warningsTruncated: view.warnings.length > MAX_WARNINGS,
    decisionAuthority: 'not_granted',
  });
}
