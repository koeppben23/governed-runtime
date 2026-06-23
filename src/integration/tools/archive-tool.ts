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
import { TERMINAL } from '../../machine/topology.js';
import { archiveSession, verifyArchive } from '../../adapters/workspace/index.js';
import { getAdapterLogger, getLogTraceFields } from '../../logging/adapter-logger.js';

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

      if (!state) {
        return formatBlocked('NO_SESSION');
      }

      if (!TERMINAL.has(state.phase)) {
        return formatBlocked('COMMAND_NOT_ALLOWED', {
          command: '/archive',
          phase: state.phase,
        });
      }

      const archivePath = await archiveSession(fingerprint, context.sessionID);

      // Verify archive integrity and persist status. /export is an explicit
      // request for a verifiable audit package, so a concrete verified/failed
      // status is appropriate here (regardless of policy mode). With the
      // idempotent artifact-binding (see archive.ts), a re-archive of an
      // already-archived session no longer perturbs the audit-trail anchor, so a
      // freshly created valid archive verifies as 'verified' rather than racing
      // to 'failed'.
      let archiveStatus: 'verified' | 'failed' = 'failed';
      let verifyError: string | null = null;
      try {
        const verification = await verifyArchive(fingerprint, context.sessionID);
        archiveStatus = verification.passed ? 'verified' : 'failed';
        if (!verification.passed) {
          const errs = verification.findings.filter((f) => f.severity === 'error');
          verifyError = errs.map((f) => f.code).join(', ') || 'integrity verification failed';
        }
      } catch (err) {
        // Verification failure is non-fatal for manual archive — status stays 'failed'.
        verifyError = err instanceof Error ? err.message : String(err);
      }
      const archivedState = { ...state, archiveStatus };
      await writeStateWithArtifacts(sessDir, archivedState);
      getAdapterLogger().info('machine', 'session_archived', {
        sessionId: context.sessionID,
        phase: archivedState.phase,
        archiveStatus,
        ...getLogTraceFields(),
      });

      // Keep the status string consistent with archiveStatus — never report
      // success alongside a failed verification (#archive-payload-mismatch).
      const status =
        archiveStatus === 'verified'
          ? 'Session archived and verified.'
          : `Session archived, but integrity verification failed${verifyError ? `: ${verifyError}` : ''}.`;

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
