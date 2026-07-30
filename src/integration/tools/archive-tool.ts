/**
 * @module integration/tools/archive-tool
 * @description Archive tool — creates compressed session archive with redaction support.
 *
 * Two mandatory parameters control every export:
 *   redactionMode — 'none' (raw), 'basic' ([REDACTED]), 'pseudonymous' (stable tokens)
 *   includeRaw   — whether raw unredacted files are included alongside redacted copies
 *
 * Config constraints (flowguard.json):
 *   archive.redaction.allowedModes  — which modes are permitted
 *   archive.redaction.allowRawExport — whether includeRaw=true is allowed
 *   archive.redaction.maxAuditEvents — max audit events for redaction processing
 *
 * @version v3
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
import { readConfig } from '../../adapters/persistence-config.js';
import { archiveSession } from '../../adapters/workspace/index.js';
import { getAdapterLogger, getLogTraceFields } from '../../logging/adapter-logger.js';
import { evaluateArchivePreflight } from '../archive-preflight.js';
import { z } from 'zod';

function buildArchiveGuidance(
  redactionMode: string,
  includeRaw: boolean,
  allowRawExport: boolean,
): string {
  const modeDesc =
    redactionMode === 'none'
      ? 'raw evidence (no redaction)'
      : redactionMode === 'basic'
        ? 'secrets masked as [REDACTED]'
        : 'stable pseudonymous correlation tokens';
  const rawDesc = includeRaw ? 'raw evidence included' : 'raw evidence excluded';

  if (includeRaw) {
    return `Archive with ${rawDesc} and redaction mode ${redactionMode} (${modeDesc}). Handle as confidential${redactionMode !== 'none' ? ' — redacted copies also included for sharing' : ''}.`;
  }

  return allowRawExport
    ? `Redacted archive (${redactionMode}, ${rawDesc}). Safe to share. For a raw-evidence package for auditors, run: /archive redactionMode=none includeRaw=true`
    : `Redacted archive (${redactionMode}, ${rawDesc}). Safe to share. Raw export is not enabled in config (allowRawExport=false).`;
}

async function verifyArchiveIntegrity(
  fingerprint: string,
  sessionID: string,
): Promise<{ archiveStatus: 'verified' | 'failed'; status: string }> {
  try {
    const { verifyArchive } = await import('../../adapters/workspace/index.js');
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
    'Archive a completed FlowGuard session as a tar.gz file with configurable redaction. ' +
    'redactionMode: none (raw evidence for auditors), basic (secrets masked), pseudonymous (stable correlation tokens). ' +
    'includeRaw: true to include raw files alongside redacted copies, false for share-safe archive.',
  args: {
    redactionMode: z
      .enum(['none', 'basic', 'pseudonymous'])
      .default('basic')
      .describe(
        "'none' = raw evidence (requires allowRawExport in config). " +
          "'basic' = secrets masked as [REDACTED]. " +
          "'pseudonymous' = stable correlation tokens.",
      ),
    includeRaw: z
      .boolean()
      .default(false)
      .describe(
        'Include raw unredacted files alongside redacted copies. ' +
          'Requires allowRawExport=true in flowguard.json. ' +
          'Set false to produce a share-safe archive.',
      ),
  },
  async execute(args, context) {
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

      const redactionMode = (args.redactionMode ?? 'basic') as 'none' | 'basic' | 'pseudonymous';
      const includeRaw = (args.includeRaw ?? false) as boolean;

      const archivePath = await archiveSession(fingerprint, context.sessionID, {
        redactionMode,
        includeRaw,
      });

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
        redactionMode,
        includeRaw,
        ...getLogTraceFields(),
      });

      const config = await readConfig();
      const guidance = buildArchiveGuidance(
        redactionMode,
        includeRaw,
        config.archive.redaction?.allowRawExport ?? false,
      );

      return appendNextAction(
        JSON.stringify({
          phase: state.phase,
          status,
          archivePath,
          archiveStatus,
          redactionMode,
          includeRaw,
          guidance,
        }),
        archivedState,
      );
    } catch (err) {
      return formatError(err);
    }
  },
};
