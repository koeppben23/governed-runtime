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

      // Track archiveStatus for consistency with regulated completion path.
      // Verify archive integrity and persist status on state.
      let archiveStatus: 'verified' | 'failed' = 'failed';
      try {
        const verification = await verifyArchive(fingerprint, context.sessionID);
        archiveStatus = verification.passed ? 'verified' : 'failed';
      } catch {
        // Verification failure is non-fatal for manual archive — status stays 'failed'.
      }
      const archivedState = { ...state, archiveStatus };
      await writeStateWithArtifacts(sessDir, archivedState);

      return appendNextAction(
        JSON.stringify({
          phase: state.phase,
          status: 'Session archived successfully.',
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
