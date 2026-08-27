/**
 * @module integration/services/regulated-completion
 * @description P26 regulated archive lifecycle: audit emit → archive → verify.
 *
 * Scope: EVIDENCE_REVIEW + APPROVE → COMPLETE in regulated mode.
 * Fail-closed: any failure in the chain produces regulatedArchiveStatus: 'failed'.
 * No partial success can leak — the entire chain is atomic from the caller's perspective.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import { appendAuditEvent, readAuditTrail } from '../../adapters/persistence-audit.js';
import { archiveRegulatedEvidence } from '../../adapters/workspace/archive.js';
import { verifyRegulatedArchive } from '../../adapters/workspace/archive-verify-chain.js';
import { createLifecycleEvent } from '../../audit/types.js';
import { getLastChainHash } from '../../audit/integrity.js';
import { writeStateWithArtifacts } from '../tools/helpers.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import { serializeError } from '../../logging/error-serialize.js';
import { isTerminalPhase } from '../../machine/topology.js';

/**
 * Execute the P26 regulated completion chain: audit emit → archive → verify.
 *
 * Pre-conditions (caller must verify before calling):
 * - Rail result kind === 'ok'
 * - Pre-decision phase was EVIDENCE_REVIEW
 * - Verdict was 'approve'
 * - result.state.phase === 'COMPLETE'
 * - result.state.policySnapshot.mode === 'regulated'
 * - !result.state.error
 *
 * Fail-closed semantics:
 * - Writes regulatedArchiveStatus 'pending' before starting the chain.
 * - On any failure in the chain, returns state with regulatedArchiveStatus 'failed'.
 * - Only returns 'verified' when archive passes integrity check.
 *
 * @param sessDir - Session directory path
 * @param fingerprint - Workspace fingerprint
 * @param sessionID - Session identifier
 * @param resultState - The COMPLETE state from the rail
 * @returns Final state with regulatedArchiveStatus set
 */
export async function executeRegulatedCompletion(
  sessDir: string,
  fingerprint: string,
  sessionID: string,
  resultState: SessionState,
): Promise<SessionState> {
  if (!isTerminalPhase(resultState.phase) || resultState.error) {
    return {
      ...resultState,
      regulatedArchiveStatus: 'failed' as const,
      archiveStatus: 'failed' as const,
    };
  }
  const pendingState = {
    ...resultState,
    regulatedArchiveStatus: 'pending' as const,
    archiveStatus: 'pending' as const,
  };
  await writeStateWithArtifacts(sessDir, pendingState);

  getAdapterLogger().info('services', 'Starting regulated completion chain', {
    sessionID,
    fingerprint,
  });

  let finalState: SessionState;
  try {
    // 1. Emit session_completed audit event BEFORE archive.
    //    Reads the trail to get correct prevHash (independent of plugin cache).
    //    Failure here is fatal — no archive without terminal audit event.
    const { events } = await readAuditTrail(sessDir);
    const prevHash = getLastChainHash(events);
    const completionEvt = createLifecycleEvent({
      flowguardSessionId: resultState.flowguardSessionId,
      hostSessionId: sessionID,
      detail: { action: 'session_completed', finalPhase: 'COMPLETE' as const },
      occurredAt: new Date().toISOString(),
      actor: 'machine',
      prevHash,
      actorInfo: resultState.actorInfo,
    });
    await appendAuditEvent(sessDir, completionEvt);

    // 2. Archive session (synchronous, not fire-and-forget).
    await archiveRegulatedEvidence(fingerprint, sessionID);
    const createdState = {
      ...resultState,
      regulatedArchiveStatus: 'created' as const,
      archiveStatus: 'created' as const,
    };
    await writeStateWithArtifacts(sessDir, createdState);

    // 3. Verify archive integrity.
    const verification = await verifyRegulatedArchive(fingerprint, sessionID);
    finalState = {
      ...resultState,
      regulatedArchiveStatus: verification.passed ? ('verified' as const) : ('failed' as const),
      archiveStatus: verification.passed ? ('verified' as const) : ('failed' as const),
    };
    getAdapterLogger().info('services', 'Regulated completion chain finished', {
      sessionID,
      archiveStatus: finalState.regulatedArchiveStatus,
      archivePassed: verification.passed,
    });
  } catch (err) {
    getAdapterLogger().error('services', 'Regulated completion chain failed', {
      sessionID,
      fingerprint,
      error: serializeError(err),
    });
    finalState = {
      ...resultState,
      regulatedArchiveStatus: 'failed' as const,
      archiveStatus: 'failed' as const,
    };
  }

  return finalState;
}
