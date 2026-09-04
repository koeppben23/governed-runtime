/**
 * @module integration/plugin-regulated-recovery
 * @description Before-hook recovery for interrupted regulated completions.
 *
 * A durable COMPLETE checkpoint with an unfinished regulated archive is not a
 * completed governed session. This module resumes the completion chain before
 * every subsequent tool side effect, using the plugin runtime's production
 * audit dependencies.
 */

import { PersistenceError, readState } from '../adapters/persistence.js';
import { withSessionWriteLock } from '../adapters/persistence-lock.js';
import { isTerminalPhase } from '../machine/topology.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import { resumeRegulatedCompletion } from './services/regulated-completion.js';

export async function recoverRegulatedCompletion(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
): Promise<void> {
  const sessDir = runtime.ws.getSessionDir(sessionId);
  if (!sessDir) return;
  // The enforcement gates that follow own the canonical fail-closed error
  // surface for unreadable state. Recovery must not shadow their errors: when
  // the precondition cannot be established, recovery has nothing to resume.
  let state;
  try {
    state = await readState(sessDir);
  } catch (err) {
    runtime.log.warn('enforcement', 'Skipping regulated completion recovery: state unreadable', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (
    !state ||
    !isTerminalPhase(state.phase) ||
    state.policySnapshot.mode !== 'regulated' ||
    state.archiveStatus === 'verified'
  ) {
    return;
  }
  await withSessionWriteLock(sessDir, async () => {
    const fingerprint = await runtime.auditDeps.resolveFingerprint();
    if (!fingerprint) {
      throw new PersistenceError(
        'WRITE_FAILED',
        'Cannot resume regulated completion without a workspace fingerprint',
      );
    }
    await resumeRegulatedCompletion(sessDir, fingerprint, sessionId, runtime.auditDeps);
  });
}
