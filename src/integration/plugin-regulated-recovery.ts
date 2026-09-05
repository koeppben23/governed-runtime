/**
 * @module integration/plugin-regulated-recovery
 * @description Before-hook recovery for interrupted regulated completions.
 *
 * A durable COMPLETE checkpoint with an unfinished regulated archive is not a
 * completed governed session. This module resumes the completion chain before
 * subsequent tool side effects, using the plugin runtime's production audit
 * dependencies.
 *
 * Scope: recovery applies ONLY to the exact P26 ticket-flow completion
 * contract (EVIDENCE_REVIEW + APPROVE -> COMPLETE in regulated mode). Regulated
 * ARCH_COMPLETE and REVIEW_COMPLETE sessions belong to other flows and must
 * never be touched by the ticket-flow recovery chain.
 *
 * Lock discipline: the completion chain itself (state writes and audit
 * reconciliation) acquires the non-reentrant session write lock per step.
 * Recovery therefore performs only a tiny locked re-check here and runs the
 * resume OUTSIDE the lock — holding the lock across
 * `resumeRegulatedCompletion` would deadlock on the lock's own O_EXCL
 * acquisition inside every write and reconcile step.
 */

import { PersistenceError, readState } from '../adapters/persistence.js';
import { withSessionWriteLock } from '../adapters/persistence-lock.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import {
  isRegulatedTicketCompletion,
  resumeRegulatedCompletion,
} from './services/regulated-completion.js';

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
  if (!state || !isRegulatedTicketCompletion(state) || state.archiveStatus === 'verified') {
    return;
  }
  const fingerprint = await runtime.auditDeps.resolveFingerprint();
  if (!fingerprint) {
    throw new PersistenceError(
      'WRITE_FAILED',
      'Cannot resume regulated completion without a workspace fingerprint',
    );
  }
  // Re-check under the lock so a concurrent completion finishing in between
  // does not re-run the chain. The resume itself runs outside the lock.
  const needsResume = await withSessionWriteLock(sessDir, async () => {
    const fresh = await readState(sessDir);
    return (
      fresh !== null && isRegulatedTicketCompletion(fresh) && fresh.archiveStatus !== 'verified'
    );
  });
  if (!needsResume) return;
  await resumeRegulatedCompletion(sessDir, fingerprint, sessionId, runtime.auditDeps);
}
