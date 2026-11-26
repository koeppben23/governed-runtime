/**
 * @module integration/diagnostics/types
 * @description Read-only diagnostic view contracts.
 *
 * These views are presentation projections over existing authorities. They are
 * never persisted, never evidence and never an authorization source.
 */

import type { DiagnosticWarning } from '../../adapters/diagnostics/export-schema.js';
import type { LogLevel } from '../../logging/log-level.js';
import type { ProofApprovalProjection } from '../proofgraph/approval-projection.js';

export type DiagnosticViewStatus = 'COMPLETE' | 'PARTIAL' | 'NOT_VERIFIED';

export type ExplorerSessionRole = 'root' | 'reviewer' | 'continuation' | 'unknown';
export type ExplorerSessionState = 'captured' | 'absent' | 'unavailable';

export interface ExplorerSessionNode {
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly generation: number;
  readonly role: ExplorerSessionRole;
  readonly discoveredBy: readonly string[];
  readonly state: ExplorerSessionState;
  readonly lineage: 'verified' | 'not_verified';
  readonly phase: string | null;
  readonly binding: 'verified' | 'mismatch' | 'unknown';
  readonly warningCodes: readonly string[];
}

export interface ExplorerReviewLink {
  readonly obligationId: string;
  readonly obligationType: string;
  readonly status: string;
  readonly iteration: number;
  readonly reviewCycle: number | null;
  readonly planVersion: number | null;
  readonly subjectDigest: string;
  readonly invocationId: string | null;
  readonly blockedCode: string | null;
  readonly fulfilledAt: string | null;
  readonly consumedAt: string | null;
}

export interface ExplorerAttemptLink {
  readonly attemptId: string;
  readonly obligationId: string;
  readonly status: string;
  readonly ordinal: number;
  readonly childSessionId: string | null;
  readonly subjectDigest: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface ExplorerDispatchLink {
  readonly dispatchId: string;
  readonly attemptId: string;
  readonly obligationId: string;
  readonly hostCallId: string;
  readonly dispatchStatus: string;
  readonly dispatchAuthorizedAt: string;
  readonly completedAt: string | null;
}

export interface ExplorerInvocationLink {
  readonly invocationId: string;
  readonly obligationId: string;
  readonly attemptId: string;
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly capturedVerdict: string | null;
  readonly invokedAt: string;
  readonly fulfilledAt: string | null;
}

export interface ExplorerReviewLinks {
  readonly obligations: readonly ExplorerReviewLink[];
  readonly attempts: readonly ExplorerAttemptLink[];
  readonly dispatches: readonly ExplorerDispatchLink[];
  readonly invocations: readonly ExplorerInvocationLink[];
  readonly truncated: boolean;
}

export interface ExplorerView {
  readonly schemaVersion: 'diagnostic-view.v1';
  readonly kind: 'explorer';
  readonly rootSessionId: string;
  readonly generatedAt: string;
  readonly status: DiagnosticViewStatus;
  readonly completeness: Readonly<{
    lineage: 'complete' | 'partial' | 'not_verified';
    canonicalState: 'complete' | 'partial' | 'not_verified';
  }>;
  readonly sessions: readonly ExplorerSessionNode[];
  readonly reviewLinks: ExplorerReviewLinks | null;
  readonly warnings: readonly DiagnosticWarning[];
}

export type ReviewSubjectKind =
  'plan' | 'architecture' | 'implementation' | 'content' | 'unavailable';

export interface ReviewFindingView {
  readonly severity: string;
  readonly category: string;
  readonly message: string;
  readonly findingId: string | null;
}

export interface HistoricalImplReviewView {
  readonly verdict: string;
  readonly executedAt: string;
  readonly iteration: number;
  readonly currDigest: string;
  readonly expectedDigest: string;
  readonly reason: 'digest_mismatch';
}

export interface UnboundReviewView {
  readonly verdict: string | null;
  readonly reviewedAt: string | null;
  readonly findingsVersion: string | null;
  readonly findings: readonly ReviewFindingView[];
  readonly findingsTruncated: boolean;
  readonly missingVerification: readonly string[];
  readonly scopeCreep: readonly string[];
  readonly unknowns: readonly string[];
  readonly reason: 'stale_revision' | 'subject_mismatch' | 'subject_not_verified';
}

export interface ReviewSubjectView {
  readonly kind: ReviewSubjectKind;
  readonly label: string;
  readonly revision: string | null;
  readonly digest: string | null;
  readonly materialDigest: string | null;
  readonly content: string | null;
  readonly contentBytes: number;
  readonly contentTruncated: boolean;
  readonly contentVerified: 'verified' | 'mismatch' | 'not_available' | 'not_applicable';
  readonly paths: readonly string[];
  readonly reviewCompletion: string | null;
  readonly reviewerVerdict: string | null;
  readonly reviewedAt: string | null;
  readonly reviewedObligationId: string | null;
  readonly reviewedSubjectDigest: string | null;
  readonly subjectBinding: 'matched' | 'mismatch' | 'not_verified' | 'not_applicable';
  readonly findingsVersion: string | null;
  readonly findings: readonly ReviewFindingView[];
  readonly findingsTruncated: boolean;
  readonly missingVerification: readonly string[];
  readonly scopeCreep: readonly string[];
  readonly unknowns: readonly string[];
  /**
   * Reviewer output that is not bound to the displayed revision. It is shown
   * separately and never used as the current verdict.
   */
  readonly unboundReview: UnboundReviewView | null;
  /**
   * The implementation-review loop result when it is bound to a different
   * implementation digest. It is historical only and never the current verdict.
   */
  readonly historicalImplReview: HistoricalImplReviewView | null;
}

export interface ReviewView {
  readonly schemaVersion: 'diagnostic-view.v1';
  readonly kind: 'review';
  readonly rootSessionId: string;
  readonly generatedAt: string;
  readonly status: DiagnosticViewStatus;
  readonly phase: string | null;
  readonly subject: ReviewSubjectView;
  readonly reviewLinks: ExplorerReviewLinks | null;
  readonly proof: ProofApprovalProjection | null;
  readonly decisionAuthority: 'not_granted';
  readonly warnings: readonly DiagnosticWarning[];
}

export type LogViewLevel = Exclude<LogLevel, 'silent'>;

export interface LogViewFilter {
  readonly levels: readonly LogViewLevel[];
  readonly sessionId: string | null;
  readonly traceId: string | null;
  readonly since: string | null;
  readonly until: string | null;
}

export interface LogEntryView {
  readonly ts: string;
  readonly level: LogViewLevel;
  readonly service: string;
  readonly sessionId: string | null;
  readonly traceId: string | null;
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>> | null;
}

export interface LogFileView {
  readonly file: string;
  readonly fileBytes: number;
  readonly bytesRead: number;
  readonly tailOnly: boolean;
  readonly modifiedAt: string;
}

export interface LogView {
  readonly schemaVersion: 'diagnostic-view.v1';
  readonly kind: 'logs';
  readonly generatedAt: string;
  readonly status: DiagnosticViewStatus;
  readonly directory: string | null;
  readonly entries: readonly LogEntryView[];
  readonly files: readonly LogFileView[];
  readonly filter: LogViewFilter;
  readonly bytesRead: number;
  readonly maxBytes: number;
  readonly maxLines: number;
  readonly filesSkipped: number;
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
  readonly parseErrors: number;
  readonly correlation: Readonly<{
    withSessionId: number;
    withoutSessionId: number;
    withTraceId: number;
    withoutTraceId: number;
    missingFilteredSessionId: number;
    missingFilteredTraceId: number;
  }>;
  readonly note: string;
}

export interface NotificationView {
  readonly schemaVersion: 'diagnostic-view.v1';
  readonly kind: 'notifications';
  readonly generatedAt: string;
  readonly status: 'NOT_VERIFIED';
  readonly delivery: 'unsupported';
  readonly reason: string;
  readonly fallback: Readonly<{
    kind: 'file-logs';
    directory: string | null;
    note: string;
  }>;
  readonly constraints: readonly string[];
}
