/**
 * @module evidence-review-report
 * @description Review decision and review report schemas: decision record,
 *              severity-graded report findings, draft, and final report.
 *
 * @version v1
 */

import { z } from 'zod';
import { REVIEW_REPORT_SCHEMA_ID } from './evidence-identifiers.js';
import {
  CheckId,
  ExternalReferenceSchema,
  InputOriginSchema,
  ReviewVerdict,
} from './evidence-primitives.js';
import { DecisionIdentity } from './evidence-identity.js';
import { Finding } from './evidence-findings.js';
import { FrozenReviewSubject } from './evidence-review-subject.js';
import { PeerReviewCoverage } from './peer-review.js';
import { ReviewReportSeverity } from './evidence-review.js';

// ─── Review Decision ──────────────────────────────────────────────────────────

/**
 * Human review decision at a User Gate (PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW).
 *
 * P30: `decisionIdentity` is the sole decision attribution authority. It carries
 * the full structured provenance (actor id, email, source, assurance) required
 * for audit and four-eyes proof; there is no separate identity string.
 */
export const ReviewDecision = z
  .object({
    verdict: ReviewVerdict,
    rationale: z.string(),
    decidedAt: z.string().datetime(),
    decisionIdentity: DecisionIdentity,
  })
  .strict()
  .readonly();
export type ReviewDecision = z.infer<typeof ReviewDecision>;

const MaterialReviewReportFinding = z
  .object({
    source: z.literal('material_finding'),
    reportSeverity: ReviewReportSeverity,
    finding: Finding,
  })
  .strict()
  .readonly();

const MechanicalReviewReportFinding = z
  .object({
    source: z.literal('mechanical'),
    reportSeverity: ReviewReportSeverity,
    category: z.string(),
    message: z.string(),
  })
  .strict()
  .readonly();

const MissingVerificationReviewReportFinding = z
  .object({
    source: z.literal('missing_verification'),
    reportSeverity: ReviewReportSeverity,
    category: z.string(),
    message: z.string(),
  })
  .strict()
  .readonly();

const ScopeCreepReviewReportFinding = z
  .object({
    source: z.literal('scope_creep'),
    reportSeverity: ReviewReportSeverity,
    category: z.string(),
    message: z.string(),
  })
  .strict()
  .readonly();

const UnknownReviewReportFinding = z
  .object({
    source: z.literal('unknown'),
    reportSeverity: ReviewReportSeverity,
    category: z.string(),
    message: z.string(),
  })
  .strict()
  .readonly();

const ChallengeReviewReportFinding = z
  .object({
    source: z.literal('challenge'),
    reportSeverity: ReviewReportSeverity,
    category: z.string(),
    message: z.string(),
    location: z.string().optional(),
  })
  .strict()
  .readonly();

export const ReviewReportFinding = z
  .discriminatedUnion('source', [
    MaterialReviewReportFinding,
    MechanicalReviewReportFinding,
    MissingVerificationReviewReportFinding,
    ScopeCreepReviewReportFinding,
    UnknownReviewReportFinding,
    ChallengeReviewReportFinding,
  ])
  .readonly();
export type ReviewReportFinding = z.infer<typeof ReviewReportFinding>;

const LifecycleReviewReportFinding = z
  .discriminatedUnion('source', [
    MechanicalReviewReportFinding,
    MissingVerificationReviewReportFinding,
    ScopeCreepReviewReportFinding,
    UnknownReviewReportFinding,
    ChallengeReviewReportFinding,
  ])
  .readonly();

const ReviewReportCommonBase = {
  schemaVersion: z.literal(REVIEW_REPORT_SCHEMA_ID),
  sessionId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  phase: z.string(),
  planDigest: z.string().nullable(),
  implDigest: z.string().nullable(),
  validationSummary: z.array(
    z.object({
      checkId: CheckId,
      passed: z.boolean(),
      detail: z.string(),
    }),
  ),
  overallStatus: z.enum(['clean', 'warnings', 'issues']),
  inputOrigin: InputOriginSchema.optional(),
  references: z.array(ExternalReferenceSchema).optional(),
};

const ReviewReportBase = {
  ...ReviewReportCommonBase,
  peerReviewCoverage: PeerReviewCoverage,
};

const LifecycleReviewReport = z
  .object({
    ...ReviewReportBase,
    reviewKind: z.literal('lifecycle_review'),
    findings: z.array(LifecycleReviewReportFinding),
  })
  .strict();

const ContentReviewReport = z
  .object({
    ...ReviewReportBase,
    reviewKind: z.literal('content_review'),
    reviewSubject: FrozenReviewSubject,
    findings: z.array(ReviewReportFinding),
  })
  .strict();

export const ReviewReportDraft = z
  .discriminatedUnion('reviewKind', [
    ContentReviewReport.omit({ peerReviewCoverage: true }),
    LifecycleReviewReport.omit({ peerReviewCoverage: true }),
  ])
  .readonly();
export type ReviewReportDraft = z.infer<typeof ReviewReportDraft>;

export const ReviewReport = z
  .discriminatedUnion('reviewKind', [ContentReviewReport, LifecycleReviewReport])
  .readonly();
export type ReviewReport = z.infer<typeof ReviewReport>;
