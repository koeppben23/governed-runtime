/** Materialize the required development export and commit terminal evidence. */

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { archiveCompletionExport } from '../../adapters/workspace/archive.js';
import { verifyArchive } from '../../adapters/workspace/index.js';
import { readState } from '../../adapters/persistence.js';
import { executeExport } from '../../rails/export.js';
import type { RailResult } from '../../rails/types.js';
import type { ToolContext, ToolDefinition, ToolResult } from './helpers.js';
import { formatError } from './error-format.js';
import {
  createSessionCompletionAuditDeps,
  executeRegulatedCompletion,
} from '../services/regulated-completion.js';
import {
  formatBlocked,
  formatRailResult,
  withMutableSessionTransaction,
  writeStateWithArtifactsAndAuditOperations,
} from './helpers.js';

type CompletedExport = Readonly<{
  kind: 'completed';
  fingerprint: string;
  sessDir: string;
  result: Extract<RailResult, { kind: 'ok' }>;
}>;

type ExportOutcome = CompletedExport | Readonly<{ kind: 'blocked'; output: ToolResult }>;

async function materializeExport(context: ToolContext): Promise<ExportOutcome> {
  return withMutableSessionTransaction(
    context,
    async ({ fingerprint, sessDir, state, ctx }): Promise<ExportOutcome> => {
      if (state.phase !== 'EXPORT_READY') {
        return {
          kind: 'blocked',
          output: formatBlocked('COMMAND_NOT_ALLOWED', {
            command: '/export',
            phase: state.phase,
          }),
        };
      }
      const archivePath = await archiveCompletionExport(fingerprint, context.sessionID);
      const verification = await verifyArchive(fingerprint, context.sessionID);
      if (!verification.passed) {
        return {
          kind: 'blocked',
          output: formatBlocked('INTERNAL_ERROR', {
            reason:
              'Export materialization did not produce a verifiable package. The session remains EXPORT_READY.',
          }),
        };
      }
      const packageDigest = createHash('sha256')
        .update(await readFile(archivePath))
        .digest('hex');
      const evidence = {
        id: randomUUID(),
        packageDigest,
        purpose: 'auditor' as const,
        integrityCapability: 'verifiable' as const,
        createdAt: ctx.now(),
      };
      const result = executeExport(state, evidence, ctx);
      if (result.kind === 'blocked') {
        return { kind: 'blocked', output: formatRailResult(result) };
      }
      const persisted = await writeStateWithArtifactsAndAuditOperations(
        sessDir,
        {
          ...result.state,
          lastExportPackagePurpose: 'auditor' as const,
          lastExportIntegrityCapability: 'verifiable' as const,
          lastExportVerificationStatus: 'passed' as const,
        },
        result.transitions,
      );
      return {
        kind: 'completed',
        fingerprint,
        sessDir,
        result: { ...result, state: persisted },
      };
    },
  );
}

/**
 * Regulated completion (audit emit → regulated archive → verify) is part of the
 * export/completion path. It reconciles its own outbox and must run after the
 * transaction releases the session lock.
 */
async function completeRegulatedExport(
  settled: CompletedExport,
  sessionID: string,
): Promise<ToolResult> {
  const { fingerprint, sessDir, result } = settled;
  const auditDeps = createSessionCompletionAuditDeps({
    sessDir,
    sessionID,
    fingerprint,
    state: result.state,
  });
  try {
    const finalState = await executeRegulatedCompletion(
      sessDir,
      fingerprint,
      sessionID,
      result.state,
      auditDeps,
    );
    return formatRailResult({ ...result, state: finalState });
  } catch (err) {
    // Completion-lock contention is not a domain failure: the session is
    // already COMPLETE and a concurrent recovery owns the remaining chain.
    // Surface the durable state rather than a false failure.
    const fresh = await readState(sessDir);
    if (fresh?.phase === 'COMPLETE') return formatRailResult({ ...result, state: fresh });
    throw err;
  }
}

export const export_session: ToolDefinition = {
  description:
    'Materialize the required verifiable development export. Only available at EXPORT_READY; successful evidence persistence completes the workflow.',
  args: {},
  async execute(_args, context) {
    try {
      const settled = await materializeExport(context);
      if (settled.kind !== 'completed') return settled.output;
      if (settled.result.state.policySnapshot.mode !== 'regulated') {
        return formatRailResult(settled.result);
      }
      return await completeRegulatedExport(settled, context.sessionID);
    } catch (err) {
      return formatError(err);
    }
  },
};
