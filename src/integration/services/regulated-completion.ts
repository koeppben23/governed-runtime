/**
 * @module integration/services/regulated-completion
 * @description P26 regulated archive lifecycle: audit emit → archive → verify.
 *
 * Scope: EVIDENCE_REVIEW + APPROVE → COMPLETE in regulated mode.
 * Fail-closed: any failure in the chain produces archiveStatus: 'failed'.
 * No partial success can leak — the entire chain is atomic from the caller's perspective.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import { readAuditTrail, appendAuditEvent } from '../../adapters/persistence.js';
import { archiveSession, verifyArchive } from '../../adapters/workspace/index.js';
import { createLifecycleEvent } from '../../audit/types.js';
import { getLastChainHash } from '../../audit/integrity.js';
import { writeStateWithArtifacts } from '../tools/helpers.js';

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
 * - Writes archiveStatus 'pending' before starting the chain.
 * - On any failure in the chain, returns state with archiveStatus 'failed'.
 * - Only returns 'verified' when archive passes integrity check.
 *
 * @param sessDir - Session directory path
 * @param fingerprint - Workspace fingerprint
 * @param sessionID - Session identifier
 * @param resultState - The COMPLETE state from the rail
 * @returns Final state with archiveStatus set
 */
export async function executeRegulatedCompletion(
  sessDir: string,
  fingerprint: string,
  sessionID: string,
  resultState: SessionState,
): Promise<SessionState> {
  const pendingState = { ...resultState, archiveStatus: 'pending' as const };
  await writeStateWithArtifacts(sessDir, pendingState);

  let finalState: SessionState;
  try {
    // 1. Emit session_completed audit event BEFORE archive.
    //    Reads the trail to get correct prevHash (independent of plugin cache).
    //    Failure here is fatal — no archive without terminal audit event.
    const { events } = await readAuditTrail(sessDir);
    const prevHash = getLastChainHash(events as unknown as Array<Record<string, unknown>>);
    const completionEvt = createLifecycleEvent(
      sessionID,
      { action: 'session_completed', finalPhase: 'COMPLETE' as const },
      new Date().toISOString(),
      'machine',
      prevHash,
      resultState.actorInfo,
    );
    await appendAuditEvent(sessDir, completionEvt);

    // 2. Archive session (synchronous, not fire-and-forget).
    await archiveSession(fingerprint, sessionID);
    const createdState = { ...resultState, archiveStatus: 'created' as const };
    await writeStateWithArtifacts(sessDir, createdState);

    // 3. Verify archive integrity.
    const verification = await verifyArchive(fingerprint, sessionID);
    finalState = {
      ...resultState,
      archiveStatus: verification.passed ? ('verified' as const) : ('failed' as const),
    };
  } catch {
    finalState = { ...resultState, archiveStatus: 'failed' as const };
  }

  return finalState;
}
