/**
 * @module integration/tools/archive-tool
 * @description Archive tool — creates compressed session archive with integrity verification.
 *
 * Extracted from simple-tools.ts (P2b).
 *
 * @version v1
 */

import type { ToolDefinition } from './helpers.js';
import {
  resolveWorkspacePaths,
  formatBlocked,
  formatError,
  appendNextAction,
  writeStateWithArtifacts,
} from './helpers.js';
import { readState } from '../../adapters/persistence.js';
import { archiveSession, verifyArchive } from '../../adapters/workspace/index.js';
import { getAdapterLogger, getLogTraceFields } from '../../logging/adapter-logger.js';
import { evaluateArchivePreflight } from '../archive-preflight.js';

/**
 * Verify a freshly created archive and derive the reportable status. Isolated
 * from execute() so the tool's control flow stays within complexity limits.
 * Verification failure is non-fatal for a manual archive — status stays 'failed'.
 */
async function verifyArchiveIntegrity(
  fingerprint: string,
  sessionID: string,
): Promise<{ archiveStatus: 'verified' | 'failed'; status: string }> {
  try {
    const verification = await verifyArchive(fingerprint, sessionID);
    if (verification.passed) {
      return { archiveStatus: 'verified', status: 'Session archived and verified.' };
    }
    const errs = verification.findings.filter((f) => f.severity === 'error');
    const detail = errs.map((f) => f.code).join(', ') || 'integrity verification failed';
    return {
      archiveStatus: 'failed',
      status: `Session archived, but integrity verification failed: ${detail}.`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      archiveStatus: 'failed',
      status: `Session archived, but integrity verification failed: ${detail}.`,
    };
  }
}

export const archive: ToolDefinition = {
  description:
    'Archive a completed FlowGuard session as a tar.gz file. ' +
    "Creates a compressed archive in the workspace's sessions/archive/ directory. " +
    'Only works on terminal sessions (COMPLETE, ARCH_COMPLETE, REVIEW_COMPLETE). ' +
    'Uses system tar (available on Windows 10+, macOS, Linux).',
  args: {},
  async execute(_args, context) {
    try {
      const { fingerprint, sessDir } = await resolveWorkspacePaths(context);
      const state = await readState(sessDir);

      if (!state) return formatBlocked('NO_SESSION');
      const preflight = evaluateArchivePreflight(state);
      if (preflight.status !== 'available') {
        if (preflight.reasonCode === 'TERMINAL_PHASE_REQUIRED') {
          return formatBlocked('COMMAND_NOT_ALLOWED', {
            command: '/archive',
            phase: state.phase,
          });
        }
        return formatBlocked('ABORTED', { reason: state.error?.message ?? '' });
      }

      const archivePath = await archiveSession(fingerprint, context.sessionID);

      // Verify archive integrity and persist status. /export is an explicit
      // request for a verifiable audit package, so a concrete verified/failed
      // status is appropriate here (regardless of policy mode). With the
      // idempotent artifact-binding (see archive.ts), a re-archive of an
      // already-archived session no longer perturbs the audit-trail anchor, so a
      // freshly created valid archive verifies as 'verified' rather than racing
      // to 'failed'.
      const { archiveStatus, status } = await verifyArchiveIntegrity(
        fingerprint,
        context.sessionID,
      );
      const archivedState = { ...state, archiveStatus };
      await writeStateWithArtifacts(sessDir, archivedState);
      getAdapterLogger().info('machine', 'session_archived', {
        sessionId: context.sessionID,
        phase: archivedState.phase,
        archiveStatus,
        ...getLogTraceFields(),
      });

      return appendNextAction(
        JSON.stringify({
          phase: state.phase,
          status,
          archivePath,
          archiveStatus,
        }),
        archivedState,
      );
    } catch (err) {
      return formatError(err);
    }
  },
};
