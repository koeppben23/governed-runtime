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
    counterexampleCount: z.number().int().nonnegative().optional(),
    certificateBinding: z.enum(['current', 'stale_or_unbound', 'not_recorded']).optional(),
  })
  .strict();

const WorkbenchTimelineEvent = z
  .object({
    at: z.string().min(1),
    kind: z.enum(['attempt', 'dispatch', 'invocation', 'obligation']),
    label: z.string().min(1),
    state: z.string().min(1),
  })
  .strict();

const WorkbenchTimeline = z
  .object({
    source: z.literal('review_assurance'),
    status: z.enum(['available', 'truncated', 'not_available']),
    total: z.number().int().nonnegative(),
    events: z.array(WorkbenchTimelineEvent),
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
    timeline: WorkbenchTimeline.optional(),
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
const MAX_TIMELINE_EVENTS = 32;

function bounded(value: string, max = MAX_MESSAGE_CHARS): string {
  return value.length > max ? value.slice(0, max) + '...' : value;
}

function reviewTimeline(view: ReviewView): z.infer<typeof WorkbenchTimeline> {
  const links = view.reviewLinks;
  if (!links) {
    return { source: 'review_assurance', status: 'not_available', total: 0, events: [] };
  }
  type Event = z.infer<typeof WorkbenchTimelineEvent>;
  const events: Event[] = [];
  const record = (at: string | null, kind: Event['kind'], label: string, state: string) => {
    if (at) events.push({ at, kind, label, state: bounded(state, 100) });
  };
  for (const item of links.attempts) {
    const label = 'Reviewer attempt ' + item.ordinal;
    record(item.createdAt, 'attempt', label + ' created', 'created');
    record(item.completedAt, 'attempt', label + ' ended', item.status);
  }
  for (const item of links.dispatches) {
    // An authorized release is not proof that execution was captured.
    record(item.dispatchAuthorizedAt, 'dispatch', 'Reviewer dispatch authorized',
      item.dispatchStatus);
    record(item.completedAt, 'dispatch', 'Reviewer dispatch ended', item.dispatchStatus);
  }
  for (const item of links.invocations) {
    record(item.invokedAt, 'invocation', 'Reviewer invocation started', 'recorded');
    record(item.fulfilledAt, 'invocation', 'Reviewer invocation evidence bound',
      item.capturedVerdict ?? 'verdict_not_recorded');
  }
  for (const item of links.obligations) {
    record(item.fulfilledAt, 'obligation', 'Review obligation fulfilled', item.status);
    record(item.consumedAt, 'obligation', 'Review obligation consumed', item.status);
  }
  // All timestamps originate from persisted review-assurance links; never use
  // generatedAt or current clock to invent a missing event.
  events.sort((left, right) =>
    left.at === right.at
      ? (left.kind + left.label).localeCompare(right.kind + right.label)
      : left.at.localeCompare(right.at));
  const truncated = links.truncated || events.length > MAX_TIMELINE_EVENTS;
  return {
    source: 'review_assurance',
    status: truncated ? 'truncated' : 'available',
    total: events.length,
    events: events.slice(-MAX_TIMELINE_EVENTS),
  };
}

/**
 * Project exact persisted review information with bounded UI payloads.
 * Suppress raw subject content and file paths. Missing and stale review evidence
 * remains explicit instead of being converted into a successful review.
 */
export function projectWorkbenchReview(view: ReviewView, sessionID: string): WorkbenchReviewResult {
  const subject = view.subject;
  const claims = view.proof?.claims ?? [];
  const certificates = view.proof?.certificates ?? [];
  const certificateBinding = (id: string | null) => {
    if (id === null) return 'not_recorded';
    const current = certificates.some((certificate) =>
      certificate.certificateId === id && certificate.binding === 'current');
    return current ? 'current' : 'stale_or_unbound';
  };
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
        counterexampleCount: claim.counterexampleRefCount,
        certificateBinding: certificateBinding(claim.certificateId),
      })),
      claimsTruncated: claims.length > MAX_CLAIMS,
      coverageGapCount: view.proof?.coverageGaps.length ?? 0,
      certificateCount: view.proof?.certificates.length ?? 0,
    },
    reviewAttempts: view.reviewLinks?.attempts.length ?? 0,
    timeline: reviewTimeline(view),
    warningCodes: view.warnings.slice(0, MAX_WARNINGS).map((warning) => bounded(warning.code, 100)),
    warningsTruncated: view.warnings.length > MAX_WARNINGS,
    decisionAuthority: 'not_granted',
  });
}
