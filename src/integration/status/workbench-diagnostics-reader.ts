/** Read-only canonical Explorer + verified audit-chain projection for Desktop.
 * Never hydrates, repairs, writes audit, or treats a linked child as proven
 * before the canonical Explorer verified its lineage.
 */
import { stat } from 'node:fs/promises';
import { auditPath } from '../../adapters/persistence.js';
import { readAuditTrail } from '../../adapters/persistence-audit.js';
import { resolveSessionAuthority } from '../../adapters/session-authority.js';
import { verifyChain } from '../../audit/integrity.js';
import { buildExplorerView } from '../diagnostics/explorer-view.js';
import {
  projectWorkbenchDiagnostics,
  type WorkbenchAuditSnapshot,
  type WorkbenchDiagnosticsResult,
} from './workbench-diagnostics-projection.js';

const MAX_AUDIT_BYTES = 2 * 1024 * 1024;
const MAX_AUDIT_SESSIONS = 24;

async function verifiedAudit(root: string, sessionID: string): Promise<WorkbenchAuditSnapshot> {
  const fallback = (reasonCode: string): WorkbenchAuditSnapshot => ({
    sessionID,
    integrity: 'not_verified',
    reasonCode,
    events: [],
  });
  try {
    const authority = await resolveSessionAuthority({ root, sessionId: sessionID });
    if (authority.status !== 'resolved') return fallback('SESSION_STATE_NOT_VERIFIED');
    let bytes: number;
    try {
      bytes = (await stat(auditPath(authority.sessDir))).size;
    } catch {
      return fallback('AUDIT_UNAVAILABLE');
    }
    if (bytes > MAX_AUDIT_BYTES) return fallback('AUDIT_TOO_LARGE');
    const events = await readAuditTrail(authority.sessDir);
    if (events.length === 0) return fallback('AUDIT_EMPTY');
    const verification = verifyChain(events, {
      expectedFlowguardSessionId: authority.state.flowguardSessionId,
    });
    if (!verification.valid) {
      return { sessionID, integrity: 'invalid', reasonCode: verification.reason, events: [] };
    }
    return { sessionID, integrity: 'verified', reasonCode: null, events };
  } catch {
    // Broken envelopes or read failures cannot become positive audit evidence.
    return fallback('AUDIT_READ_OR_VERIFICATION_FAILED');
  }
}

/** Canonical ownership and lineage are established before any child audit read. */
export async function buildWorkbenchDiagnostics(request: {
  readonly root: string;
  readonly sessionID: string;
}): Promise<WorkbenchDiagnosticsResult> {
  const explorer = await buildExplorerView({
    root: request.root,
    sessionId: request.sessionID,
    maxSessions: MAX_AUDIT_SESSIONS,
  });
  const snapshots: WorkbenchAuditSnapshot[] = [];
  for (const session of explorer.sessions) {
    if (session.lineage !== 'verified' || session.binding !== 'verified') {
      snapshots.push({
        sessionID: session.sessionId,
        integrity: 'not_verified',
        reasonCode: 'SESSION_LINEAGE_OR_BINDING_NOT_VERIFIED',
        events: [],
      });
      continue;
    }
    snapshots.push(await verifiedAudit(request.root, session.sessionId));
  }
  return projectWorkbenchDiagnostics(explorer, snapshots);
}
