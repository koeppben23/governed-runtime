/** Bounded, read-only Desktop Session Explorer and verified audit projection.
 * The projection is informational, never decision authority or audit evidence.
 */
import { z } from 'zod';
import type { AuditEvent } from '../../state/evidence-audit.js';
import type { ExplorerView } from '../diagnostics/types.js';

export const WorkbenchDiagnosticsRequest = z.object({ sessionID: z.string().min(1) }).strict();

const WorkbenchSession = z
  .object({
    sessionID: z.string(),
    parentSessionID: z.string().nullable(),
    role: z.string(),
    state: z.string(),
    lineage: z.enum(['verified', 'not_verified']),
    phase: z.string().nullable(),
    binding: z.string(),
    warningCodes: z.array(z.string()),
  })
  .strict();

const WorkbenchReviewAttempt = z
  .object({
    ordinal: z.number().int().nonnegative(),
    childSessionID: z.string().nullable(),
    status: z.string(),
    dispatchStatus: z.string(),
    obligationStatus: z.string(),
  })
  .strict();

const WorkbenchAuditEvent = z
  .object({
    sessionID: z.string(),
    sequence: z.number().int().positive(),
    at: z.string(),
    recordedAt: z.string(),
    phase: z.string(),
    event: z.string(),
  })
  .strict();

const WorkbenchAuditSession = z
  .object({
    sessionID: z.string(),
    integrity: z.enum(['verified', 'invalid', 'not_verified']),
    eventCount: z.number().int().nonnegative(),
    reasonCode: z.string().nullable(),
  })
  .strict();

export const WorkbenchDiagnosticsResult = z
  .object({
    schemaVersion: z.literal('workbench-diagnostics.v1'),
    sessionID: z.string(),
    explorer: z
      .object({
        status: z.enum(['COMPLETE', 'PARTIAL', 'NOT_VERIFIED']),
        lineage: z.enum(['complete', 'partial', 'not_verified']),
        canonicalState: z.enum(['complete', 'partial', 'not_verified']),
        sessions: z.array(WorkbenchSession),
        sessionsTruncated: z.boolean(),
        reviewAttempts: z.array(WorkbenchReviewAttempt),
        reviewAttemptsTruncated: z.boolean(),
        warningCodes: z.array(z.string()),
      })
      .strict(),
    audit: z
      .object({
        status: z.enum(['COMPLETE', 'PARTIAL', 'NOT_VERIFIED']),
        source: z.literal('verified_audit_chain_v3'),
        totalEvents: z.number().int().nonnegative(),
        eventsTruncated: z.boolean(),
        events: z.array(WorkbenchAuditEvent),
        sessions: z.array(WorkbenchAuditSession),
        note: z.literal(
          'Audit chronology is navigational; verified chains do not establish cross-session causality.',
        ),
      })
      .strict(),
    decisionAuthority: z.literal('not_granted'),
  })
  .strict();
export type WorkbenchDiagnosticsResult = z.infer<typeof WorkbenchDiagnosticsResult>;

export type WorkbenchAuditSnapshot = {
  readonly sessionID: string;
  readonly integrity: 'verified' | 'invalid' | 'not_verified';
  readonly reasonCode: string | null;
  readonly events: readonly AuditEvent[];
};

const MAX_SESSIONS = 24;
const MAX_ATTEMPTS = 24;
const MAX_EVENTS = 100;

function safeToken(value: string): string {
  return /^[a-zA-Z0-9:_-]{1,80}$/.test(value) ? value : 'REDACTED';
}

function projectSessions(view: ExplorerView) {
  return view.sessions.slice(0, MAX_SESSIONS).map((item) => ({
    sessionID: item.sessionId,
    parentSessionID: item.parentSessionId,
    role: safeToken(item.role),
    state: safeToken(item.state),
    lineage: item.lineage,
    phase: item.phase === null ? null : safeToken(item.phase),
    binding: safeToken(item.binding),
    warningCodes: item.warningCodes.slice(0, 12).map(safeToken),
  }));
}

function projectAttempts(view: ExplorerView) {
  const links = view.reviewLinks;
  if (!links) return [];
  return links.attempts.slice(-MAX_ATTEMPTS).map((item) => ({
    ordinal: item.ordinal,
    childSessionID: item.childSessionId,
    status: safeToken(item.status),
    dispatchStatus: safeToken(
      links.dispatches.find((dispatch) => dispatch.attemptId === item.attemptId)?.dispatchStatus ??
        'not_recorded',
    ),
    obligationStatus: safeToken(
      links.obligations.find(
        (obligation) => obligation.obligationId === item.obligationId,
      )?.status ?? 'not_recorded',
    ),
  }));
}

function projectAudit(snapshots: readonly WorkbenchAuditSnapshot[], explorer: ExplorerView) {
  const sessions = snapshots.map((snapshot) => ({
    sessionID: snapshot.sessionID,
    integrity: snapshot.integrity,
    eventCount: snapshot.events.length,
    reasonCode: snapshot.reasonCode,
  }));
  const all = snapshots.flatMap((snapshot) =>
    snapshot.integrity !== 'verified'
      ? []
      : snapshot.events.map((item) => ({
          sessionID: snapshot.sessionID,
          sequence: item.auditSequence,
          at: item.occurredAt,
          recordedAt: item.recordedAt,
          phase: safeToken(item.phase),
          event: safeToken(item.event),
        })),
  );
  all.sort(
    (a, b) =>
      a.at.localeCompare(b.at) ||
      a.sessionID.localeCompare(b.sessionID) ||
      a.sequence - b.sequence,
  );
  const anyVerified = sessions.some((session) => session.integrity === 'verified');
  const complete =
    explorer.status !== 'PARTIAL' &&
    explorer.status !== 'NOT_VERIFIED' &&
    all.length <= MAX_EVENTS &&
    sessions.length === explorer.sessions.length &&
    sessions.every((session) => session.integrity === 'verified');
  return {
    status: complete ? 'COMPLETE' : anyVerified ? 'PARTIAL' : 'NOT_VERIFIED',
    source: 'verified_audit_chain_v3' as const,
    totalEvents: all.length,
    eventsTruncated: all.length > MAX_EVENTS,
    events: all.slice(-MAX_EVENTS),
    sessions,
    note:
      'Audit chronology is navigational; verified chains do not establish cross-session causality.' as const,
  };
}

/** No cross-session linkage is inferred from audit timestamps. */
export function projectWorkbenchDiagnostics(
  view: ExplorerView,
  snapshots: readonly WorkbenchAuditSnapshot[],
): WorkbenchDiagnosticsResult {
  const attempts = view.reviewLinks?.attempts ?? [];
  return WorkbenchDiagnosticsResult.parse({
    schemaVersion: 'workbench-diagnostics.v1',
    sessionID: view.rootSessionId,
    explorer: {
      status: view.status,
      lineage: view.completeness.lineage,
      canonicalState: view.completeness.canonicalState,
      sessions: projectSessions(view),
      sessionsTruncated: view.sessions.length > MAX_SESSIONS,
      reviewAttempts: projectAttempts(view),
      reviewAttemptsTruncated:
        Boolean(view.reviewLinks?.truncated) || attempts.length > MAX_ATTEMPTS,
      warningCodes: view.warnings.slice(0, 20).map((item) => safeToken(item.code)),
    },
    audit: projectAudit(snapshots, view),
    decisionAuthority: 'not_granted',
  });
}
